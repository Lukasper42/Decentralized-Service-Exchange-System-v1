// Lokaler statischer Server für skillx-web. Keine Abhängigkeiten, nur 127.0.0.1.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('Ungültiger Port.');
  process.exit(1);
}
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);
const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https: http://*.onion http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
};

function resolveFile(urlPath) {
  const p = urlPath === '/' ? '/index.html' : urlPath;
  const full = normalize(join(ROOT, p));
  const allowed =
    p === '/index.html' ||
    p === '/styles.css' ||
    (p.startsWith('/dist/') && !p.includes('/tests/') && full.startsWith(join(ROOT, 'dist') + sep));
  return allowed && TYPES.has(extname(full)) ? full : null;
}

createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, HEADERS).end();
      return;
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.includes('\0') ? null : resolveFile(path);
    if (!file) {
      res.writeHead(404, HEADERS).end('Nicht gefunden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES.get(extname(file)) });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, HEADERS).end('Nicht gefunden');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`skillx-web läuft auf http://127.0.0.1:${PORT}`);
});
