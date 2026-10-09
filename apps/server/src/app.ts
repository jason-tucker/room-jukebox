import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PROTOCOL_VERSION } from '@room-jukebox/shared';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

/** Loopback origins used by Electron player windows (plan §3.2). */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export interface BuildAppOptions {
  loggerInstance?: FastifyBaseLogger;
  /** Directory of the built SPA. Static serving is skipped when it does not exist. */
  webRoot?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify(
    options.loggerInstance ? { loggerInstance: options.loggerInstance } : { logger: false },
  );

  // YouTube embeds fail (error 153) under `no-referrer`; never use helmet defaults here.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  await app.register(cors, { origin: [LOOPBACK_ORIGIN] });
  await app.register(cookie);
  await app.register(websocket);

  app.get('/healthz', async () => ({
    ok: true,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
  }));

  app.get('/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  });

  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    // SPA history fallback: client-side routes such as /tv and /admin get index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
  }

  return app;
}
