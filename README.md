# stream-light

A light that tells you whether the stream is on. Zero runtime dependencies, Node.js >= 20, ESM, MIT.

It has two jobs, both built from the same parts:

- **Live signal**: is the broadcast on? Red when live. Read from YouTube (the source of truth), shown on a lamp, a web status board or a webhook. Works as an operator reminder or as an entrance notice at the church door.
- **Camera tally**: program (red) and preview (green) of a switcher input (ATEM, or any push source).

Several lights can run side by side. It runs as a standalone program (`stream-light`) and the same modules are embedded in LCYT (backend and bridge).

> Status: not yet verified against the real YouTube API, a real Tally-MA lamp or a real ATEM. See "Unverified" below.

## Quick start (one live light)

```sh
export YT_VIDEO_ID=<the id of the live video>   # YouTube Mode B (public data)
export YT_API_KEY=<a YouTube Data API key>
export LAMP_HOST=<ip of the Tally-MA lamp>
npx @jsilvanus/stream-light            # or: node bin/stream-light.js
```

The status board is at `http://127.0.0.1:8080/` (loopback by default; set `WEB_HOST=0.0.0.0` to show it on the LAN, there is no login).

Commands: `run` (default), `check` (ask YouTube once and print), `login` (Google login for Mode A), `help`. `--config file.json` or `STREAM_LIGHT_CONFIG` selects a config file.

## YouTube modes

- **Mode B** (video id + API key): `videos.list part=liveStreamingDetails`. Needs the video id of the broadcast.
- **Mode A** (Google login, read-only scope): `liveBroadcasts.list` (active, then upcoming) plus `liveStreams.list` for stream health, so it finds the broadcast by itself and can show DEGRADED and STARTING. Run `stream-light login` once (needs `YT_CLIENT_ID`/`YT_CLIENT_SECRET`, a Google "Desktop app" OAuth client). The refresh token is stored in a file readable only by you.

Polling is every 20 s while live or starting, 60 s otherwise. Quota errors back off.

## States and looks

| Kind | State | Default look |
|---|---|---|
| live-signal | LIVE | red |
| | DEGRADED | amber |
| | STARTING | blue |
| | OFF | dark |
| | UNKNOWN | red, blinking |
| camera | PGM / PRV / OFF / UNKNOWN | red / green / dark / amber blinking |

Override per light with `look: { LIVE: "#ff0000", UNKNOWN: "blink:#ffa000" }`.

**Fail-safe.** A stuck red lamp would lie. Every reading carries a `ttlMs`; outputs fall back to the UNKNOWN look when nothing fresh arrives, and the light re-applies its state every `ttlMs/3`. Two failed polls in a row, or no successful poll for three poll intervals, make the state UNKNOWN. Changes are debounced (two matching polls) except the first reading, recovery from UNKNOWN, DEGRADED and UNKNOWN.

## Config file

```json
{
  "web": { "host": "127.0.0.1", "port": 8080 },
  "youtube": { "clientId": "...", "clientSecret": "...", "apiKey": "..." },
  "lights": [
    { "name": "Door", "kind": "live-signal",
      "source": { "type": "youtube", "mode": "A" },
      "output": { "type": "tally-ma", "host": "192.168.1.50" } },
    { "name": "Camera 1", "kind": "camera",
      "source": { "type": "atem", "host": "192.168.1.60", "input": 1 },
      "output": { "type": "tally-ma", "host": "192.168.1.51" } }
  ]
}
```

Outputs: `tally-ma` (UDP, port 21324), `webhook` (POST JSON), `console`, `web` (status board). ATEM lights need `npm install atem-connection`. A camera light can also take its program input from a host's own software mixer (`source: { type: "lcyt", mixerId, input }`); the host pushes readings, the standalone program does not run this source.

## Library use

Subpath exports: `@jsilvanus/stream-light/core`, `/youtube`, `/push`, `/tally-ma`, `/webhook`, `/console`, `/web`. A light is `createLight({ kind, source, outputs, ... })` with a pull source (`poll()`) or push source (`subscribe(emit)`); outputs receive a `Reading` `{ v:1, state, detail?, checkedAt, ttlMs }`.

## Tally-MA

The lamp is driven locally over UDP (the protocol is taken from the Bitfocus Companion module). Never use the lamp's cloud mode (third-party MQTT broker). stream-light never calls the lamp's reset endpoint.

## Unverified

Written without access to the real services: the YouTube live endpoints, the Tally-MA lamp (whether the init packet is needed, resend interval, interplay with its own tally server software) and ATEM events are covered by fake-server tests only. Check them first on real hardware.

## Development

`npm test` (node:test, no dependencies). See `CLAUDE.md`.

## Licence

MIT, see `LICENSE`.
