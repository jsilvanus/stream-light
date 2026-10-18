import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubeSource, YouTubeError } from '../src/sources/youtube.js';
import { startServer } from './helpers/servers.js';

const NOW = Date.parse('2026-10-18T10:00:00Z');
const iso = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();

function router(table) {
  return (req, url) => {
    const key = `${url.pathname}?${url.searchParams.get('broadcastStatus') ?? url.searchParams.get('id') ?? ''}`;
    const hit = table[key];
    if (!hit) return { status: 404, json: { error: { errors: [{ reason: 'notFound' }] } } };
    return typeof hit === 'function' ? hit(req, url) : { json: hit };
  };
}

const make = (srv, opts) => createYoutubeSource({ baseUrl: srv.url, now: () => NOW, ...opts });

test('constructor validates its options', () => {
  assert.throws(() => createYoutubeSource({ mode: 'X' }), /mode/);
  assert.throws(() => createYoutubeSource({ mode: 'A' }), /getAccessToken/);
  assert.throws(() => createYoutubeSource({ mode: 'B' }), /videoId/);
  assert.throws(() => createYoutubeSource({ mode: 'B', videoId: 'abcdefgh' }), /apiKey or getAccessToken/);
});

test('mode B: videos.list request is pinned, and details map to states', async () => {
  const details = {};
  const srv = await startServer(router({ '/videos?abcdefgh': () => ({ json: { items: [{ liveStreamingDetails: details }] } }) }));
  try {
    const src = make(srv, { mode: 'B', videoId: 'abcdefgh', apiKey: 'KEY' });
    Object.assign(details, { actualStartTime: iso(-5) });
    assert.deepEqual(await src.poll(), { state: 'LIVE', detail: 'broadcast started' });
    const req = srv.requests[0];
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/videos');
    assert.deepEqual(req.params, { part: 'liveStreamingDetails', id: 'abcdefgh', key: 'KEY' });
    assert.equal(req.headers.authorization, undefined);

    Object.assign(details, { actualEndTime: iso(-1) });
    assert.equal((await src.poll()).state, 'OFF');
    for (const k of Object.keys(details)) delete details[k];
    Object.assign(details, { scheduledStartTime: iso(10) });
    assert.equal((await src.poll()).state, 'STARTING');
    for (const k of Object.keys(details)) delete details[k];
    Object.assign(details, { scheduledStartTime: iso(600) });
    assert.equal((await src.poll()).state, 'OFF');
  } finally { await srv.close(); }
});

test('mode B: unknown video is an error, a plain video is OFF', async () => {
  let items = [];
  const srv = await startServer(() => ({ json: { items } }));
  try {
    const src = make(srv, { mode: 'B', videoId: 'abcdefgh', apiKey: 'K' });
    await assert.rejects(src.poll(), /video not found/);
    items = [{}];
    assert.equal((await src.poll()).state, 'OFF');
  } finally { await srv.close(); }
});

const broadcast = (lifeCycleStatus, extra = {}) => ({ id: 'b1', status: { lifeCycleStatus }, contentDetails: { boundStreamId: 's1' }, snippet: {}, ...extra });
const stream = (streamStatus, health) => ({ items: [{ status: { streamStatus, healthStatus: { status: health } } }] });

test('mode A: live broadcast with an active good stream is LIVE; requests are pinned', async () => {
  const srv = await startServer(router({
    '/liveBroadcasts?active': { items: [broadcast('live')] },
    '/liveStreams?s1': stream('active', 'good'),
  }));
  try {
    const src = make(srv, { mode: 'A', getAccessToken: async () => 'TOKEN' });
    assert.equal((await src.poll()).state, 'LIVE');
    const [b, s] = srv.requests;
    assert.equal(b.path, '/liveBroadcasts');
    assert.deepEqual(b.params, { part: 'id,status,contentDetails,snippet', broadcastStatus: 'active', maxResults: '10' });
    assert.equal(b.headers.authorization, 'Bearer TOKEN');
    assert.equal(s.path, '/liveStreams');
    assert.deepEqual(s.params, { part: 'status', id: 's1' });
    assert.equal(srv.requests.length, 2);
  } finally { await srv.close(); }
});

test('mode A: stream health and ingest drive DEGRADED', async () => {
  let health = stream('active', 'bad');
  const srv = await startServer(router({
    '/liveBroadcasts?active': { items: [broadcast('live')] },
    '/liveStreams?s1': () => ({ json: health }),
  }));
  try {
    const src = make(srv, { mode: 'A', getAccessToken: async () => 't' });
    assert.deepEqual(await src.poll(), { state: 'DEGRADED', detail: 'stream health bad' });
    health = stream('active', 'ok');
    assert.equal((await src.poll()).state, 'DEGRADED');
    health = stream('inactive', 'noData');
    assert.deepEqual(await src.poll(), { state: 'DEGRADED', detail: 'broadcast live but stream is inactive' });
    health = { items: [] };
    assert.equal((await src.poll()).state, 'LIVE');
  } finally { await srv.close(); }
});

test('mode A: live without a bound stream is LIVE without a health check', async () => {
  const srv = await startServer(router({ '/liveBroadcasts?active': { items: [{ status: { lifeCycleStatus: 'live' }, contentDetails: {} }] } }));
  try {
    const src = make(srv, { mode: 'A', getAccessToken: async () => 't' });
    assert.equal((await src.poll()).state, 'LIVE');
    assert.equal(srv.requests.length, 1);
  } finally { await srv.close(); }
});

test('mode A: starting, upcoming soon, and off', async () => {
  let active = [broadcast('liveStarting')];
  let upcoming = [];
  const srv = await startServer(router({
    '/liveBroadcasts?active': () => ({ json: { items: active } }),
    '/liveBroadcasts?upcoming': () => ({ json: { items: upcoming } }),
  }));
  try {
    const src = make(srv, { mode: 'A', getAccessToken: async () => 't' });
    assert.equal((await src.poll()).state, 'STARTING');
    active = [];
    upcoming = [broadcast('ready', { snippet: { scheduledStartTime: iso(15) } })];
    assert.equal((await src.poll()).state, 'STARTING');
    upcoming = [broadcast('ready', { snippet: { scheduledStartTime: iso(24 * 60) } })];
    assert.equal((await src.poll()).state, 'OFF');
    upcoming = [];
    assert.deepEqual(await src.poll(), { state: 'OFF', detail: 'no live broadcast' });
  } finally { await srv.close(); }
});

test('a 401 refreshes the token once and retries', async () => {
  const srv = await startServer((req) => (req.headers.authorization === 'Bearer new'
    ? { json: { items: [] } } : { status: 401, json: {} }));
  try {
    const calls = [];
    const src = make(srv, { mode: 'A', getAccessToken: async ({ forceRefresh } = {}) => { calls.push(!!forceRefresh); return forceRefresh ? 'new' : 'old'; } });
    assert.equal((await src.poll()).state, 'OFF');
    assert.deepEqual(calls.slice(0, 2), [false, true]);
  } finally { await srv.close(); }
});

test('quota errors carry a backoff and never leak the token', async () => {
  const srv = await startServer(() => ({ status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } }));
  try {
    const src = make(srv, { mode: 'A', getAccessToken: async () => 'SECRET-TOKEN', quotaBackoffMs: 123_000 });
    await assert.rejects(src.poll(), (err) => {
      assert.ok(err instanceof YouTubeError);
      assert.equal(err.backoffMs, 123_000);
      assert.equal(err.reason, 'quotaExceeded');
      assert.ok(!err.message.includes('SECRET-TOKEN'));
      return true;
    });
  } finally { await srv.close(); }
});

test('other HTTP errors are errors without backoff', async () => {
  const srv = await startServer(() => ({ status: 500, json: {} }));
  try {
    const src = make(srv, { mode: 'A', getAccessToken: async () => 't' });
    await assert.rejects(src.poll(), (err) => err.status === 500 && err.backoffMs === 0);
  } finally { await srv.close(); }
});
