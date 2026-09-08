import { Readable, Transform } from 'node:stream';
import { sql } from '../../db.js';
import { encryptJson, decryptJson } from '../../crypto.js';
import { apiFetch } from './http.js';

const API_BASE = 'https://cloud-api.yandex.net/v1/disk';

function normalizeVirtualPath(input = '/') {
	if (!input || input === '/') return '/';
	const prefixed = input.startsWith('/') ? input : `/${input}`;
	return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function resourcePathToVirtual(resourcePath = '') {
	const clean = resourcePath.replace(/^disk:/, '');
	const trimmed = clean.replace(/\/+$/, '');
	const lastSlash = trimmed.lastIndexOf('/');
	if (lastSlash <= 0) return '/';
	return `${trimmed.slice(0, lastSlash)}/`;
}

function joinPath(parent = '/', name = '') {
	const base = parent === '/' ? '' : parent.replace(/\/+$/, '');
	return `${base}/${name}`;
}

export function create(env, account) {
	let tokenCache = null;

	function readCredentials() {
		const credentials = decryptJson(account.encrypted_credentials, env.ENCRYPTION_KEY);
		if (!credentials.accessToken && !credentials.refreshToken) throw new Error('Yandex account credentials are incomplete');
		return credentials;
	}

	async function persistCredentials(credentials) {
		try {
			const db = sql(env);
			await db`UPDATE cloud_accounts SET encrypted_credentials=${encryptJson(credentials, env.ENCRYPTION_KEY)}, updated_at=NOW() WHERE id=${account.id} AND user_id=${account.user_id}`;
		} catch (error) {
			console.warn('[yandex] failed to persist refreshed token:', error?.message || error);
		}
	}

	async function getAccessToken(forceRefresh = false) {
		const credentials = readCredentials();
		if (!forceRefresh && tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
		if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) {
			tokenCache = { token: credentials.accessToken, expiresAt: Date.now() + 3_600_000 };
			return credentials.accessToken;
		}
		if (!forceRefresh && credentials.accessToken && !tokenCache) {
			tokenCache = { token: credentials.accessToken, expiresAt: Date.now() + 60_000 };
			return credentials.accessToken;
		}
		const response = await apiFetch('https://oauth.yandex.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: credentials.clientId, client_secret: credentials.clientSecret }),
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok || !payload?.access_token) throw new Error(payload?.error_description || payload?.error || 'Failed to refresh Yandex access token');
		tokenCache = { token: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
		await persistCredentials({ ...credentials, accessToken: payload.access_token, refreshToken: payload.refresh_token || credentials.refreshToken });
		return tokenCache.token;
	}

	async function request(path, { method = 'GET', query = {} } = {}) {
		const makeRequest = async (token) => {
			const url = new URL(`${API_BASE}${path}`);
			Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== null) url.searchParams.set(key, String(value)); });
			const response = await apiFetch(url.toString(), { method, headers: { Authorization: `OAuth ${token}` } });
			if (response.status === 204) return {};
			const payload = await response.json().catch(() => null);
			if (!response.ok) {
				throw Object.assign(new Error(payload?.message || payload?.description || 'Yandex API request failed'), { status: response.status });
			}
			return payload;
		};
		let token = await getAccessToken();
		try {
			return await makeRequest(token);
		} catch (error) {
			if (error?.status !== 401) throw error;
			token = await getAccessToken(true);
			return makeRequest(token);
		}
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

	async function fetchStructure() {
		const records = [];
		const queue = ['/'];
		while (queue.length) {
			const current = queue.shift();
			let offset = 0;
			const limit = 200;
			while (true) {
				const payload = await request('/resources', { query: { path: current, limit, offset, sort: 'name' } });
				const items = payload?._embedded?.items || [];
				for (const item of items) {
					const isFolder = item.type === 'dir';
					const virtualPath = normalizeVirtualPath(resourcePathToVirtual(item.path));
					records.push({
						virtual_path: virtualPath,
						file_name: item.name,
						is_folder: isFolder,
						size: isFolder ? 0 : Number(item.size || 0),
						mime_type: isFolder ? null : item.mime_type || 'application/octet-stream',
						remote_file_id: item.path.replace(/^disk:/, ''),
						remote_parent_id: virtualPath,
						remote_created_time: item.created || null,
						remote_modified_time: item.modified || null,
					});
					if (isFolder) queue.push(item.path.replace(/^disk:/, ''));
				}
				if (items.length < limit) break;
				offset += limit;
			}
		}
		return records;
	}

	async function getStorageSummary() {
		const payload = await request('/');
		return { totalSpace: Number(payload.total_space || account.total_space || 0), usedSpace: Number(payload.used_space || account.used_space || 0) };
	}

	async function ensureFolder(virtualPath = '/') {
		const normalized = normalizeVirtualPath(virtualPath);
		if (normalized === '/') return;
		const segments = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
		let current = '';
		for (const segment of segments) {
			current = `${current}/${segment}`;
			try {
				await request('/resources', { method: 'PUT', query: { path: current } });
			} catch (error) {
				if (error?.status !== 409) throw error;
			}
		}
	}

	async function uploadStream({ stream, size, fileName, mimeType, virtualPath = '/', onProgress, duplicatePolicy = 'rename' }) {
		await ensureFolder(virtualPath);
		const normalized = normalizeVirtualPath(virtualPath);
		const targetPath = joinPath(normalized === '/' ? '' : normalized.replace(/\/+$/, ''), fileName);
		const overwrite = duplicatePolicy === 'overwrite';
		const uploadInfo = await request('/resources/upload', { query: { path: targetPath, overwrite: String(overwrite) } });
		if (!uploadInfo?.href) throw new Error('Yandex did not return an upload URL');
		const body = progressStream(stream, onProgress);
		const response = await apiFetch(uploadInfo.href, {
			method: uploadInfo.method || 'PUT',
			headers: { 'Content-Type': mimeType || 'application/octet-stream', ...(size ? { 'Content-Length': String(size) } : {}) },
			body: Readable.toWeb(body),
			duplex: 'half',
		});
		if (!response.ok && response.status !== 201 && response.status !== 202) throw new Error('Failed to upload file to Yandex Disk');
		return { remoteFileId: targetPath, remoteParentId: normalized, size: Number(size || 0), fileName, mimeType };
	}

	function resolvePath(fileRecord) {
		return fileRecord.remote_file_id || joinPath(fileRecord.virtual_path === '/' ? '' : normalizeVirtualPath(fileRecord.virtual_path).replace(/\/+$/, ''), fileRecord.file_name);
	}

	async function getDownloadStream(fileRecord) {
		const info = await request('/resources/download', { query: { path: resolvePath(fileRecord) } });
		if (!info?.href) throw new Error('Yandex did not return a download URL');
		const response = await apiFetch(info.href);
		if (!response.ok || !response.body) throw new Error('Failed to download file from Yandex Disk');
		return response.body;
	}

	async function moveFile(fileRecord, destination = {}) {
		const from = resolvePath(fileRecord);
		const destinationPath = normalizeVirtualPath(destination.virtualPath || '/');
		const base = destinationPath === '/' ? '' : destinationPath.replace(/\/+$/, '');
		const to = `${base}/${fileRecord.file_name}`;
		if (from === to) return;
		await request('/resources/move', { method: 'POST', query: { from, path: to, overwrite: 'false' } });
	}

	async function renameFile(fileRecord, nextName) {
		const from = resolvePath(fileRecord);
		const normalized = normalizeVirtualPath(fileRecord.virtual_path);
		const base = normalized === '/' ? '' : normalized.replace(/\/+$/, '');
		const to = `${base}/${nextName}`;
		await request('/resources/move', { method: 'POST', query: { from, path: to, overwrite: 'false' } });
	}

	async function deleteFile(fileRecord) {
		await request('/resources', { method: 'DELETE', query: { path: resolvePath(fileRecord), permanently: 'false' } });
	}

	return {
		provider: 'yandex',
		fetchStructure,
		getStorageSummary,
		uploadStream,
		getDownloadStream,
		moveFile,
		renameFile,
		deleteFile,
	};
}
