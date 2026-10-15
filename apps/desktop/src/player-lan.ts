import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { M2_PROTOCOL_VERSION } from '@room-jukebox/shared';
import type { HubJson } from '@room-jukebox/shared';

/**
 * Player mode's listener on LAN_PORT (plan §3.2): `GET /hub.json` (open CORS) and 302 redirects
 * of `/`, `/r/*` and `/admin` to the current hub, so a phone that scans the wrong laptop still
 * lands on the party.
 *
 * ADAPTER: the server lane adds `buildApp({ mode: 'player', hub })`. At this lane's base that
 * option does not exist (buildApp would start a full hub), so `startPlayerLan` builds it, probes
 * `GET /hub.json` with `inject`, and falls back to the local stub below when the probe fails.
 * After the merge the probe succeeds and the stub is dead code that can be deleted.
 */

/** Read live: the page can change the hub address (manual entry) without a restart. */
export interface PlayerHubView {
  /** Hub base URL, `http://<host>:<port>`. */
  readonly address: string;
  readonly epoch: number;
  readonly roomName: string;
  /** False until the page verified the hub's `authOk` (contract §1): `/hub.json` answers 503. */
  readonly verified: boolean;
}

export interface LanListener {
  kind: 'server' | 'stub';
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

interface FastifyLike {
  inject(opts: {
    method: 'GET';
    url: string;
  }): Promise<{ statusCode: number; headers: Record<string, unknown> }>;
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<unknown>;
}

export function hubJson(hub: PlayerHubView): HubJson {
  return {
    hubAddress: hub.address,
    hubEpoch: hub.epoch,
    protocolVersion: M2_PROTOCOL_VERSION,
    roomName: hub.roomName,
  };
}

/** The redirect target for `path`, or null when the stub does not redirect it. */
export function redirectTarget(hub: PlayerHubView, path: string): string | null {
  const pathname = path.split('?')[0] ?? '/';
  if (
    pathname === '/' ||
    pathname.startsWith('/r/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  ) {
    return `${hub.address}${path}`;
  }
  return null;
}

export function startStubLan(hub: PlayerHubView): LanListener {
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (path.split('?')[0] === '/hub.json') {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      };
      if (!hub.verified) {
        res.writeHead(503, headers).end(JSON.stringify({ error: { code: 'not-joined' } }));
        return;
      }
      res.writeHead(200, headers).end(JSON.stringify(hubJson(hub)));
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"mode":"player"}');
      return;
    }
    const target = hub.verified ? redirectTarget(hub, path) : null;
    if (target) {
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' }).end();
      return;
    }
    res.writeHead(404).end();
  });
  return {
    kind: 'stub',
    listen: (port, host) =>
      new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => {
          server.off('error', fail);
          ok();
        });
      }),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

export async function startPlayerLan(p: {
  hub: PlayerHubView;
  build?: (options: { mode: 'player'; hub: PlayerHubView }) => Promise<FastifyLike>;
  warn: (message: string) => void;
}): Promise<LanListener> {
  if (p.build) {
    try {
      const app = await p.build({ mode: 'player', hub: p.hub });
      const probe = await app.inject({ method: 'GET', url: '/hub.json' });
      // A JSON answer (200, or 503 before the hub is verified) means the player route set is
      // there; a full hub answers 404 or the SPA's HTML.
      const type = String(probe.headers['content-type'] ?? '');
      if ((probe.statusCode === 200 || probe.statusCode === 503) && type.includes('json')) {
        return {
          kind: 'server',
          listen: async (port, host) => {
            await app.listen({ port, host });
          },
          close: async () => {
            await app.close();
          },
        };
      }
      await app.close();
      p.warn(`buildApp has no player mode (GET /hub.json → ${probe.statusCode}); using the stub`);
    } catch (err) {
      p.warn(`buildApp({ mode: 'player' }) failed: ${String(err)}; using the stub`);
    }
  }
  return startStubLan(p.hub);
}
