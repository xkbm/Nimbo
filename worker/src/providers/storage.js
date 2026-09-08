import { Readable } from 'node:stream';
import { sql } from '../db.js';
import { getLegacyAdapter } from './legacy.js';
import { getNativeProvider, hasNativeProvider } from './native/index.js';
import { googleDelete, googleDownload, googleRename, googleSetStar, googleCreateFolder, googleUpload, googleFindParent, syncGoogleAccount, googleRequest } from './google.js';
import { googleMove } from './googleMove.js';
import { googleReplaceFile } from './googleReplace.js';
import { resolveUploadFileName } from './duplicatePolicy.js';

export function nodeReadableFromWeb(stream) {
  return stream ? Readable.fromWeb(stream) : null;
}

export async function getStorageAdapter(env, account) {
  if (account.provider === 'google_drive') return { kind: 'google', account };
  if (hasNativeProvider(account.provider)) {
    const mod = await getNativeProvider(account.provider);
    if (mod?.create) return { kind: 'native', adapter: mod.create(env, account), account };
  }
  return { kind: 'legacy', adapter: await getLegacyAdapter(env, account), account };
}

export async function syncStorageAccount(env, userId, account) {
  if (account.provider === 'google_drive') return syncGoogleAccount(env, userId, account);
  const { adapter } = await getStorageAdapter(env, account);
  const records = await adapter.fetchStructure();
  const summary = await adapter.getStorageSummary().catch(() => null);
  const db = sql(env);
  if (summary) await db`UPDATE cloud_accounts SET total_space=${Number(summary.totalSpace||account.total_space||0)}, used_space=${Number(summary.usedSpace||0)}, updated_at=NOW() WHERE id=${account.id} AND user_id=${userId}`;
  await db`DELETE FROM file_metadata WHERE cloud_account_id=${account.id} AND user_id=${userId}`;
  for (const record of records) {
    await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time) VALUES (${crypto.randomUUID()},${userId},${record.virtual_path||'/'},${record.file_name},${Boolean(record.is_folder)},${Boolean(record.is_starred)},${Number(record.size||0)},${record.mime_type||null},${account.id},${String(record.remote_file_id||`${account.provider}:${record.virtual_path||'/'}:${record.file_name}`)},${record.remote_parent_id||null},${record.remote_created_time||null},${record.remote_modified_time||null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,is_folder=EXCLUDED.is_folder,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,remote_created_time=EXCLUDED.remote_created_time,remote_modified_time=EXCLUDED.remote_modified_time,updated_at=NOW()`;
  }
  return { synced: records.length, totalSpace: summary?.totalSpace ?? null, usedSpace: summary?.usedSpace ?? null };
}

export async function performRename(env, account, row, name) {
  if (account.provider === 'google_drive') return googleRename(env, account, row.remote_file_id, name);
  const { adapter } = await getStorageAdapter(env, account);
  return adapter.renameFile(row, name);
}

export async function performMove(env, account, row, destination) {
  if (account.provider === 'google_drive') return googleMove(env, account, row.remote_file_id, destination.remoteParentId || 'root');
  const { adapter } = await getStorageAdapter(env, account);
  if (typeof adapter.moveFile !== 'function') throw Object.assign(new Error(`Move is not supported for provider ${account.provider}`), { status: 409, code: 'NATIVE_MOVE_UNSUPPORTED' });
  return adapter.moveFile(row, destination);
}

export async function performDelete(env, account, row) {
  if (account.provider === 'google_drive') return googleDelete(env, account, row.remote_file_id);
  const { adapter } = await getStorageAdapter(env, account);
  return adapter.deleteFile(row);
}

export async function performDownload(env, account, row) {
  if (account.provider === 'google_drive') return googleDownload(env, account, row.remote_file_id);
  const { adapter } = await getStorageAdapter(env, account);
  return new Response(await adapter.getDownloadStream(row));
}

export async function performGetMetadata(env, account, row) {
  if (account.provider === 'google_drive') {
    const data = await googleRequest(env, account, `/files/${encodeURIComponent(row.remote_file_id)}?fields=id,name,mimeType,size,parents,createdTime,modifiedTime,trashed`);
    return {
      name: data?.name || row.file_name,
      mime_type: data?.mimeType || row.mime_type || null,
      size: Number(data?.size || 0),
      createdTime: data?.createdTime || null,
      modifiedTime: data?.modifiedTime || null,
      remote_file_id: data?.id || row.remote_file_id,
      remote_parent_id: data?.parents?.[0] || null,
      provider: 'google_drive',
    };
  }
  const { adapter } = await getStorageAdapter(env, account);
  if (typeof adapter.getFileDetails !== 'function') throw Object.assign(new Error(`Metadata verification is not supported for provider ${account.provider}`), { status: 409, code: 'METADATA_VERIFY_UNSUPPORTED' });
  return adapter.getFileDetails(row);
}

export async function performCreateFolder(env, account, { name, virtualPath, remoteParentId }) {
  if (account.provider === 'google_drive') {
    const parentId = remoteParentId || await googleFindParent(env, account, virtualPath || '/') || 'root';
    const folder = await googleCreateFolder(env, account, name, parentId);
    return { remoteFileId: folder.id, remoteParentId: parentId, fileName: folder.name || name };
  }
  const { adapter } = await getStorageAdapter(env, account);
  return adapter.createFolder({ name, virtualPath, remoteParentId });
}

export async function performUpload(env, account, input) {
  const duplicatePolicy = input.duplicatePolicy || 'rename';
  let existing = null;
  let fileName = input.fileName;

  if (duplicatePolicy === 'overwrite') {
    const resolved = await resolveUploadFileName(env, account, input);
    existing = resolved.existing;
    fileName = resolved.fileName;
  }

  if (account.provider === 'google_drive') {
    if (duplicatePolicy === 'overwrite' && existing?.remote_file_id) {
      return googleReplaceFile(env, account, existing.remote_file_id, {
        body: input.body,
        fileName,
        mimeType: input.mimeType,
        size: input.size,
        onProgress: input.onProgress,
      });
    }
    return googleUpload(env, account, { ...input, fileName, duplicatePolicy });
  }

  const { adapter } = await getStorageAdapter(env, account);
  return adapter.uploadStream({
    stream: nodeReadableFromWeb(input.body),
    size: input.size,
    fileName,
    mimeType: input.mimeType,
    virtualPath: input.virtualPath,
    remoteParentId: input.remoteParentId,
    duplicatePolicy,
    existingRemoteId: existing?.remote_file_id || null,
    onProgress: input.onProgress,
  });
}

export async function setStar(env, account, row, isStarred) {
  if (account.provider !== 'google_drive') throw Object.assign(new Error(`Starred state is not supported for provider ${account.provider}`), { status: 409 });
  return googleSetStar(env, account, row.remote_file_id, isStarred);
}
