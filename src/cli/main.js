import { loadConfig } from './config.js';
import { buildLight } from './build.js';
import { createTokenStore, login } from './oauth.js';
import { createStatusBoard } from '../outputs/web.js';
import { createYoutubeSource } from '../sources/youtube.js';

const HELP = `stream-light [command] [--config file]

  run     (default) watch the configured lights and drive their lamps
  check   ask YouTube once for every live-signal light and print the state
  login   log in to Google (read-only YouTube access) for YouTube Mode A
  help

Configuration: see README.md. Environment: STREAM_LIGHT_CONFIG, YT_CLIENT_ID,
YT_CLIENT_SECRET, YT_API_KEY, YT_TOKEN_FILE, YT_VIDEO_ID, LAMP_HOST, WEB_HOST, WEB_PORT.
`;

async function defaultCreateAtem(host) {
  let mod;
  try { mod = await import('atem-connection'); } catch { throw new Error('ATEM lights need the "atem-connection" package: npm install atem-connection'); }
  const atem = new mod.Atem();
  let connected = false;
  atem.on('connected', () => { connected = true; });
  atem.on('disconnected', () => { connected = false; });
  atem.on('error', () => {});
  await atem.connect(host);
  return { atem, isConnected: () => connected };
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, createAtem = defaultCreateAtem, signal } = {}) {
  const args = [...argv];
  const configIdx = args.indexOf('--config');
  const file = configIdx >= 0 ? args.splice(configIdx, 2)[1] : undefined;
  const command = args[0] ?? 'run';
  const out = (line) => stdout.write(`${line}\n`);

  if (command === 'help' || command === '--help' || command === '-h') { out(HELP); return 0; }

  let config;
  try { config = loadConfig({ env, file }); } catch (err) { stderr.write(`${err.message}\n`); return 2; }

  const tokenStore = config.youtube.clientId
    ? createTokenStore({ file: config.youtube.tokenFile, clientId: config.youtube.clientId, clientSecret: config.youtube.clientSecret })
    : null;
  const getAccessToken = tokenStore ? (o) => tokenStore.getAccessToken(o) : undefined;

  if (command === 'login') {
    if (!tokenStore) { stderr.write('Set YT_CLIENT_ID and YT_CLIENT_SECRET (a Google OAuth "Desktop app" client) first.\n'); return 2; }
    await login({ clientId: config.youtube.clientId, clientSecret: config.youtube.clientSecret, store: tokenStore, onUrl: (u) => out(`Open this address in a browser and approve read-only access:\n\n${u}\n`) });
    out(`Logged in. Token saved to ${config.youtube.tokenFile}`);
    return 0;
  }

  if (command === 'check') {
    let failed = 0;
    for (const l of config.lights.filter((x) => x.source.type === 'youtube')) {
      const useToken = l.source.mode === 'A' || (!config.youtube.apiKey && getAccessToken);
      const src = createYoutubeSource({ mode: l.source.mode, videoId: l.source.videoId, getAccessToken: useToken ? getAccessToken : undefined, apiKey: useToken ? undefined : config.youtube.apiKey });
      try { const r = await src.poll(); out(`${l.name}: ${r.state}${r.detail ? ` (${r.detail})` : ''}`); } catch (err) { failed += 1; out(`${l.name}: error: ${err.message}`); }
    }
    return failed ? 1 : 0;
  }

  if (command !== 'run') { stderr.write(`Unknown command ${command}\n\n${HELP}`); return 2; }
  if (!config.lights.length) { stderr.write('No lights configured. See README.md.\n'); return 2; }

  const board = createStatusBoard();
  const lights = [];
  for (const cfg of config.lights.filter((l) => l.enabled)) {
    lights.push(await buildLight(cfg, {
      board, getAccessToken, apiKey: config.youtube.apiKey, createAtem,
      log: out, onError: (err, info) => stderr.write(`[${cfg.name}] ${info?.output ?? 'error'}: ${err.message}\n`),
    }));
  }
  const addr = await board.listen(config.web);
  out(`Status page: http://${addr.address}:${addr.port}/`);
  for (const l of lights) l.start();

  await new Promise((resolve) => {
    const stop = () => resolve();
    signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await Promise.all(lights.map((l) => l.stop()));
  await board.close();
  return 0;
}
