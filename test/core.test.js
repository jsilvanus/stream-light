import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOKS, isState, lookFor, parseHexColor } from '../src/core/states.js';
import { effectiveState, makeReading, parseReading } from '../src/core/reading.js';
import { findOutputClash, validateLightConfig } from '../src/core/config.js';

test('state vocabularies differ per kind', () => {
  assert.ok(isState('live-signal', 'LIVE'));
  assert.ok(!isState('live-signal', 'PGM'));
  assert.ok(isState('camera', 'PRV'));
  assert.ok(!isState('camera', 'LIVE'));
  assert.ok(!isState('nope', 'LIVE'));
});

test('default looks: live is red, unknown blinks, camera preview is green', () => {
  assert.deepEqual(DEFAULT_LOOKS['live-signal'].LIVE, { rgb: [255, 0, 0], blink: false });
  assert.equal(DEFAULT_LOOKS['live-signal'].UNKNOWN.blink, true);
  assert.deepEqual(DEFAULT_LOOKS.camera.PRV.rgb, [0, 255, 0]);
  assert.equal(DEFAULT_LOOKS.camera.UNKNOWN.blink, true);
});

test('lookFor applies string, blink and object overrides, ignores garbage', () => {
  assert.deepEqual(lookFor('live-signal', 'LIVE', { LIVE: '#00ff00' }), { rgb: [0, 255, 0], blink: false });
  assert.deepEqual(lookFor('live-signal', 'OFF', { OFF: 'blink:#101010' }), { rgb: [16, 16, 16], blink: true });
  assert.deepEqual(lookFor('live-signal', 'LIVE', { LIVE: { rgb: [300, -5, 7.4], blink: 1 } }), { rgb: [255, 0, 7], blink: true });
  assert.deepEqual(lookFor('live-signal', 'LIVE', { LIVE: 'red' }), DEFAULT_LOOKS['live-signal'].LIVE);
  assert.equal(parseHexColor('#ABCDEF')[0], 0xab);
  assert.equal(parseHexColor('xyz'), null);
});

test('reading: deadman turns an old reading into UNKNOWN by receipt time, not checkedAt', () => {
  const r = makeReading({ state: 'LIVE', checkedAt: 5, ttlMs: 15000 });
  // checkedAt is on the sender's clock and is ignored; only receipt time counts
  assert.equal(effectiveState(r, 1_000_000, 1_010_000), 'LIVE');
  assert.equal(effectiveState(r, 1_000_000, 1_015_000), 'LIVE');
  assert.equal(effectiveState(r, 1_000_000, 1_015_001), 'UNKNOWN');
  assert.equal(effectiveState(null, 0, 0), 'UNKNOWN');
});

test('parseReading validates version, state for the kind, ttl and checkedAt', () => {
  const good = { v: 1, state: 'PGM', checkedAt: 1, ttlMs: 5000, detail: 'x' };
  assert.equal(parseReading('camera', good).ok, true);
  assert.equal(parseReading('live-signal', good).ok, false);
  assert.equal(parseReading('camera', { ...good, v: 2 }).ok, false);
  assert.equal(parseReading('camera', { ...good, ttlMs: 10 }).ok, false);
  assert.equal(parseReading('camera', { ...good, checkedAt: 'now' }).ok, false);
  assert.equal(parseReading('camera', null).ok, false);
  assert.equal(parseReading('camera', { ...good, detail: 'y'.repeat(500) }).reading.detail.length, 200);
});

const live = () => ({
  name: 'Door', kind: 'live-signal',
  output: { type: 'tally-ma', host: '192.168.1.50' },
  source: { type: 'youtube', mode: 'A' },
});

test('validateLightConfig accepts a live-signal light and fills defaults', () => {
  const res = validateLightConfig(live());
  assert.equal(res.ok, true);
  assert.equal(res.value.runner, 'auto');
  assert.equal(res.value.enabled, true);
  assert.equal(res.value.output.port, 21324);
});

test('validateLightConfig accepts camera tally with an ATEM source', () => {
  const res = validateLightConfig({ name: 'Cam 1', kind: 'camera', output: { type: 'tally-ma', host: 'tally01.local' }, source: { type: 'atem', host: '10.0.0.5', input: 1 } });
  assert.equal(res.ok, true);
  assert.equal(res.value.source.meIndex, 0);
});

test('validateLightConfig reports every problem', () => {
  const res = validateLightConfig({
    name: ' ', kind: 'camera', runner: 'bridge',
    output: { type: 'tally-ma', host: '999.1.1.1', port: 70000 },
    source: { type: 'youtube' },
    look: { LIVE: '#ff0000', PGM: 'red' },
    ttlMs: 5,
  });
  assert.equal(res.ok, false);
  const text = res.errors.join('\n');
  for (const needle of ['name is required', 'bridgeInstanceId', 'output.host', 'output.port', 'source.type', 'look.LIVE', 'look.PGM', 'ttlMs']) {
    assert.ok(text.includes(needle), `missing error about ${needle}\n${text}`);
  }
});

test('validateLightConfig: mode B needs a video id; webhook needs an http url', () => {
  assert.equal(validateLightConfig({ ...live(), source: { type: 'youtube', mode: 'B' } }).ok, false);
  assert.equal(validateLightConfig({ ...live(), source: { type: 'youtube', mode: 'B', videoId: 'dQw4w9WgXcQ' } }).ok, true);
  assert.equal(validateLightConfig({ ...live(), output: { type: 'webhook', url: 'file:///etc/passwd' } }).ok, false);
  assert.equal(validateLightConfig({ ...live(), output: { type: 'webhook', url: 'https://example.com/hook' } }).ok, true);
});

test('findOutputClash finds two enabled lights on the same lamp', () => {
  const a = validateLightConfig({ ...live(), name: 'A' }).value;
  const b = validateLightConfig({ ...live(), name: 'B' }).value;
  assert.deepEqual(findOutputClash([a, b]), ['A', 'B']);
  assert.equal(findOutputClash([a, { ...b, enabled: false }]), null);
  assert.equal(findOutputClash([a, { ...b, output: { ...b.output, host: '192.168.1.51' } }]), null);
});
