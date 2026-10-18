/**
 * Configuration of the standalone program: a JSON file and/or environment.
 *
 * Quick start without a file (one live-signal light, YouTube Mode B):
 *   YT_VIDEO_ID, YT_API_KEY, LAMP_HOST (Tally-MA), optional WEB_PORT
 * Otherwise a file (STREAM_LIGHT_CONFIG or --config):
 *   { "web": { "host": "127.0.0.1", "port": 8080 },
 *     "youtube": { "clientId": "...", "clientSecret": "...", "tokenFile": "...", "apiKey": "..." },
 *     "lights": [ ...light configs, see core/config.js ] }
 * Secrets may also come from the environment: YT_CLIENT_ID, YT_CLIENT_SECRET, YT_API_KEY, YT_TOKEN_FILE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLightConfig, findOutputClash } from '../core/config.js';

export function defaultTokenFile(env = process.env) {
  return env.YT_TOKEN_FILE || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'stream-light', 'youtube-token.json');
}

export function loadConfig({ env = process.env, file, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const configFile = file || env.STREAM_LIGHT_CONFIG;
  let raw = {};
  if (configFile) {
    try { raw = JSON.parse(readFile(configFile)); } catch (err) { throw new Error(`Cannot read config ${configFile}: ${err.message}`); }
  }

  const youtube = {
    clientId: raw.youtube?.clientId || env.YT_CLIENT_ID || '',
    clientSecret: raw.youtube?.clientSecret || env.YT_CLIENT_SECRET || '',
    apiKey: raw.youtube?.apiKey || env.YT_API_KEY || '',
    tokenFile: raw.youtube?.tokenFile || defaultTokenFile(env),
  };
  const web = { host: raw.web?.host || env.WEB_HOST || '127.0.0.1', port: Number(raw.web?.port ?? env.WEB_PORT ?? 8080) };

  let lights = Array.isArray(raw.lights) ? raw.lights : [];
  if (!lights.length && env.YT_VIDEO_ID && env.LAMP_HOST) {
    lights = [{ name: 'Live', kind: 'live-signal', output: { type: 'tally-ma', host: env.LAMP_HOST }, source: { type: 'youtube', mode: 'B', videoId: env.YT_VIDEO_ID } }];
  }

  const errors = [];
  const valid = [];
  lights.forEach((l, i) => {
    const res = validateLightConfig(l);
    if (res.ok) valid.push({ ...res.value, id: res.value.id || `light${i + 1}` });
    else errors.push(...res.errors.map((e) => `lights[${i}]: ${e}`));
  });
  const clash = findOutputClash(valid);
  if (clash) errors.push(`two lights drive the same lamp: ${clash[0]} and ${clash[1]}`);
  if (errors.length) throw new Error(`Invalid configuration:\n  ${errors.join('\n  ')}`);
  return { youtube, web, lights: valid };
}
