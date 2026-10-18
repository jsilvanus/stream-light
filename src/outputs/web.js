/**
 * Web output: a status board served over HTTP.
 *   GET /          a page with one big dot per light
 *   GET /status    JSON
 *   GET /events    Server-Sent Events, one `status` event per change
 *
 * Binds to 127.0.0.1 unless told otherwise. Read-only, no secrets in the output.
 */
import http from 'node:http';
import { effectiveState } from '../core/reading.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createStatusBoard({ clock = { now: () => Date.now() } } = {}) {
  const entries = new Map(); // id -> { id, name, kind, reading, receivedAt, ctx }
  const clients = new Set();

  function snapshot() {
    const now = clock.now();
    return [...entries.values()].map((e) => {
      const state = effectiveState(e.reading, e.receivedAt, now);
      const look = e.ctx.lookFor(state);
      return { id: e.id, name: e.name, kind: e.kind, state, detail: e.reading?.detail ?? null, rgb: look.rgb, blink: look.blink, checkedAt: e.reading?.checkedAt ?? null };
    });
  }

  function broadcast() {
    const data = `event: status\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) { try { res.write(data); } catch { clients.delete(res); } }
  }

  function page() {
    const rows = snapshot().map((l) => {
      const [r, g, b] = l.rgb;
      const dark = r + g + b === 0;
      return `<li><span class="dot${l.blink ? ' blink' : ''}" style="background:${dark ? '#333' : `rgb(${r},${g},${b})`}"></span>`
        + `<span class="name">${esc(l.name)}</span> <span class="state">${esc(l.state)}</span></li>`;
    }).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>Stream light</title><style>body{font:20px system-ui;background:#111;color:#eee;margin:2rem}ul{list-style:none;padding:0}`
      + `li{display:flex;align-items:center;gap:1rem;margin:1rem 0}.dot{width:4rem;height:4rem;border-radius:50%;border:2px solid #555}`
      + `.blink{animation:b 1s steps(2,start) infinite}@keyframes b{to{visibility:hidden}}.state{opacity:.7}</style></head>`
      + `<body><ul>${rows || '<li>No lights</li>'}</ul><script>const es=new EventSource('events');es.addEventListener('status',()=>location.reload());</script></body></html>`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(snapshot()));
    } else if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page());
    } else {
      res.writeHead(404).end();
    }
  });

  return {
    snapshot,
    /** An output for one light. */
    output({ id, name }) {
      return {
        name: 'web',
        apply(reading, ctx) {
          const before = entries.get(id);
          entries.set(id, { id, name, kind: ctx.kind, reading, receivedAt: clock.now(), ctx });
          if (!before || before.reading.state !== reading.state) broadcast();
        },
      };
    },
    listen({ host = '127.0.0.1', port = 8080 } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() {
      for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
      clients.clear();
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}
