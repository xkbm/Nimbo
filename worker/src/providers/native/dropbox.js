import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
import { decryptJson } from '../../crypto.js';
import { apiFetch } from './http.js';

const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';
const SIMPLE_UPLOAD_LIMIT = 149 * 1024 * 1024;
const SESSION_CHUNK_SIZE = 8 * 1024 * 1024;

const MIME_TYPES = {
	txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', json: 'application/json',
	pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
	mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
	doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMimeType(fileName = '') {
	const ext = String(fileName).split('.').pop()?.toLowerCase();
	return MIME_TYPES[ext] || 'application/octet-stream';
}

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const prefixed = input.startsWith('/') ? input : `/${input}`;
	return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function joinDropboxPath(parentPath = '/', name = '') {
	const normalizedParent = parentPath === '/' ? '' : parentPath.replace(/\/+$/g, '');
	return `${normalizedParent}/${name}`;
}

function toVirtualPath(dropboxPath = '') {
	if (!dropboxPath || dropboxPath === '/') return '/';
	const withSlashes = dropboxPath.startsWith('/') ? dropboxPath : `/${dropboxPath}`;
	const parent = withSlashes.slice(0, withSlashes.lastIndexOf('/') + 1);
	return normalizePath(parent || '/');
}

function parseDropboxError(payload, fallback) {
	if (!payload) return fallback;
	if (typeof payload === 'string') return payload;
	return payload.error_summary || payload.error?.['.tag'] || payload.message || fallback;
}

async function parseContentError(response, fallback) {
	const raw = await response.text().catch(() => '');
	if (!raw) return fallback;
	try { return parseDropboxError(JSON.parse(raw), fallback); } catch { return raw; }
}

function progressStream(stream, onProgress) {
	if (typeof onProgress !== 'function') return stream;
	let loaded = 0;
	return stream.pipe(new Transform({
		transform(chunk, _enc, callback) {
			loaded += chunk.length;
			try { onProgress(loaded); } catch { /* progress must never break the upload */ }
			callback(null, chunk);
		},
	}));
}

function readChunk(stream, length) {
	return new Promise((resolve, reject) => {
		const pieces = [];
		let got = 0;
		const done = (value) => {
			stream.off('data', onData);
			stream.off('end', onEnd);
			stream.off('error', onError);
			resolve(value);
		};
		function onData(chunk) {
			pieces.push(chunk);
			got += chunk.length;
			if (got >= length) {
				const last = pieces[pieces.length - 1];
				const extra = got - length;
				pieces[pieces.length - 1] = extra > 0 ? last.subarray(0, last.length - extra) : last;
				if (extra > 0) stream.unshift(last.subarray(last.length - extra));
				done(Buffer.concat(pieces));
			}
		}
		function onEnd() { done(got > 0 ? Buffer.concat(pieces) : null); }
		function onError(error) { done(null); reject(error); }
		stream.on('data', onData);
		stream.on('end', onEnd);
		stream.on('error', onError);
	});
}

export function create(env, account) {
	let accessTokenCache = null;

	function readCredentials() {
		const credentials = decryptJson(account.encrypted_credentials, env.ENCRYPTION_KEY);
		if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) throw new Error('Dropbox account credentials are incomplete');
		return credentials;
	}

	async function createAccessToken(forceRefresh = false) {
		if (!forceRefresh && accessTokenCache && accessTokenCache.expiresAt > Date.now() + 30_000) return accessTokenCache.token;
		const credentials = readCredentials();
		const response = await apiFetch('https://api.dropboxapi.com/oauth2/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }),
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok) throw new Error(parseDropboxError(payload, 'Failed to refresh Dropbox access token'));
		accessTokenCache = { token: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 14400) * 1000 };
		return accessTokenCache.token;
	}

	async function requestWithReauth(makeRequest) {
		let accessToken = await createAccessToken();
		try {
			return await makeRequest(accessToken);
		} catch (error) {
			if (error?.status !== 401) throw error;
			accessToken = await createAccessToken(true);
			return makeRequest(accessToken);
		}
	}

	async function rpc(path, body = {}) {
		return requestWithReauth(async (accessToken) => {
			const response = await apiFetch(`${API_BASE}${path}`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok) {
				throw Object.assign(new Error(parseDropboxError(payload, 'Dropbox API request failed')), { status: response.status });
			}
			return payload;
		});
	}

	async function content(path, { args, body, contentType = 'application/octet-stream' } = {}) {
		return requestWithReauth(async (accessToken) => {
			const response = await apiFetch(`${CONTENT_BASE}${path}`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${accessToken}`, 'Dropbox-API-Arg': JSON.stringify(args), ...(contentType ? { 'Content-Type': contentType } : {}) },
				...(body ? { body, duplex: 'half' } : {}),
			});
			if (!response.ok && response.status === 401) {
				throw Object.assign(new Error('Dropbox content request unauthorized'), { status: 401 });
			}
			return response;
		});
	}

	async function listFolder(path = '', recursive = true) {
		const entries = [];
		let payload = await rpc('/files/list_folder', { path, recursive, include_deleted: false, include_has_explicit_shared_members: false, include_mounted_folders: true, include_non_downloadable_files: true });
		entries.push(...(payload.entries || []));
		while (payload.has_more) {
			payload = await rpc('/files/list_folder/continue', { cursor: payload.cursor });
			entries.push(...(payload.entries || []));
		}
		return entries;
	}

	async function ensureRemotePath(virtualPath = '/') {
		const normalizedPath = normalizePath(virtualPath);
		if (normalizedPath === '/') return '';
		const segments = normalizedPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
		let currentPath = '';
		for (const segment of segments) {
			currentPath = joinDropboxPath(currentPath || '/', segment);
			try {
				await rpc('/files/get_metadata', { path: currentPath });
			} catch (error) {
				if (!/not_found/.test(error?.message || '')) throw error;
				await rpc('/files/create_folder_v2', { path: currentPath, autorename: false });
			}
		}
		return currentPath;
	}

	async function fetchStructure() {
		const entries = await listFolder('', true);
		return entries.filter((entry) => entry['.tag'] === 'file' || entry['.tag'] === 'folder').map((entry) => {
			const isFolder = entry['.tag'] === 'folder';
			return {
				virtual_path: toVirtualPath(entry.path_display || entry.path_lower),
				file_name: entry.name,
				is_folder: isFolder,
				size: isFolder ? 0 : Number(entry.size || 0),
				mime_type: isFolder ? null : guessMimeType(entry.name),
				remote_file_id: entry.id || entry.path_lower,
				remote_parent_id: toVirtualPath(entry.path_display || entry.path_lower),
				remote_created_time: null,
				remote_modified_time: isFolder ? null : entry.server_modified || null,
			};
		});
	}

	async function getStorageSummary() {
		const payload = await rpc('/users/get_space_usage', {});
		const allocation = payload.allocation || {};
		const totalSpace = allocation.allocated || allocation.individual?.allocated || allocation.team?.allocated || account.total_space || 0;
		return { totalSpace: Number(totalSpace || 0), usedSpace: Number(payload.used || account.used_space || 0) };
	}

	function resolvePath(fileRecord) {
		return fileRecord.remote_file_id || joinDropboxPath(normalizePath(fileRecord.virtual_path), fileRecord.file_name);
	}

	async function simpleUpload({ targetPath, stream, onProgress }) {
		const response = await content('/files/upload', {
			args: { path: targetPath, mode: 'add', autorename: true, mute: false, strict_conflict: false },
			body: progressStream(stream, onProgress),
			contentType: 'application/octet-stream',
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok) throw Object.assign(new Error(await parseContentError(response.clone(), 'Failed to upload file to Dropbox')), { status: response.status });
		return payload;
	}

	async function sessionUpload({ targetPath, size, stream, onProgress }) {
		const startResponse = await content('/files/upload_session/start', { args: { close: false }, body: '' });
		const startPayload = await startResponse.json().catch(() => null);
		if (!startResponse.ok || !startPayload?.session_id) throw new Error(await parseContentError(startResponse.clone?.() || startResponse, 'Dropbox upload session failed to start'));
		const sessionId = startPayload.session_id;
		let offset = 0;
		while (offset < size) {
			const chunkLength = Math.min(SESSION_CHUNK_SIZE, size - offset);
			const chunk = await readChunk(stream, chunkLength);
			if (!chunk || chunk.length !== chunkLength) throw new Error('Upload stream ended before the expected file size');
			const appendResponse = await content('/files/upload_session/append_v2', {
				args: { close: false, cursor: { session_id: sessionId, offset } },
				body: chunk,
			});
			if (!appendResponse.ok) throw new Error(await parseContentError(appendResponse.clone(), 'Failed to upload file to Dropbox'));
			offset += chunkLength;
			try { onProgress?.(offset); } catch { /* never break the upload */ }
		}
		const finishResponse = await content('/files/upload_session/finish', {
			args: { cursor: { session_id: sessionId, offset }, commit: { path: targetPath, mode: 'add', autorename: true, mute: false, strict_conflict: false } },
			body: '',
		});
		const finishPayload = await finishResponse.json().catch(() => null);
		if (!finishResponse.ok) throw new Error(await parseContentError(finishResponse.clone(), 'Failed to finalize Dropbox upload'));
		return finishPayload;
	}

	async function uploadStream({ stream, size, fileName, mimeType, virtualPath = '/', onProgress }) {
		void mimeType;
		const parentPath = await ensureRemotePath(virtualPath);
		const targetPath = joinDropboxPath(parentPath || '/', fileName);
		const knownSize = Number(size) > 0 ? Number(size) : null;
		const payload = knownSize && knownSize > SIMPLE_UPLOAD_LIMIT
			? await sessionUpload({ targetPath, size: knownSize, stream, onProgress })
			: await simpleUpload({ targetPath, stream, onProgress });
		return {
			remoteFileId: payload.id || payload.path_lower,
			remoteParentId: parentPath || '/',
			size: Number(payload.size || size || 0),
			fileName: payload.name || fileName,
			mimeType,
		};
	}

	async function getDownloadStream(fileRecord) {
		const response = await content('/files/download', { args: { path: resolvePath(fileRecord) }, body: null, contentType: '' });
		if (!response.ok) {
			const payload = await response.json().catch(() => null);
			throw new Error(parseDropboxError(payload, 'Failed to download file from Dropbox'));
		}
		if (!response.body) throw new Error('Dropbox download returned an empty response');
		return response.body;
	}

	async function moveFile(fileRecord, destination = {}) {
		const fromPath = resolvePath(fileRecord);
		const destinationVirtualPath = normalizePath(destination.virtualPath || '/');
		const toPath = joinDropboxPath(destinationVirtualPath, fileRecord.file_name);
		if (fromPath === toPath) return;
		await rpc('/files/move_v2', { from_path: fromPath, to_path: toPath, autorename: false, allow_shared_folder: true });
	}

	async function renameFile(fileRecord, nextName) {
		const toPath = joinDropboxPath(normalizePath(fileRecord.virtual_path), nextName);
		await rpc('/files/move_v2', { from_path: resolvePath(fileRecord), to_path: toPath, autorename: false, allow_shared_folder: true });
	}

	async function deleteFile(fileRecord) {
		await rpc('/files/delete_v2', { path: resolvePath(fileRecord) });
	}

	return {
		provider: 'dropbox',
		fetchStructure,
		getStorageSummary,
		uploadStream,
		getDownloadStream,
		moveFile,
		renameFile,
		deleteFile,
	};
}
