import {
  SPIKE_MATRIX,
  SpikeAutoAdvanceBodySchema,
  SpikeClientMessageSchema,
  SpikePlayBodySchema,
  SpikeReportBodySchema,
  SpikeSeekBodySchema,
  type SpikeServerMessage,
} from '@room-jukebox/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { z } from 'zod';
import { SpikeResults } from './results.ts';
import { SpikeSession } from './session.ts';

export const HEARTBEAT_INTERVAL_MS = 5000;
const SWEEP_INTERVAL_MS = 1000;
const OPEN = 1;

export interface SpikeOptions {
  /** Directory for `spike-results.jsonl`. */
  dataDir: string;
  session?: SpikeSession;
  /** Start the first matrix video immediately when nothing is playing. */
  autoplay?: boolean;
}

function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    void reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    return undefined;
  }
  return parsed.data;
}

/**
 * M0 spike routes (`/api/spike/*`) and the spike WebSocket (`/ws`). No auth in M0: anyone on the
 * LAN can drive playback. Replaced by the real session and player auth in M1/M2.
 */
export async function registerSpike(app: FastifyInstance, options: SpikeOptions): Promise<void> {
  const session = options.session ?? new SpikeSession();
  if (options.autoplay && session.snapshot().nowPlaying === null) session.next();
  const results = new SpikeResults(options.dataDir);
  const sockets = new Set<WebSocket>();
  const playerBySocket = new Map<WebSocket, string>();

  const send = (socket: WebSocket, msg: SpikeServerMessage): void => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
  };
  const broadcast = (msg: SpikeServerMessage): void => {
    const text = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === OPEN) s.send(text);
  };

  session.onChange(() => broadcast({ type: 'state', state: session.snapshot() }));

  const heartbeat = setInterval(() => {
    broadcast({ type: 'heartbeat', serverTime: Date.now(), revision: session.revision });
  }, HEARTBEAT_INTERVAL_MS);
  const sweep = setInterval(() => session.sweep(), SWEEP_INTERVAL_MS);
  heartbeat.unref();
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    clearInterval(sweep);
    for (const s of sockets) s.close(1001, 'server closing');
  });

  app.get('/api/spike/state', async () => session.snapshot());
  app.get('/api/spike/matrix', async () => SPIKE_MATRIX);

  app.post('/api/spike/play', async (request, reply) => {
    const body = parseBody(SpikePlayBodySchema, request.body, reply);
    if (!body) return reply;
    return session.play(body.videoId, body.title);
  });
  app.post('/api/spike/auto-advance', async (request, reply) => {
    const body = parseBody(SpikeAutoAdvanceBodySchema, request.body, reply);
    if (!body) return reply;
    return session.setAutoAdvance(body.enabled);
  });
  app.post('/api/spike/pause', async () => session.pause());
  app.post('/api/spike/resume', async () => session.resume());
  app.post('/api/spike/next', async () => session.next());
  app.post('/api/spike/seek', async (request, reply) => {
    const body = parseBody(SpikeSeekBodySchema, request.body, reply);
    if (!body) return reply;
    return session.seek(body.position);
  });

  app.post('/api/spike/report', async (request, reply) => {
    const body = parseBody(SpikeReportBodySchema, request.body, reply);
    if (!body) return reply;
    const player = session.player(body.playerId);
    await results.append({
      ts: Date.now(),
      ...body,
      ...(player ? { playerName: player.name, origin: player.origin } : {}),
    });
    return { ok: true };
  });
  app.get('/api/spike/results', async () => results.list());
  app.delete('/api/spike/results', async () => {
    await results.clear();
    return { ok: true };
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    sockets.add(socket);
    const headerOrigin = request.headers.origin;
    send(socket, { type: 'state', state: session.snapshot() });

    socket.on('message', (raw: Buffer) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = SpikeClientMessageSchema.safeParse(data);
      if (!parsed.success) return;
      const msg = parsed.data;
      const knownPlayer = playerBySocket.get(socket);
      if (knownPlayer && msg.type === 'ping') session.touch(knownPlayer);
      switch (msg.type) {
        case 'ping':
          send(socket, { type: 'pong', t0: msg.t0, serverTime: Date.now() });
          break;
        case 'hello':
          playerBySocket.set(socket, msg.playerId);
          session.hello(msg.playerId, msg.name, headerOrigin ?? msg.origin ?? 'unknown');
          break;
        case 'position':
          session.position(msg.playerId, msg.position, msg.playerState, msg.revision);
          break;
        case 'event': {
          const { error } = session.event(msg.playerId, msg.kind, msg.revision, msg.code);
          if (error) {
            void results
              .append({
                ts: Date.now(),
                playerId: error.playerId,
                playerName: error.playerName,
                origin: error.origin,
                videoId: error.videoId,
                event: 'error',
                ...(error.code !== undefined ? { code: error.code } : {}),
                note: `reported by player at revision ${error.revision}`,
              })
              .catch((err: unknown) => app.log.error(err, 'failed to record spike error'));
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      const playerId = playerBySocket.get(socket);
      playerBySocket.delete(socket);
      if (playerId && ![...playerBySocket.values()].includes(playerId)) {
        session.disconnect(playerId);
      }
    });
  });
}
