import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { colorPacket, createTallyMaOutput, INIT_PACKET, STREAMING_PACKET } from '../src/outputs/tally-ma.js';
import { createWebhookOutput } from '../src/outputs/webhook.js';
import { createConsoleOutput } from '../src/outputs/console.js';
import { createStatusBoard } from '../src/outputs/web.js';
import { lookFor } from '../src/core/states.js';
import { makeReading } from '../src/core/reading.js';
import { createManualClock, flush } from './helpers/clock.js';

const ctxFor = (kind, look, clock) => ({ kind, now: () => clock.now(), lookFor: (s) => lookFor(kind, s, look) });

function fakeSocketFactory() {
  const sent = [];
  const sock = { send(buf, port, host, cb) { sent.push({ buf: Buffer.from(buf), port, host }); cb?.(); }, close() { sock.closed = true; }, unref() {}, on() {} };
  return { sent, sock, factory: () => sock };
}
const rgbOf = (pkt) => [pkt[2], pkt[3], pkt[4]];

test('colour packet layout: 2, 5 then nine triplets', () => {
  const p = colorPacket([1, 2, 3]);
  assert.equal(p.length, 29);
  assert.deepEqual([...p.subarray(0, 5)], [2, 5, 1, 2, 3]);
  assert.deepEqual([...p.subarray(26)], [1, 2, 3]);
  assert.equal(INIT_PACKET.length, 29);
  assert.deepEqual([...INIT_PACKET.subarray(0, 3)], [2, 255, 0]);
});

test('tally-ma: init first, then the state colour, to the lamp port', async () => {
  const clock = createManualClock();
  const { sent, factory } = fakeSocketFactory();
  const out = createTallyMaOutput({ host: '10.0.0.9', socketFactory: factory, clock });
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 1 }), ctxFor('live-signal', {}, clock));
  assert.equal(sent.length, 2);
  assert.deepEqual([...sent[0].buf], [...INIT_PACKET]);
  assert.deepEqual(rgbOf(sent[1].buf), [255, 0, 0]);
  assert.equal(sent[1].port, 21324);
  assert.equal(sent[1].host, '10.0.0.9');
  await out.close();
});

test('tally-ma: resends every tick; blinking looks alternate', async () => {
  const clock = createManualClock();
  const { sent, factory } = fakeSocketFactory();
  const out = createTallyMaOutput({ host: 'h', socketFactory: factory, clock, tickMs: 500, sendInit: false });
  await out.apply(makeReading({ state: 'OFF', checkedAt: 1 }), ctxFor('live-signal', { OFF: 'blink:#00ff00' }, clock));
  await clock.advance(2000);
  const colours = sent.map((s) => rgbOf(s.buf).join(','));
  assert.equal(colours.length, 5);
  assert.ok(colours.includes('0,255,0') && colours.includes('0,0,0'), colours.join(' '));
  assert.notEqual(colours[1], colours[2]);
  await out.close();
});

test('tally-ma deadman: without a fresh reading the lamp shows the UNKNOWN look', async () => {
  const clock = createManualClock();
  const { sent, factory } = fakeSocketFactory();
  const out = createTallyMaOutput({ host: 'h', socketFactory: factory, clock, tickMs: 1000, sendInit: false });
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 1, ttlMs: 5000 }), ctxFor('live-signal', { UNKNOWN: '#0000ff' }, clock));
  await clock.advance(4000);
  assert.ok(sent.every((s) => rgbOf(s.buf).join() === '255,0,0'));
  await clock.advance(3000);        // past 5 s: UNKNOWN, solid blue as configured
  assert.deepEqual(rgbOf(sent.at(-1).buf), [0, 0, 255]);
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 2, ttlMs: 5000 }), ctxFor('live-signal', {}, clock));
  assert.deepEqual(rgbOf(sent.at(-1).buf), [255, 0, 0]);   // a fresh reading brings it back
  await out.close();
});

test('tally-ma: optional streaming packet only while LIVE', async () => {
  const clock = createManualClock();
  const { sent, factory } = fakeSocketFactory();
  const out = createTallyMaOutput({ host: 'h', socketFactory: factory, clock, sendInit: false, streamingPacket: true });
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 1 }), ctxFor('live-signal', {}, clock));
  assert.ok(sent.some((s) => s.buf.equals(STREAMING_PACKET)));
  sent.length = 0;
  await out.apply(makeReading({ state: 'OFF', checkedAt: 2 }), ctxFor('live-signal', {}, clock));
  assert.ok(!sent.some((s) => s.buf.equals(STREAMING_PACKET)));
  await out.close();
});

test('tally-ma: close shows the UNKNOWN look, dark, or holds; stops ticking', async () => {
  for (const [onClose, expected] of [['unknown', [255, 0, 0]], ['dark', [0, 0, 0]], ['hold', null]]) {
    const clock = createManualClock();
    const { sent, factory, sock } = fakeSocketFactory();
    const out = createTallyMaOutput({ host: 'h', socketFactory: factory, clock, sendInit: false, onClose });
    await out.apply(makeReading({ state: 'OFF', checkedAt: 1 }), ctxFor('live-signal', {}, clock));
    const before = sent.length;
    await out.close();
    if (expected) assert.deepEqual(rgbOf(sent.at(-1).buf), expected, onClose);
    else assert.equal(sent.length, before);
    assert.equal(sock.closed, true);
    assert.equal(clock.pending(), 0);
  }
});

test('tally-ma: send errors are reported, not thrown', async () => {
  const clock = createManualClock();
  const errors = [];
  const sock = { send(b, p, h, cb) { cb(new Error('EHOSTUNREACH')); }, close() {}, unref() {}, on() {} };
  const out = createTallyMaOutput({ host: 'h', socketFactory: () => sock, clock, onError: (e) => errors.push(e.message) });
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 1 }), ctxFor('live-signal', {}, clock));
  assert.ok(errors.includes('EHOSTUNREACH'));
  await out.close();
});

test('tally-ma over a real UDP socket reaches a listener', async () => {
  const server = dgram.createSocket('udp4');
  const got = [];
  server.on('message', (m) => got.push(Buffer.from(m)));
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  const out = createTallyMaOutput({ host: '127.0.0.1', port: server.address().port, tickMs: 20 });
  const clock = createManualClock();
  await out.apply(makeReading({ state: 'LIVE' }), ctxFor('live-signal', {}, clock));
  await new Promise((r) => setTimeout(r, 100));
  await out.close();
  server.close();
  assert.ok(got.length >= 2);
  assert.ok(got.some((b) => b.length === 29 && b[0] === 2 && b[1] === 5 && b[2] === 255));
});

test('webhook posts only on a change of state and retries after a failure', async () => {
  const calls = [];
  let fail = true;
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), method: init.method }); return { ok: !fail, status: fail ? 500 : 200 }; };
  const errors = [];
  const out = createWebhookOutput({ url: 'https://example.com/hook', lightId: 'l1', name: 'Door', fetch, onError: (e) => errors.push(e.message) });
  const ctx = { kind: 'live-signal' };
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 7 }), ctx);
  assert.equal(errors.length, 1);
  fail = false;
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 8 }), ctx);   // retried because the first failed
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 9 }), ctx);   // same state: not sent
  await out.apply(makeReading({ state: 'OFF', checkedAt: 10 }), ctx);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1).body, { lightId: 'l1', name: 'Door', kind: 'live-signal', state: 'OFF', detail: null, checkedAt: 10 });
  assert.equal(calls[0].method, 'POST');
});

test('console prints one line per change', () => {
  const lines = [];
  const out = createConsoleOutput({ label: 'Door', log: (l) => lines.push(l) });
  out.apply(makeReading({ state: 'LIVE', detail: 'stream active' }));
  out.apply(makeReading({ state: 'LIVE' }));
  out.apply(makeReading({ state: 'OFF' }));
  assert.deepEqual(lines, ['[Door] LIVE (stream active)', '[Door] OFF']);
});

test('status board serves page, JSON and events; applies the deadman', async () => {
  const clock = createManualClock();
  const board = createStatusBoard({ clock });
  const out = board.output({ id: 'l1', name: 'Door <b>' });
  await out.apply(makeReading({ state: 'LIVE', checkedAt: 1, ttlMs: 5000 }), ctxFor('live-signal', {}, clock));
  const { address, port } = await board.listen({ port: 0 });
  try {
    const json = await (await fetch(`http://${address}:${port}/status`)).json();
    assert.equal(json[0].state, 'LIVE');
    assert.deepEqual(json[0].rgb, [255, 0, 0]);
    const html = await (await fetch(`http://${address}:${port}/`)).text();
    assert.ok(html.includes('Door &lt;b&gt;') && !html.includes('Door <b>'));
    assert.equal((await fetch(`http://${address}:${port}/nope`)).status, 404);
    assert.equal((await fetch(`http://${address}:${port}/`, { method: 'POST' })).status, 405);
    await clock.advance(6000);
    assert.equal((await (await fetch(`http://${address}:${port}/status`)).json())[0].state, 'UNKNOWN');
  } finally { await board.close(); }
});

test('status board events stream the snapshot', async () => {
  const clock = createManualClock();
  const board = createStatusBoard({ clock });
  const out = board.output({ id: 'l1', name: 'Door' });
  const { address, port } = await board.listen({ port: 0 });
  const ac = new AbortController();
  try {
    const res = await fetch(`http://${address}:${port}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    await out.apply(makeReading({ state: 'OFF', checkedAt: 1 }), ctxFor('live-signal', {}, clock));
    await flush();
    let text = '';
    const dec = new TextDecoder();
    for (let i = 0; i < 3 && !text.includes('"OFF"'); i++) text += dec.decode((await reader.read()).value);
    assert.ok(text.includes('event: status') && text.includes('"state":"OFF"'), text);
  } finally { ac.abort(); await board.close(); }
});
