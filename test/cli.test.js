import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/cli/config.js';
import { main } from '../src/cli/main.js';

const sink = () => { const chunks = []; return { write: (s) => chunks.push(s), text: () => chunks.join('') }; };

test('env quick start builds one live-signal light', () => {
  const cfg = loadConfig({ env: { YT_VIDEO_ID: 'dQw4w9WgXcQ', LAMP_HOST: '10.0.0.5', YT_API_KEY: 'k' } });
  assert.equal(cfg.lights.length, 1);
  assert.equal(cfg.lights[0].kind, 'live-signal');
  assert.equal(cfg.lights[0].source.mode, 'B');
  assert.equal(cfg.youtube.apiKey, 'k');
  assert.equal(cfg.web.host, '127.0.0.1');
});

test('file config is validated and clashing lamps are refused', () => {
  const light = (name) => ({ name, kind: 'live-signal', output: { type: 'tally-ma', host: '10.0.0.5' }, source: { type: 'youtube', mode: 'B', videoId: 'dQw4w9WgXcQ' } });
  const read = () => JSON.stringify({ lights: [light('a'), light('b')] });
  assert.throws(() => loadConfig({ env: {}, file: 'x.json', readFile: read }), /same lamp/);
  assert.throws(() => loadConfig({ env: {}, file: 'x.json', readFile: () => JSON.stringify({ lights: [{ name: 'bad' }] }) }), /Invalid configuration/);
  assert.throws(() => loadConfig({ env: {}, file: 'x.json', readFile: () => { throw new Error('nope'); } }), /Cannot read config/);
});

test('help, unknown command and missing lights exit sensibly', async () => {
  const stdout = sink(); const stderr = sink();
  assert.equal(await main(['help'], { env: {}, stdout, stderr }), 0);
  assert.match(stdout.text(), /stream-light/);
  assert.equal(await main(['bogus'], { env: {}, stdout, stderr }), 2);
  assert.equal(await main(['run'], { env: {}, stdout, stderr }), 2);
  assert.match(stderr.text(), /No lights configured/);
  assert.equal(await main(['login'], { env: {}, stdout, stderr }), 2);
});
