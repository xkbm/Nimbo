/**
 * Native provider modules ("rewrite, not adapt").
 *
 * Every module registered here implements the SAME interface the runtime
 * already consumes from legacy adapters (duck-typed, no wrapper needed):
 *
 *   fetchStructure()                                  -> [{ file_name, virtual_path, is_folder,
 *                                                          size, mime_type, remote_file_id,
 *                                                          remote_parent_id, is_starred,
 *                                                          remote_created_time, remote_modified_time }]
 *   getStorageSummary()                               -> { totalSpace, usedSpace }
 *   uploadStream({ stream: NodeReadable, size, fileName, mimeType, virtualPath,
 *                  remoteParentId, duplicatePolicy, existingRemoteId, onProgress })
 *   downloadStream(row) / getDownloadStream(row)      -> Readable/Web stream
 *   renameFile(row, name)
 *   deleteFile(row)
 *   moveFile?(row, destination)                       -> omit if API has no native move
 *
 * Modules receive credentials via decryptJson(account.encrypted_credentials)
 * and MUST NOT log tokens or secrets.
 *
 * Register a module below ONLY after its E2E checklist passes
 * (connect -> sync -> upload -> download -> rename -> delete -> cross-move).
 *
 * Each entry is a loader returning a module that exports `create(env, account)`
 * -> adapter instance (one per account, so token caches never leak across
 * accounts).
 */
const REGISTRY = {
	yandex: () => import('./yandex.js'),
	dropbox: () => import('./dropbox.js'),
};

export function hasNativeProvider(provider) {
	return Boolean(REGISTRY[provider]);
}

export async function getNativeProvider(provider) {
	const loader = REGISTRY[provider];
	if (!loader) return null;
	return loader();
}
