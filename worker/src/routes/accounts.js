import { randomUUID } from 'node:crypto';
import { Storage as MegaStorage } from 'megajs';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { requireUser, sql } from '../db.js';
import { getSiteUrl } from '../utils/siteUrl.js';
import { encryptJson } from '../crypto.js';
import { syncStorageAccount } from '../providers/storage.js';

const GIB = 1024 ** 3;
const DEFAULT_S3_TOTAL_SPACE = 10 * GIB;
const DROPBOX_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'];
const ONEDRIVE_SCOPE = 'offline_access openid profile email Files.ReadWrite.All User.Read';
const YANDEX_SCOPE = 'cloud_api:disk.read cloud_api:disk.write cloud_api:disk.info';
const MEGA_CONNECT_ATTEMPTS = 3;
const MEGA_RETRY_DELAYS = [3000, 8000];

function providerStatus(env, provider) {
  const configured = {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    onedrive: Boolean(env.ONEDRIVE_CLIENT_ID && env.ONEDRIVE_CLIENT_SECRET),
    dropbox: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET),
    yandex: Boolean(env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET),
    mega: true,
    s3: true,
  };
  return { provider, configured: Boolean(configured[provider]) };
}

function oauthConfig(env, provider) {
  const configs = {
    onedrive: {
      clientId: env.ONEDRIVE_CLIENT_ID,
      clientSecret: env.ONEDRIVE_CLIENT_SECRET,
      redirectUri: env.ONEDRIVE_REDIRECT_URI,
      authority: `https://login.microsoftonline.com/${encodeURIComponent(env.ONEDRIVE_TENANT_ID || 'common')}/oauth2/v2.0`,
    },
    dropbox: {
      clientId: env.DROPBOX_CLIENT_ID,
      clientSecret: env.DROPBOX_CLIENT_SECRET,
      redirectUri: env.DROPBOX_REDIRECT_URI,
    },
    yandex: {
      clientId: env.YANDEX_CLIENT_ID,
      clientSecret: env.YANDEX_CLIENT_SECRET,
      redirectUri: env.YANDEX_REDIRECT_URI,
    },
  };
  const config = configs[provider];
  if (!config?.clientId || !config?.clientSecret) throw new Error(`${provider} OAuth is not configured`);
  return config;
}

function accountErrorResponse(c, error, fallback='Account operation failed', code='ACCOUNT_OPERATION_FAILED') {
  if (error instanceof Response) return error;
  console.error('[accounts] request failed:', error);
  const requestedStatus = Number(error?.status);
  const status = [400,404,409].includes(requestedStatus) ? requestedStatus : 500;
  const safeMessage = error?.clientSafe === true ? String(error.message || '') : '';
  return c.json({ error: safeMessage || fallback, code: (safeMessage && error?.safeCode) || code, ...(safeMessage ? { safe: true } : {}) }, status);
}

async function saveOAuthState(env, userId, provider) {
  const state = crypto.randomUUID();
  const db = sql(env);
  await db`
    DELETE FROM oauth_states
    WHERE user_id = ${userId} AND provider = ${provider}
  `;
  await db`
    INSERT INTO oauth_states (state, user_id, provider, expires_at)
    VALUES (${state}, ${userId}, ${provider}, NOW() + INTERVAL '10 minutes')
  `;
  return state;
}

async function consumeOAuthState(env, state, provider) {
  const db = sql(env);
  const rows = await db`
    DELETE FROM oauth_states
    WHERE state = ${state}
      AND provider = ${provider}
      AND expires_at > NOW()
    RETURNING user_id
  `;
  if (!rows[0]) throw Object.assign(new Error(`Invalid or expired ${provider} OAuth state`), { status: 400, code: 'INVALID_OAUTH_STATE' });
  return rows[0].user_id;
}

async function upsertAccount(env, { userId, email, provider, credentials, totalSpace = 0, usedSpace = 0 }) {
  const db = sql(env);
  const account = {
    id: randomUUID(),
    user_id: userId,
    email,
    provider,
    encrypted_credentials: encryptJson(credentials, env.ENCRYPTION_KEY),
    total_space: Number(totalSpace || 0),
    used_space: Number(usedSpace || 0),
    status: 'active',
  };

  await db`
    INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status, updated_at)
    VALUES (${account.id}, ${account.user_id}, ${account.email}, ${account.provider}, ${account.encrypted_credentials}, ${account.total_space}, ${account.used_space}, 'active', NOW())
    ON CONFLICT (user_id, provider, email) DO UPDATE SET
      encrypted_credentials = EXCLUDED.encrypted_credentials,
      total_space = EXCLUDED.total_space,
      used_space = EXCLUDED.used_space,
      status = 'active',
      updated_at = NOW()
    RETURNING id, user_id, email, provider, encrypted_credentials, total_space, used_space, status, created_at, updated_at
  `;

  const rows = await db`
    SELECT id, user_id, email, provider, encrypted_credentials, total_space, used_space, status, created_at, updated_at
    FROM cloud_accounts
    WHERE user_id = ${userId} AND provider = ${provider} AND email = ${email}
    LIMIT 1
  `;

  return rows[0];
}

async function exchangeCode(config, code, extra = {}) {
  const response = await fetch(config.tokenUrl || `${config.authority}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      ...extra,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error_description || payload?.error_summary || payload?.error || 'OAuth token exchange failed');
  return payload;
}

async function refreshOneDriveProfile(accessToken) {
  const [meResponse, driveResponse] = await Promise.all([
    fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${accessToken}` } }),
    fetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType,quota', { headers: { Authorization: `Bearer ${accessToken}` } }),
  ]);
  const me = await meResponse.json().catch(() => null);
  const drive = await driveResponse.json().catch(() => null);
  if (!meResponse.ok) throw new Error(me?.error?.message || 'Unable to read OneDrive user profile');
  if (!driveResponse.ok) throw new Error(drive?.error?.message || 'Unable to read OneDrive drive profile');
  return {
    email: me.mail || me.userPrincipalName,
    displayName: me.displayName || null,
    driveId: drive.id || null,
    driveType: drive.driveType || 'personal',
    totalSpace: Number(drive.quota?.total || 0),
    usedSpace: Number(drive.quota?.used || 0),
  };
}

async function dropboxRpc(accessToken, path, body = {}) {
  const response = await fetch(`https://api.dropboxapi.com/2${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error_summary || payload?.error?.['.tag'] || payload?.error_description || 'Dropbox API request failed');
  return payload;
}

async function getDropboxProfile(accessToken) {
  const [account, space] = await Promise.all([
    dropboxRpc(accessToken, '/users/get_current_account'),
    dropboxRpc(accessToken, '/users/get_space_usage'),
  ]);
  return {
    email: account.email,
    displayName: account.name?.display_name || account.name?.familiar_name || null,
    accountId: account.account_id || null,
    totalSpace: Number(space.allocation?.allocated || space.allocation?.individual?.allocated || space.allocation?.team?.allocated || 0),
    usedSpace: Number(space.used || 0),
  };
}

async function getYandexProfile(accessToken) {
  const response = await fetch('https://cloud-api.yandex.net/v1/disk/', { headers: { Authorization: `OAuth ${accessToken}` } });
  const disk = await response.json().catch(() => null);
  if (!response.ok || !disk) throw new Error(disk?.message || 'Unable to read Yandex Disk profile');
  const login = disk.user?.login || disk.user?.display_name || 'yandex-user';
  return {
    email: disk.user?.email || `${login}@yandex`,
    displayName: disk.user?.display_name || login,
    totalSpace: Number(disk.total_space || 0),
    usedSpace: Number(disk.used_space || 0),
  };
}

function isMegaTemporaryError(error) { return /EAGAIN|temporary congestion|server malfunction/i.test(error?.message || ''); }
function isMegaInvalidCredentialError(error) { return /wrong password|ENOENT \(-9\)|invalid password|invalid email|authentication failed/i.test(error?.message || ''); }
function normalizeMegaConnectError(error) { if (isMegaInvalidCredentialError(error)) return new Error('MEGA email or password is incorrect.'); return error; }

async function connectMega(env, userId, { email, password, secondFactorCode }) {
  if (!email || !password) throw new Error('MEGA email and password are required');
  let lastError;
  for (let attempt = 0; attempt < MEGA_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const storage = new MegaStorage({ email, password, secondFactorCode: secondFactorCode || undefined, autoload: true, keepalive: false });
      try {
        await storage.ready;
        const accountInfo = await storage.getAccountInfo();
        const session = storage.toJSON();
        const accountEmail = storage.email || email;
        const account = await upsertAccount(env, { userId, email: accountEmail, provider: 'mega', credentials: { provider: 'mega', email: accountEmail, password, secondFactorCode: secondFactorCode || null, session }, totalSpace: Number(accountInfo.spaceTotal || 0), usedSpace: Number(accountInfo.spaceUsed || 0) });
        try { await syncStorageAccount(env, userId, account); } catch (error) { if (!isMegaTemporaryError(error)) throw error; }
        return { account, profile: { email: accountEmail, totalSpace: Number(accountInfo.spaceTotal || 0), usedSpace: Number(accountInfo.spaceUsed || 0) } };
      } finally { await storage.close().catch(() => {}); }
    } catch (error) {
      lastError = error;
      if (!isMegaTemporaryError(error) || attempt === MEGA_CONNECT_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, MEGA_RETRY_DELAYS[attempt] || 10000));
    }
  }
  throw isMegaTemporaryError(lastError) ? new Error('MEGA is temporarily busy or unavailable. Please try again.') : normalizeMegaConnectError(lastError);
}

async function connectS3(env, userId, body) {
  const { accessKeyId, secretAccessKey, bucket, region: regionInput, endpoint, label, totalSpace, forcePathStyle } = body || {};
  if (!accessKeyId || !secretAccessKey || !bucket) throw new Error('accessKeyId, secretAccessKey, and bucket are required');
  if (!endpoint) throw new Error('Endpoint is required (for example https://your-s3-endpoint)');
  const region = regionInput || 'auto';
  const client = new S3Client({ region, endpoint, forcePathStyle: forcePathStyle !== false, credentials: { accessKeyId, secretAccessKey } });
  try { await client.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch (error) {
    const status = error?.$metadata?.httpStatusCode; const name = error?.name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') throw new Error('Bucket was not found on this endpoint.');
    if (status === 403 || name === 'Forbidden' || name === 'AccessDenied') throw new Error('Access denied. Check the S3 credentials and bucket permissions.');
    if (status === 401 || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') throw new Error('Invalid S3 credentials.');
    throw new Error('Failed to connect to S3 bucket.');
  }
  const email = label || `${bucket}@s3`;
  const account = await upsertAccount(env, { userId, email, provider: 's3', credentials: { provider: 's3', accessKeyId, secretAccessKey, bucket, region, endpoint, forcePathStyle: forcePathStyle !== false }, totalSpace: Number(totalSpace) || DEFAULT_S3_TOTAL_SPACE, usedSpace: 0 });
  try { await syncStorageAccount(env, userId, account); } catch (error) { console.warn('S3 initial sync warning:', error?.message || error); }
  return { account, profile: { email, provider: 's3' } };
}

export async function accountsRoutes(app) {
  app.use('/api/accounts/*', async (c, next) => {
    await next();
    if (c.res.status < 400 || c.res.status === 302) return;
    const contentType = c.res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return;
    const payload = await c.res.clone().json().catch(() => null);
    if (!payload?.error) return;
    if (payload.safe === true) return;
    console.error('[accounts] sanitized error response:', { status: c.res.status, code: payload.code || 'ACCOUNT_OPERATION_FAILED' });
    return c.json({ error: 'Account operation failed', code: payload.code || 'ACCOUNT_OPERATION_FAILED' }, c.res.status);
  });

  app.get('/api/accounts', async (c) => {
    try {
      const user = await requireUser(c);
      const rows = await sql(c.env)`SELECT id,email,provider,total_space,used_space,status,created_at,updated_at FROM cloud_accounts WHERE user_id=${user.id} ORDER BY provider,email`;
      return c.json({ data: rows.map((account) => ({ ...account, total_space: Number(account.total_space), used_space: Number(account.used_space), free_space: Number(account.total_space) - Number(account.used_space) })) });
    } catch (error) { return accountErrorResponse(c, error); }
  });

  for (const provider of ['google', 'onedrive', 'dropbox', 'yandex', 'mega', 's3']) {
    app.get(`/api/accounts/${provider}/status`, async (c) => {
      try { await requireUser(c); return c.json({ data: providerStatus(c.env, provider) }); }
      catch (error) { return accountErrorResponse(c, error, 'Unable to read account status', 'ACCOUNT_STATUS_FAILED'); }
    });
  }

  app.get('/api/accounts/onedrive/connect', async (c) => {
    try { const user = await requireUser(c); const config = oauthConfig(c.env, 'onedrive'); const state = await saveOAuthState(c.env, user.id, 'onedrive'); const url = new URL(`${config.authority}/authorize`); url.searchParams.set('client_id', config.clientId); url.searchParams.set('response_type', 'code'); url.searchParams.set('redirect_uri', config.redirectUri); url.searchParams.set('response_mode', 'query'); url.searchParams.set('scope', ONEDRIVE_SCOPE); url.searchParams.set('state', state); return c.json({ data: { authorizationUrl: url.toString(), state, redirectUri: config.redirectUri } }); }
    catch (error) { return accountErrorResponse(c, error, 'Unable to start OneDrive OAuth', 'ONEDRIVE_OAUTH_START_FAILED'); }
  });

  app.get('/api/accounts/onedrive/callback', async (c) => {
    const frontend = new URL(getSiteUrl(c.env)); frontend.pathname = '/quota';
    try {
      if (c.req.query('error')) throw Object.assign(new Error('OneDrive OAuth denied'), { code: 'ONEDRIVE_OAUTH_DENIED' });
      const userId = await consumeOAuthState(c.env, c.req.query('state') || '', 'onedrive'); const config = oauthConfig(c.env, 'onedrive'); const tokens = await exchangeCode(config, c.req.query('code') || '', { scope: ONEDRIVE_SCOPE }); const profile = await refreshOneDriveProfile(tokens.access_token);
      if (!profile.email) throw new Error('Unable to read OneDrive account email');
      const account = await upsertAccount(c.env, { userId, email: profile.email, provider: 'onedrive', credentials: { provider: 'onedrive', clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, tenantId: c.env.ONEDRIVE_TENANT_ID || 'common', refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token || null, expiresIn: tokens.expires_in || null, scope: tokens.scope || ONEDRIVE_SCOPE, tokenType: tokens.token_type || 'Bearer', driveId: profile.driveId, driveType: profile.driveType }, totalSpace: profile.totalSpace, usedSpace: profile.usedSpace });
      await syncStorageAccount(c.env, userId, account); frontend.searchParams.set('onedrive', 'connected');
    } catch (error) { console.error('[accounts] OneDrive OAuth callback failed:', error); frontend.searchParams.set('onedrive', 'error'); frontend.searchParams.set('message', 'OneDrive OAuth failed'); }
    return c.redirect(frontend.toString());
  });

  app.get('/api/accounts/dropbox/connect', async (c) => {
    try { const user = await requireUser(c); const config = oauthConfig(c.env, 'dropbox'); const state = await saveOAuthState(c.env, user.id, 'dropbox'); const url = new URL('https://www.dropbox.com/oauth2/authorize'); url.searchParams.set('client_id', config.clientId); url.searchParams.set('response_type', 'code'); url.searchParams.set('redirect_uri', config.redirectUri); url.searchParams.set('token_access_type', 'offline'); url.searchParams.set('scope', DROPBOX_SCOPES.join(' ')); url.searchParams.set('state', state); return c.json({ data: { authorizationUrl: url.toString(), state, redirectUri: config.redirectUri } }); }
    catch (error) { return accountErrorResponse(c, error, 'Unable to start Dropbox OAuth', 'DROPBOX_OAUTH_START_FAILED'); }
  });

  app.get('/api/accounts/dropbox/callback', async (c) => {
    const frontend = new URL(getSiteUrl(c.env)); frontend.pathname = '/quota';
    try {
      if (c.req.query('error')) throw Object.assign(new Error('Dropbox OAuth denied'), { code: 'DROPBOX_OAUTH_DENIED' });
      const userId = await consumeOAuthState(c.env, c.req.query('state') || '', 'dropbox'); const config = oauthConfig(c.env, 'dropbox'); const tokens = await exchangeCode({ ...config, tokenUrl: 'https://api.dropboxapi.com/oauth2/token' }, c.req.query('code') || '');
      const profile = await getDropboxProfile(tokens.access_token); if (!profile.email) throw new Error('Unable to read Dropbox account email'); if (!tokens.refresh_token) throw new Error('Dropbox did not return a refresh token. Reconnect with offline access enabled.');
      const account = await upsertAccount(c.env, { userId, email: profile.email, provider: 'dropbox', credentials: { provider: 'dropbox', clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, refreshToken: tokens.refresh_token, accessToken: tokens.access_token || null, expiresIn: tokens.expires_in || null, scope: tokens.scope || DROPBOX_SCOPES.join(' '), tokenType: tokens.token_type || 'bearer', accountId: profile.accountId, displayName: profile.displayName }, totalSpace: profile.totalSpace, usedSpace: profile.usedSpace });
      await syncStorageAccount(c.env, userId, account); frontend.searchParams.set('dropbox', 'connected');
    } catch (error) { console.error('[accounts] Dropbox OAuth callback failed:', error); frontend.searchParams.set('dropbox', 'error'); frontend.searchParams.set('message', 'Dropbox OAuth failed'); }
    return c.redirect(frontend.toString());
  });

  app.get('/api/accounts/yandex/connect', async (c) => {
    try { const user = await requireUser(c); const config = oauthConfig(c.env, 'yandex'); const state = await saveOAuthState(c.env, user.id, 'yandex'); const url = new URL('https://oauth.yandex.com/authorize'); url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', config.clientId); url.searchParams.set('redirect_uri', config.redirectUri); url.searchParams.set('scope', YANDEX_SCOPE); url.searchParams.set('state', state); return c.json({ data: { authorizationUrl: url.toString(), state, redirectUri: config.redirectUri } }); }
    catch (error) { return accountErrorResponse(c, error, 'Unable to start Yandex OAuth', 'YANDEX_OAUTH_START_FAILED'); }
  });

  app.get('/api/accounts/yandex/callback', async (c) => {
    const frontend = new URL(getSiteUrl(c.env)); frontend.pathname = '/quota';
    try {
      if (c.req.query('error')) throw Object.assign(new Error('Yandex OAuth denied'), { code: 'YANDEX_OAUTH_DENIED' });
      const userId = await consumeOAuthState(c.env, c.req.query('state') || '', 'yandex'); const config = oauthConfig(c.env, 'yandex'); const tokens = await exchangeCode({ ...config, tokenUrl: 'https://oauth.yandex.com/token' }, c.req.query('code') || ''); const profile = await getYandexProfile(tokens.access_token); const account = await upsertAccount(c.env, { userId, email: profile.email, provider: 'yandex', credentials: { provider: 'yandex', accessToken: tokens.access_token, refreshToken: tokens.refresh_token || null, clientId: config.clientId, clientSecret: config.clientSecret, expiresIn: tokens.expires_in || null, tokenType: tokens.token_type || 'bearer', displayName: profile.displayName }, totalSpace: profile.totalSpace, usedSpace: profile.usedSpace });
      await syncStorageAccount(c.env, userId, account).catch((error) => console.warn('[yandex] initial sync failed:', error?.message || error)); frontend.searchParams.set('yandex', 'connected');
    } catch (error) { console.error('[accounts] Yandex OAuth callback failed:', error); frontend.searchParams.set('yandex', 'error'); frontend.searchParams.set('message', 'Yandex OAuth failed'); }
    return c.redirect(frontend.toString());
  });

  app.post('/api/accounts/mega/connect', async (c) => {
    try { const user = await requireUser(c); const result = await connectMega(c.env, user.id, await c.req.json().catch(() => ({}))); return c.json({ data: result }); }
    catch (error) { return accountErrorResponse(c, error, 'Unable to connect MEGA', 'MEGA_CONNECTION_FAILED'); }
  });

  app.post('/api/accounts/s3/connect', async (c) => {
    try { const user = await requireUser(c); const result = await connectS3(c.env, user.id, await c.req.json().catch(() => ({}))); return c.json({ data: result }); }
    catch (error) { return accountErrorResponse(c, error, 'Unable to connect S3', 'S3_CONNECTION_FAILED'); }
  });

  app.delete('/api/accounts/:id', async (c) => {
    try {
      const user = await requireUser(c); const accountId = c.req.param('id'); const db = sql(c.env);
      const rows = await db`SELECT id FROM cloud_accounts WHERE id=${accountId} AND user_id=${user.id} LIMIT 1`;
      if (!rows[0]) return c.json({ error: 'Account not found', code:'ACCOUNT_NOT_FOUND' }, 404);
      await db`DELETE FROM file_metadata WHERE cloud_account_id=${accountId} AND user_id=${user.id}`;
      await db`DELETE FROM cloud_accounts WHERE id=${accountId} AND user_id=${user.id}`;
      return c.json({ data: { success: true } });
    } catch (error) { return accountErrorResponse(c, error); }
  });
}
