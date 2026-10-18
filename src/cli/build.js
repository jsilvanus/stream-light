/** Turn a validated light config into a running light. */
import { createLight } from '../core/light.js';
import { createYoutubeSource } from '../sources/youtube.js';
import { createAtemSource } from '../sources/push.js';
import { createTallyMaOutput } from '../outputs/tally-ma.js';
import { createWebhookOutput } from '../outputs/webhook.js';
import { createConsoleOutput } from '../outputs/console.js';

export async function buildLight(cfg, { board, getAccessToken, apiKey, fetch, createAtem, log = console.log, onError = () => {}, clock } = {}) {
  let source;
  if (cfg.source.type === 'youtube') {
    const useToken = cfg.source.mode === 'A' || (!apiKey && getAccessToken);
    source = createYoutubeSource({
      mode: cfg.source.mode, videoId: cfg.source.videoId, fetch,
      getAccessToken: useToken ? getAccessToken : undefined, apiKey: useToken ? undefined : apiKey,
    });
  } else if (cfg.source.type === 'atem') {
    if (!cfg.source.host) throw new Error(`light "${cfg.name}": source.host is required for an ATEM in the standalone program`);
    const { atem, isConnected } = await createAtem(cfg.source.host);
    source = createAtemSource({ atem, input: cfg.source.input, meIndex: cfg.source.meIndex, isConnected });
  } else {
    throw new Error(`light "${cfg.name}": source type ${cfg.source.type} is not supported by the standalone program yet`);
  }

  const outputs = [createConsoleOutput({ label: cfg.name, log })];
  if (cfg.output.type === 'tally-ma') outputs.push(createTallyMaOutput({ host: cfg.output.host, port: cfg.output.port, onError, clock }));
  else if (cfg.output.type === 'webhook') outputs.push(createWebhookOutput({ url: cfg.output.url, lightId: cfg.id, name: cfg.name, fetch, onError }));
  if (board) outputs.push(board.output({ id: cfg.id, name: cfg.name }));

  return createLight({ kind: cfg.kind, source, outputs, look: cfg.look, ttlMs: cfg.ttlMs, activeMs: cfg.activeMs, idleMs: cfg.idleMs, clock, onError });
}
