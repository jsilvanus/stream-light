/**
 * Google OAuth for the standalone program: a read-only scope, a refresh token
 * kept in a file readable only by the owner, and the loopback login flow for
 * installed applications (RFC 8252) with PKCE.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const SKEW_MS = 60_000;

const b64url = (buf) => buf.toString('base64url');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function writePrivate(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

async function tokenRequest(fetchImpl, tokenUrl, params) {
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    // Never echo the response in full: it can carry token material.
    const err = new Error(`Google token endpoint answered ${res.status}${body?.error ? ` (${body.error})` : ''}`);
    err.status = res.status;
    err.grantRevoked = body?.error === 'invalid_grant';
    throw err;
  }
  return body;
}

export function createTokenStore({
  file, clientId, clientSecret,
  fetch: fetchImpl = globalThis.fetch,
  tokenUrl = GOOGLE_TOKEN_URL,
  now = () => Date.now(),
}) {
  let inFlight = null;

  async function refresh(stored) {
    const body = await tokenRequest(fetchImpl, tokenUrl, {
      grant_type: 'refresh_token', refresh_token: stored.refresh_token, client_id: clientId, client_secret: clientSecret,
    });
    const next = { ...stored, access_token: body.access_token, expires_at: now() + Number(body.expires_in ?? 3600) * 1000 };
    if (body.refresh_token) next.refresh_token = body.refresh_token;
    await writePrivate(file, next);
    return next.access_token;
  }

  return {
    async getAccessToken({ forceRefresh = false } = {}) {
      const stored = await readJson(file);
      if (!stored?.refresh_token) throw new Error(`No Google login found in ${file}. Run: stream-light login`);
      if (!forceRefresh && stored.access_token && stored.expires_at - now() > SKEW_MS) return stored.access_token;
      if (!inFlight) inFlight = refresh(stored).finally(() => { inFlight = null; });
      return inFlight;
    },
    async save(tokens) { await writePrivate(file, tokens); },
  };
}

/**
 * Loopback login. Resolves once the user has approved in a browser.
 * `onUrl(url)` must show the URL to the user (print it, open a browser).
 */
export async function login({
  clientId, clientSecret, store, onUrl,
  fetch: fetchImpl = globalThis.fetch,
  authUrl = GOOGLE_AUTH_URL, tokenUrl = GOOGLE_TOKEN_URL,
  scope = YOUTUBE_READONLY_SCOPE, now = () => Date.now(), timeoutMs = 5 * 60_000,
}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  let redirectUri;
  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(ok ? 'Login complete. You can close this window.' : 'Login failed.');
      server.close();
      if (ok) resolve(url.searchParams.get('code'));
      else reject(new Error(url.searchParams.get('error') || 'login failed (state mismatch)'));
    });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const u = new URL(authUrl);
      u.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope,
        code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
      }).toString();
      onUrl(u.toString());
    });
    const t = setTimeout(() => { server.close(); reject(new Error('login timed out')); }, timeoutMs);
    t.unref?.();
    server.on('close', () => clearTimeout(t));
  });

  const code = await codePromise;
  const body = await tokenRequest(fetchImpl, tokenUrl, {
    grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, code_verifier: verifier,
  });
  if (!body.refresh_token) throw new Error('Google returned no refresh token; revoke the app in your Google account and log in again');
  await store.save({ refresh_token: body.refresh_token, access_token: body.access_token, expires_at: now() + Number(body.expires_in ?? 3600) * 1000, scope });
}
