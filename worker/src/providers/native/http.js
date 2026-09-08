const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 4_000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
	return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * fetch with hard timeout and optional retry on network errors / 5xx.
 * Never logs the URL (may contain tokens) — callers own their logging.
 */
export async function apiFetch(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0 } = {}) {
	let lastError;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, { ...options, signal: options.signal ? undefined : controller.signal });
			clearTimeout(timer);
			if (attempt < retries && response.status >= 500) {
				lastError = Object.assign(new Error(`HTTP ${response.status}`), { retryable: true });
				await sleep(backoff(attempt));
				continue;
			}
			return response;
		} catch (error) {
			clearTimeout(timer);
			lastError = error?.name === 'AbortError' ? new Error('Provider request timed out') : error;
			if (attempt < retries) {
				await sleep(backoff(attempt));
				continue;
			}
		}
	}
	throw lastError;
}

export async function apiJson(url, options, config) {
	const response = await apiFetch(url, options, config);
	const payload = await response.json().catch(() => null);
	return { response, payload };
}
