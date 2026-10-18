# stream-light

Zero-dependency Node.js (>=20) ESM package, MIT. A status light: live-signal (YouTube) or camera tally (switcher). One package, subpath exports; also vendored into LCYT (`packages/plugins/lcyt-tally/vendor/stream-light`) until it is on npm, so keep `src/core`, `src/sources`, `src/outputs` free of Node-app assumptions and of imports outside the package.

- `src/core`: states/looks, `Reading` contract (receivers compute their deadline from receipt time + `ttlMs`, never from `checkedAt`), config validation, `createLight` (poll or push source; debounce, failure to UNKNOWN, staleness, periodic re-apply).
- `src/sources`: `youtube.js` (Mode A/B, injectable fetch and token), `push.js` (ATEM/OBS mappings).
- `src/outputs`: `tally-ma`, `webhook`, `console`, `web`. Outputs must fall back to the UNKNOWN look when readings stop.
- `src/cli`: standalone program (config, OAuth loopback+PKCE, commands).
- Tests: `npm test`; clocks and servers are injected (`test/helpers`). No real network in tests.
- Never log tokens, API keys or cookie material. Never call the Tally-MA lamp's reset endpoint or enable its cloud mode.
- Everything is unverified against the real YouTube API, Tally-MA lamp and ATEM; say so in docs when touching those.
