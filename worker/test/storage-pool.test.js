import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageBackend } from '../src/storage/backend.js';
import { StoragePool } from '../src/storage/pool.js';

function backend(overrides = {}) {
  return new StorageBackend({
    id: 'backend-1',
    user_id: 'user-1',
    provider: 's3',
    email: 's3@example.com',
    status: 'active',
    total_space: 100,
    used_space: 20,
    ...overrides,
  });
}

test('StorageBackend computes free space and health from account state', () => {
  const item = backend();
  assert.equal(item.freeSpace, 80);
  assert.equal(item.healthy, true);
  assert.equal(item.canStore(80), true);
  assert.equal(item.canStore(81), false);
});

test('StorageBackend exposes conservative provider move capabilities', () => {
  assert.equal(backend({ provider: 'google_drive' }).canNativeMove(), true);
  assert.equal(backend({ provider: 'dropbox' }).canNativeMove(), true);
  assert.equal(backend({ provider: 'onedrive' }).canNativeMove(), true);
  assert.equal(backend({ provider: 'yandex' }).canNativeMove(), true);
  assert.equal(backend({ provider: 's3' }).canNativeMove(), true);
  assert.equal(backend({ provider: 'mega' }).canNativeMove(), false);
});

test('StoragePool aggregates only active storage backends', () => {
  const pool = new StoragePool([
    backend({ id: 'a', total_space: 100, used_space: 25, status: 'active' }),
    backend({ id: 'b', total_space: 200, used_space: 50, status: 'active' }),
    backend({ id: 'c', total_space: 1000, used_space: 1, status: 'error' }),
  ]);

  assert.equal(pool.capacity, 300);
  assert.equal(pool.used, 75);
  assert.equal(pool.free, 225);
  assert.equal(pool.utilization, 0.25);
});

test('StoragePool least_used chooses the backend with the lowest utilization', () => {
  const pool = new StoragePool([
    backend({ id: 'a', total_space: 100, used_space: 80 }),
    backend({ id: 'b', total_space: 100, used_space: 20 }),
  ], { strategy: 'least_used' });

  assert.equal(pool.chooseBackend(10).id, 'b');
});

test('StoragePool most_free chooses the backend with the most free bytes', () => {
  const pool = new StoragePool([
    backend({ id: 'a', total_space: 100, used_space: 10 }),
    backend({ id: 'b', total_space: 500, used_space: 200 }),
  ], { strategy: 'most_free' });

  assert.equal(pool.chooseBackend(10).id, 'b');
});

test('StoragePool respects an explicit backend override when capacity permits', () => {
  const pool = new StoragePool([
    backend({ id: 'a', total_space: 100, used_space: 10 }),
    backend({ id: 'b', total_space: 100, used_space: 20 }),
  ], { strategy: 'least_used' });

  assert.equal(pool.chooseBackend(10, { backendId: 'a' }).id, 'a');
});

test('StoragePool returns null when no healthy backend can store the requested size', () => {
  const pool = new StoragePool([
    backend({ id: 'a', total_space: 100, used_space: 95 }),
    backend({ id: 'b', total_space: 100, used_space: 100 }),
  ]);

  assert.equal(pool.chooseBackend(10), null);
});
