import http from 'node:http';

/** A tiny HTTP server for tests: `handler(req, url, body) -> { status, json }`. Records requests. */
export async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const out = await handler(req, url, body, requests.length);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}
