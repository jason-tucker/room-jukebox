import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Player-mode loopback server: serves the bundled SPA on 127.0.0.1 (OS-assigned port) with a
 * history fallback to index.html. The page talks to the hub cross-origin.
 */
export async function startStaticServer(
  webRoot: string,
): Promise<{ port: number; close(): Promise<void> }> {
  const root = resolve(webRoot);
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      let file = resolve(join(root, pathname));
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) {
        // SPA fallback for client-side routes (/tv, /admin); real assets still 404.
        if (extname(pathname) !== '') {
          res.writeHead(404).end();
          return;
        }
        file = join(root, 'index.html');
        info = await stat(file).catch(() => null);
        if (!info?.isFile()) {
          res.writeHead(404).end();
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(file).pipe(res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
