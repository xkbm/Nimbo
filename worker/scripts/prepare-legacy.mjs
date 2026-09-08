import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const backendRoot = path.join(repoRoot, 'backend/src');
const generatedRoot = path.join(repoRoot, 'worker/generated');
const adapterOut = path.join(generatedRoot, 'adapters');
const legacyOut = path.join(generatedRoot, 'legacy');

await fs.rm(generatedRoot, { recursive: true, force: true });
await fs.mkdir(adapterOut, { recursive: true });
await fs.mkdir(legacyOut, { recursive: true });

const adapters = [
  'DropboxAdapter.js',
  'OneDriveAdapter.js',
  'YandexAdapter.js',
  'S3Adapter.js',
  'MegaAdapter.js',
];

const read = (file) => fs.readFile(path.join(backendRoot, file), 'utf8');

for (const file of adapters) {
  let source = await read(path.join('adapters', file));
  source = source
    .replaceAll("from './BaseCloudAdapter.js'", "from '../legacy/BaseCloudAdapter.js'")
    .replaceAll("from '../utils/crypto.js'", "from '../legacy/crypto.js'")
    .replaceAll("from '../utils/mime.js'", "from '../legacy/mime.js'")
    .replaceAll("from '../utils/pcloudClient.js'", "from '../legacy/pcloudClient.js'")
    .replaceAll("from '../services/accountService.js'", "from '../legacy/accountService.js'");
  await fs.writeFile(path.join(adapterOut, file), source);
}

await fs.writeFile(path.join(legacyOut, 'BaseCloudAdapter.js'), await read(path.join('adapters', 'BaseCloudAdapter.js')));
await fs.writeFile(path.join(legacyOut, 'mime.js'), await read(path.join('utils', 'mime.js')));

await fs.writeFile(path.join(legacyOut, 'crypto.js'), `import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function secret() {
  const value = globalThis.__OMNICLOUD_ENCRYPTION_KEY;
  if (!value) throw new Error('Cloudflare encryption key is not configured');
  return String(value);
}

function keyFromSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function encryptJson(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret()), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptJson(value) {
  const raw = Buffer.from(String(value || ''), 'base64');
  if (raw.length < 28) throw new Error('Invalid encrypted credentials');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret()), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
`);

await fs.writeFile(path.join(legacyOut, 'accountService.js'), `import { encryptJson } from './crypto.js';
import { sql } from '../../src/db.js';

export async function updateAccountCredentials(userId, accountId, credentials) {
  const env = globalThis.__OMNICLOUD_WORKER_ENV;
  if (!env) return;
  const encrypted = typeof credentials === 'string' ? credentials : encryptJson(credentials);
  await sql(env)\`
    UPDATE cloud_accounts
    SET encrypted_credentials = \${encrypted}, updated_at = NOW()
    WHERE user_id = \${userId} AND id = \${accountId}
  \`;
}
`);

await fs.writeFile(path.join(repoRoot, 'worker/src/providers/legacy.js'), `const modules = {
  dropbox: () => import('../../generated/adapters/DropboxAdapter.js'),
  onedrive: () => import('../../generated/adapters/OneDriveAdapter.js'),
  yandex: () => import('../../generated/adapters/YandexAdapter.js'),
  s3: () => import('../../generated/adapters/S3Adapter.js'),
  mega: () => import('../../generated/adapters/MegaAdapter.js'),
};

export async function getLegacyAdapter(env, account) {
  const loader = modules[account.provider];
  if (!loader) throw new Error(\`Provider \${account.provider} is not available in the Cloudflare runtime\`);
  globalThis.__OMNICLOUD_WORKER_ENV = env;
  globalThis.__OMNICLOUD_ENCRYPTION_KEY = env.ENCRYPTION_KEY;
  const mod = await loader();
  const Adapter = mod[Object.keys(mod).find((key) => key.endsWith('Adapter'))];
  if (!Adapter) throw new Error(\`No adapter class exported for \${account.provider}\`);
  return new Adapter(account);
}

export function isLegacyProvider(provider) {
  return Boolean(modules[provider]);
}
`);

console.log(`Prepared ${adapters.length} Cloudflare-compatible legacy adapters.`);

// Embed schema.sql as a string for auto-initialization on first boot.
const schemaPath = path.join(repoRoot, 'worker/schema.sql');
const migrationsDir = path.join(repoRoot, 'worker/migrations');
const schemaSql = await fs.readFile(schemaPath, 'utf8');
const migrationFiles = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
const migrationEntries = [];
for (const name of migrationFiles) {
  const sqlText = await fs.readFile(path.join(migrationsDir, name), 'utf8');
  migrationEntries.push({ name, sql: sqlText });
}
await fs.writeFile(
  path.join(generatedRoot, 'schema-string.js'),
  `export const SCHEMA_SQL = ${JSON.stringify(schemaSql)};\n\nexport const MIGRATIONS = ${JSON.stringify(migrationEntries)};\n`,
);
console.log('Embedded schema for auto-initialization.');
