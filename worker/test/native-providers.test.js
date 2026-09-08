import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getNativeProvider, hasNativeProvider } from '../src/providers/native/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, p), 'utf8');

test('native provider registry — yandex+dropbox migrated, rest fall back to legacy', async () => {
	assert.equal(hasNativeProvider('google_drive'), false, 'google has its own native paths');
	assert.equal(hasNativeProvider('yandex'), true, 'yandex is native since F2');
	assert.equal(hasNativeProvider('dropbox'), true, 'dropbox is native since F3');
	for (const provider of ['onedrive', 's3', 'mega']) {
		assert.equal(hasNativeProvider(provider), false, `${provider} should not be native yet`);
		assert.equal(await getNativeProvider(provider), null, `${provider} should resolve to null`);
	}
});

test('native yandex module exposes create(env, account) factory with full contract', async () => {
	const mod = await getNativeProvider('yandex');
	assert.equal(typeof mod.create, 'function');
	const adapter = mod.create({ ENCRYPTION_KEY: 'k' }, { encrypted_credentials: 'e30', id: 'x' });
	for (const method of ['fetchStructure', 'getStorageSummary', 'uploadStream', 'getDownloadStream', 'moveFile', 'renameFile', 'deleteFile']) {
		assert.equal(typeof adapter[method], 'function', `adapter must implement ${method}`);
	}
});

test('native dropbox module exposes create(env, account) factory with full contract', async () => {
	const mod = await getNativeProvider('dropbox');
	assert.equal(typeof mod.create, 'function');
	const adapter = mod.create({ ENCRYPTION_KEY: 'k' }, { encrypted_credentials: 'e30', id: 'x' });
	for (const method of ['fetchStructure', 'getStorageSummary', 'uploadStream', 'getDownloadStream', 'moveFile', 'renameFile', 'deleteFile']) {
		assert.equal(typeof adapter[method], 'function', `adapter must implement ${method}`);
	}
});

test('storage.js dispatches native-first with legacy fallback', () => {
	const source = read('../src/providers/storage.js');
	assert.match(source, /hasNativeProvider\(account\.provider\)/);
	assert.match(source, /kind: 'native'/);
	assert.match(source, /getLegacyAdapter/);
});

test('native contract documents the adapter duck-type interface', () => {
	const doc = read('../src/providers/native/index.js');
	for (const method of ['fetchStructure', 'getStorageSummary', 'uploadStream', 'getDownloadStream', 'renameFile', 'deleteFile', 'moveFile?']) {
		assert.ok(doc.includes(method), `contract must mention ${method}`);
	}
});
