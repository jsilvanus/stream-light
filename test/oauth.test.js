import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTokenStore, login } from '../src/cli/oauth.js';
import { startServer } from './helpers/servers.js';

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-oauth-'));
  return path.join(dir, 'sub', 'token.json');
}

test('refreshes an expired token, stores it privately, and reuses a fresh one', async () => {
  const file = await tmpFile();
  let n = 0;
  const srv = await startServer(() => ({ json: { access_token: `at${++n}`, expires_in: 3600 } }));
  let now = 1_000_000;
  const store = createTokenStore({ file, clientId: 'id', clientSecret: 'sec', tokenUrl: `${srv.url}/token`, now: () => now });
  await store.save({ refresh_token: 'rt', access_token: 'old', expires_at: now - 1 });
  assert.equal(await store.getAccessToken(), 'at1');
  assert.equal(await store.getAccessToken(), 'at1');
  assert.equal(srv.requests.length, 1);
  assert.match(srv.requests[0].body, /grant_type=refresh_token/);
  assert.equal(await store.getAccessToken({ forceRefresh: true }), 'at2');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await srv.close();
});

test('concurrent callers share one refresh', async () => {
  const file = await tmpFile();
  const srv = await startServer(async () => { await new Promise((r) => setTimeout(r, 30)); return { json: { access_token: 'x', expires_in: 3600 } }; });
  const store = createTokenStore({ file, clientId: 'id', clientSecret: 's', tokenUrl: `${srv.url}/token` });
  await store.save({ refresh_token: 'rt', expires_at: 0 });
  await Promise.all([store.getAccessToken(), store.getAccessToken(), store.getAccessToken()]);
  assert.equal(srv.requests.length, 1);
  await srv.close();
});

test('missing login and revoked grant give readable errors without echoing the response', async () => {
  const file = await tmpFile();
  const srv = await startServer(() => ({ status: 400, json: { error: 'invalid_grant', secret: 'LEAK' } }));
  const store = createTokenStore({ file, clientId: 'id', clientSecret: 's', tokenUrl: `${srv.url}/token` });
  await assert.rejects(store.getAccessToken(), /stream-light login/);
  await store.save({ refresh_token: 'rt', expires_at: 0 });
  await assert.rejects(store.getAccessToken(), (err) => err.grantRevoked === true && !/LEAK/.test(err.message));
  await srv.close();
});

test('login runs the loopback flow with PKCE and saves the refresh token', async () => {
  const file = await tmpFile();
  const srv = await startServer(() => ({ json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }));
  const store = createTokenStore({ file, clientId: 'id', clientSecret: 's', tokenUrl: `${srv.url}/token` });
  const done = login({
    clientId: 'id', clientSecret: 's', store, tokenUrl: `${srv.url}/token`,
    onUrl: async (u) => {
      const url = new URL(u);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.match(url.searchParams.get('scope'), /youtube\.readonly$/);
      const cb = new URL(url.searchParams.get('redirect_uri'));
      cb.search = new URLSearchParams({ code: 'abc', state: url.searchParams.get('state') }).toString();
      await fetch(cb);
    },
  });
  await done;
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.refresh_token, 'r');
  const body = new URLSearchParams(srv.requests[0].body);
  assert.equal(body.get('code'), 'abc');
  assert.ok(body.get('code_verifier'));
  await srv.close();
});

test('login rejects a callback with the wrong state', async () => {
  const file = await tmpFile();
  const store = createTokenStore({ file, clientId: 'id', clientSecret: 's' });
  const done = login({
    clientId: 'id', clientSecret: 's', store,
    onUrl: async (u) => {
      const cb = new URL(new URL(u).searchParams.get('redirect_uri'));
      cb.search = 'code=abc&state=wrong';
      await fetch(cb);
    },
  });
  await assert.rejects(done, /state mismatch/);
});
