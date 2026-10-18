import test from 'node:test';
import assert from 'node:assert/strict';
import { createLight } from '../src/core/light.js';
import { createPushSource } from '../src/sources/push.js';
import { createManualClock, flush } from './helpers/clock.js';

function scriptedSource(steps) {
  const queue = [...steps];
  return { calls: 0, async poll() { this.calls++; const s = queue.length > 1 ? queue.shift() : queue[0]; if (s instanceof Error) throw s; return s; } };
}
function recorder() {
  const seen = [];
  return { seen, name: 'rec', apply(reading, ctx) { seen.push({ state: reading.state, detail: reading.detail, at: ctx.now(), checkedAt: reading.checkedAt }); } };
}

test('first reading shows at once, later changes need two matching polls', async () => {
  const clock = createManualClock();
  const src = scriptedSource([{ state: 'OFF' }, { state: 'LIVE' }, { state: 'LIVE' }]);
  const rec = recorder();
  const changes = [];
  const light = createLight({ kind: 'live-signal', source: src, outputs: [rec], clock, onChange: (r) => changes.push(r.state) });
  light.start(); await flush();
  await flush();
  assert.deepEqual(changes, ['OFF']);
  await clock.advance(60_000);            // idle interval: second poll says LIVE once
  assert.deepEqual(changes, ['OFF']);
  await clock.advance(60_000);            // third poll confirms
  assert.deepEqual(changes, ['OFF', 'LIVE']);
  await light.stop();
});

test('a single odd poll between identical ones does not flip the light', async () => {
  const clock = createManualClock();
  const src = scriptedSource([{ state: 'LIVE' }, { state: 'OFF' }, { state: 'LIVE' }]);
  const changes = [];
  const light = createLight({ kind: 'live-signal', source: src, outputs: [], clock, onChange: (r) => changes.push(r.state) });
  light.start(); await flush();
  await clock.advance(20_000);
  await clock.advance(20_000);
  await clock.advance(20_000);
  assert.deepEqual(changes, ['LIVE']);
  await light.stop();
});

test('DEGRADED shows at once; recovery from UNKNOWN shows at once', async () => {
  const clock = createManualClock();
  const boom = new Error('network down');
  const src = scriptedSource([{ state: 'LIVE' }, { state: 'DEGRADED', detail: 'bad health' }, boom, boom, { state: 'OFF' }]);
  const changes = [];
  const light = createLight({ kind: 'live-signal', source: src, outputs: [], clock, onChange: (r) => changes.push(r.state), onError: () => {} });
  light.start(); await flush();
  await clock.advance(20_000);   // DEGRADED immediately
  assert.deepEqual(changes, ['LIVE', 'DEGRADED']);
  await clock.advance(20_000);   // first failure: still DEGRADED
  assert.deepEqual(changes, ['LIVE', 'DEGRADED']);
  await clock.advance(20_000);   // second failure: UNKNOWN
  assert.deepEqual(changes, ['LIVE', 'DEGRADED', 'UNKNOWN']);
  await clock.advance(20_000);   // answer again: OFF right away, no debounce out of UNKNOWN
  assert.deepEqual(changes, ['LIVE', 'DEGRADED', 'UNKNOWN', 'OFF']);
  await light.stop();
});

test('an invalid state from the source counts as a failure and is reported', async () => {
  const clock = createManualClock();
  const errors = [];
  const src = scriptedSource([{ state: 'PGM' }]);
  const light = createLight({ kind: 'live-signal', source: src, outputs: [], clock, onError: (e) => errors.push(e.message) });
  light.start(); await flush();
  await flush();
  assert.ok(errors.some((m) => m.includes('PGM')));
  await light.stop();
});

test('quota backoff delays the next poll', async () => {
  const clock = createManualClock();
  const quota = Object.assign(new Error('quota'), { backoffMs: 10 * 60_000 });
  const src = scriptedSource([{ state: 'LIVE' }, quota]);
  const light = createLight({ kind: 'live-signal', source: src, outputs: [], clock, onError: () => {} });
  light.start(); await flush();
  await clock.advance(20_000);
  assert.equal(src.calls, 2);
  await clock.advance(5 * 60_000);
  assert.equal(src.calls, 2);       // still backing off
  await clock.advance(5 * 60_000);
  assert.equal(src.calls, 3);
  await light.stop();
});

test('keep-alive re-applies the reading every ttl/3 so outputs do not expire', async () => {
  const clock = createManualClock();
  const src = scriptedSource([{ state: 'LIVE' }]);
  const rec = recorder();
  const light = createLight({ kind: 'live-signal', source: src, outputs: [rec], clock, ttlMs: 15_000, activeMs: 20_000 });
  light.start(); await flush();
  await flush();
  const before = rec.seen.length;
  await clock.advance(10_000);        // two keep-alives (5 s apart), no poll yet
  assert.ok(rec.seen.length >= before + 2);
  assert.ok(rec.seen.every((s) => s.state === 'LIVE'));
  await light.stop();
});

test('a source that stops answering turns the reading UNKNOWN after three intervals', async () => {
  const clock = createManualClock();
  let hang = false;
  const src = { async poll() { if (hang) await new Promise(() => {}); return { state: 'LIVE' }; } };
  const changes = [];
  const light = createLight({ kind: 'live-signal', source: src, outputs: [], clock, ttlMs: 15_000, activeMs: 20_000, onChange: (r) => changes.push(r.state) });
  light.start(); await flush();
  await clock.advance(20_000);
  assert.deepEqual(changes, ['LIVE']);
  hang = true;
  await clock.advance(20_000);        // poll hangs; its timer never reschedules
  await clock.advance(80_000);
  assert.deepEqual(changes, ['LIVE', 'UNKNOWN']);
  await light.stop();
});

test('output errors are reported and never stop the light', async () => {
  const clock = createManualClock();
  const errors = [];
  const bad = { name: 'bad', apply() { throw new Error('lamp unreachable'); } };
  const good = recorder();
  const light = createLight({ kind: 'live-signal', source: scriptedSource([{ state: 'LIVE' }]), outputs: [bad, good], clock, onError: (e, i) => errors.push(`${i.output}:${e.message}`) });
  light.start(); await flush();
  await flush();
  assert.deepEqual(errors, ['bad:lamp unreachable']);
  assert.equal(good.seen[0].state, 'LIVE');
  await light.stop();
});

test('push source: states are shown at once, starting UNKNOWN until it reports', async () => {
  const clock = createManualClock();
  const src = createPushSource();
  const changes = [];
  const light = createLight({ kind: 'camera', source: src, outputs: [], clock, onChange: (r) => changes.push(r.state) });
  light.start(); await flush();
  await flush();
  assert.deepEqual(changes, ['UNKNOWN']);
  src.push({ state: 'PRV' });
  src.push({ state: 'PGM' });
  src.push({ state: 'LIVE' });        // wrong vocabulary, ignored
  await flush();
  assert.deepEqual(changes, ['UNKNOWN', 'PRV', 'PGM']);
  await light.stop();
  src.push({ state: 'OFF' });         // after stop nothing happens
  assert.deepEqual(changes, ['UNKNOWN', 'PRV', 'PGM']);
});

test('stop closes outputs; the loop ends', async () => {
  const clock = createManualClock();
  let closed = 0;
  const out = { name: 'o', apply() {}, close() { closed++; } };
  const light = createLight({ kind: 'live-signal', source: scriptedSource([{ state: 'OFF' }]), outputs: [out], clock });
  light.start(); await flush();
  await flush();
  await light.stop();
  assert.equal(closed, 1);
  assert.equal(clock.pending(), 0);
});

test('source must be pull or push', () => {
  assert.throws(() => createLight({ kind: 'camera', source: {} }), /poll\(\) or subscribe\(\)/);
});
