const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL
	|| (typeof window !== 'undefined'
		? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/uploads`
		: 'ws://localhost:8787/ws/uploads');

async function request(path, options = {}) {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {}),
		},
		...options,
	});

	if (!response.ok) {
		const payload = await response.json().catch(() => ({ error: 'Unknown API error' }));
		const error = new Error(payload.error || 'API request failed');
		error.status = response.status;
		error.code = payload.code || null;
		throw error;
	}

	return response.json();
}

export const authApi = {
	me() {
		return request('/auth/me');
	},
	login(payload) {
		return request('/auth/login', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	register(payload) {
		return request('/auth/register', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	logout() {
		return request('/auth/logout', {
			method: 'POST',
		});
	},
};

export const settingsApi = {
	getSettings() {
		return request('/settings');
	},
	updateSettings(payload) {
		return request('/settings', {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
};

export const aiApi = {
	async chat(message, { onEvent, signal } = {}) {
		const controller = new AbortController();
		const onExternalAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener('abort', onExternalAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(), 70000);
		try {
			const response = await fetch(`${API_BASE_URL}/ai/chat`, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ message }),
				signal: controller.signal,
			});

			if (!response.ok) {
				const payload = await response.json().catch(() => ({ error: 'AI request failed' }));
				const error = new Error(payload.error || 'AI request failed');
				error.status = response.status;
				error.code = payload.code || null;
				throw error;
			}

			if (!response.body) return;

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let sawDone = false;
			let sawError = false;

			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let separator;
				while ((separator = buffer.indexOf('\n\n')) !== -1) {
					const raw = buffer.slice(0, separator);
					buffer = buffer.slice(separator + 2);
					const line = raw.trim();
					if (!line.startsWith('data:')) continue;
					const payload = line.slice(5).trim();
					if (!payload) continue;
					try {
						const event = JSON.parse(payload);
						if (event.type === 'done') sawDone = true;
						if (event.type === 'error') sawError = true;
						onEvent?.(event);
					} catch {}
				}
			}

			if (!sawDone && !sawError) {
				const interrupted = new Error('La respuesta se interrumpió. Inténtalo de nuevo.');
				interrupted.status = 504;
				interrupted.code = 'AI_STREAM_INTERRUPTED';
				throw interrupted;
			}
		} catch (err) {
			if (err.name === 'AbortError' && !(signal && signal.aborted)) {
				const error = new Error('El asistente tardó demasiado. Inténtalo de nuevo.');
				error.status = 408;
				error.code = 'AI_TIMEOUT';
				throw error;
			}
			throw err;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onExternalAbort);
		}
	},
};

export const api = {
	listFiles(virtualPath = '/') {
		const query = new URLSearchParams({ path: virtualPath }).toString();
		return request(`/files?${query}`);
	},
	searchFiles(term, limit = 50) {
		const query = new URLSearchParams({ search: term, limit: String(limit) }).toString();
		return request(`/files?${query}`);
	},
	listStarredFiles() {
		return request('/files?starred=1');
	},
	listRecentFiles() {
		return request('/files?recent=1');
	},
	listSharedWithMeFiles() {
		return request('/files?shared=1');
	},
	listSharedFolderChildren(fileId) {
		return request(`/files/${fileId}/shared-children`);
	},
	getFileDetails(fileId) {
		return request(`/files/${fileId}`);
	},
	createFolder(payload) {
		return request('/files/folders', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	renameFile(fileId, payload) {
		return request(`/files/${fileId}/rename`, {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
	moveFile(fileId, payload) {
		return request(`/files/${fileId}/move`, {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	toggleStar(fileId, isStarred = true) {
		return request(`/files/${fileId}/star`, {
			method: 'PATCH',
			body: JSON.stringify({ is_starred: isStarred }),
		});
	},
	deleteFile(fileId) {
		return request(`/files/${fileId}`, {
			method: 'DELETE',
		});
	},
	deleteFiles(fileIds) {
		return request('/files/bulk/delete', {
			method: 'POST',
			body: JSON.stringify({ ids: fileIds }),
		});
	},
	listTransfers(limit = 25) {
		const query = new URLSearchParams({ limit: String(limit) }).toString();
		return request(`/transfers?${query}`);
	},
	getTransfer(transferId) {
		return request(`/transfers/${encodeURIComponent(transferId)}`);
	},
	cancelTransfer(transferId) {
		return request(`/transfers/${encodeURIComponent(transferId)}/cancel`, {
			method: 'POST',
		});
	},
	getStorage() {
		return request('/storage');
	},
	getGoogleIntegrationStatus() {
		return request('/accounts/google/status');
	},
	getGoogleConnectUrl() {
		return request('/accounts/google/connect');
	},
	getOneDriveIntegrationStatus() {
		return request('/accounts/onedrive/status');
	},
	getOneDriveConnectUrl() {
		return request('/accounts/onedrive/connect');
	},
	getDropboxIntegrationStatus() {
		return request('/accounts/dropbox/status');
	},
	getDropboxConnectUrl() {
		return request('/accounts/dropbox/connect');
	},
	getMegaIntegrationStatus() {
		return request('/accounts/mega/status');
	},
	connectMegaAccount(payload) {
		return request('/accounts/mega/connect', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	connectS3Account(payload) {
		return request('/accounts/s3/connect', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	getYandexConnectUrl() {
		return request('/accounts/yandex/connect');
	},
	listAccounts() {
		return request('/accounts');
	},
	disconnectAccount(accountId) {
		return request(`/accounts/${accountId}`, {
			method: 'DELETE',
		});
	},
	getHealth() {
		return request('/health');
	},
	runSync() {
		return request('/sync/run', {
			method: 'POST',
		});
	},
	initiateUpload(payload, options = {}) {
		return request('/uploads/initiate', {
			method: 'POST',
			body: JSON.stringify(payload),
			signal: options.signal,
		});
	},
	async uploadFile(uploadId, file, options = {}) {
		const headers = {
			'Content-Type': file.type || 'application/octet-stream',
			'X-File-Name': encodeURIComponent(file.name || 'upload'),
		};

		const response = await fetch(`${API_BASE_URL}/uploads/${uploadId}/stream`, {
			method: 'POST',
			credentials: 'include',
			headers,
			body: file,
			signal: options.signal,
		});

		if (!response.ok) {
			const payload = await response.json().catch(() => ({ error: 'Upload failed' }));
			const error = new Error(payload.error || 'Upload failed');
			error.status = response.status;
			error.code = payload.code || null;
			throw error;
		}

		return response.json();
	},
	createUploadSocket(uploadId) {
		return new WebSocket(`${WS_BASE_URL}?uploadId=${encodeURIComponent(uploadId)}`);
	},
	downloadUrl(fileId) {
		return `${API_BASE_URL}/files/${fileId}/download`;
	},
	previewUrl(fileId) {
		return `${API_BASE_URL}/files/${fileId}/preview`;
	},
	getSettings() {
		return settingsApi.getSettings();
	},
	updateSettings(payload) {
		return settingsApi.updateSettings(payload);
	},
	getAllocation() {
		return request('/allocation');
	},
	updateAllocation(payload) {
		return request('/allocation', {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
};
