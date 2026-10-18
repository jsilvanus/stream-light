import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { atemTallyState, obsTallyState, createPushSource, createAtemSource } from '../src/sources/push.js';

const atemState = (program, preview) => ({ video: { mixEffects: [{ programInput: program, previewInput: preview }] } });

test('atemTallyState maps program, preview and other inputs', () => {
  assert.equal(atemTallyState(atemState(1, 2), { input: 1 }), 'PGM');
  assert.equal(atemTallyState(atemState(1, 2), { input: 2 }), 'PRV');
  assert.equal(atemTallyState(atemState(1, 2), { input: 3 }), 'OFF');
  assert.equal(atemTallyState({}, { input: 1 }), null);
  assert.equal(atemTallyState(atemState(1, 2), { input: 1, meIndex: 4 }), null);
});

test('obsTallyState maps scenes', () => {
  assert.equal(obsTallyState({ program: 'A', preview: 'B' }, 'A'), 'PGM');
  assert.equal(obsTallyState({ program: 'A', preview: 'B' }, 'B'), 'PRV');
  assert.equal(obsTallyState({ program: 'A' }, 'C'), 'OFF');
  assert.equal(obsTallyState({}, 'A'), null);
});

test('push source delivers to subscribers until unsubscribed', () => {
  const src = createPushSource();
  const got = [];
  const off = src.subscribe((r) => got.push(r.state));
  src.push({ state: 'PGM' });
  off();
  src.push({ state: 'OFF' });
  assert.deepEqual(got, ['PGM']);
});

test('atem source emits current state, follows changes and reports disconnects', () => {
  const atem = new EventEmitter();
  atem.state = atemState(1, 2);
  const src = createAtemSource({ atem, input: 2 });
  const got = [];
  const off = src.subscribe((r) => got.push(r.state));
  assert.deepEqual(got, ['PRV']);
  atem.state = atemState(2, 1);
  atem.emit('stateChanged');
  atem.emit('disconnected');
  assert.deepEqual(got, ['PRV', 'PGM', 'UNKNOWN']);
  off();
  atem.emit('stateChanged');
  assert.equal(got.length, 3);
  assert.equal(atem.listenerCount('stateChanged'), 0);
});
