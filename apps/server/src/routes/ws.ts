import type { IncomingMessage } from 'node:http';
import type { WebSocket } from '@fastify/websocket';
import { ClientMessageSchema, type Role, type ServerMessage } from '@room-jukebox/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN_COOKIE, presentedAdminToken } from '../auth/admin.ts';
import { hashToken } from '../auth/crypto.ts';
import { sourceIp } from '../auth/gate.ts';
import type { AppContext } from '../context.ts';
import { guestFrom, requireHousehold } from '../context.ts';
import { HttpError, parse } from '../errors.ts';

export const HEARTBEAT_INTERVAL_MS = 5000;
const SWEEP_INTERVAL_MS = 1000;
const MAX_MESSAGE_BYTES = 4096;
const OPEN = 1;

const QuerySchema = z.object({
  role: z.enum(['guest', 'admin', 'player']).optional(),
  player: z.string().optional(),
  token: z.string().optional(),
});

interface Conn {
  socket: WebSocket;
  role: Role;
  guestId: string | null;
  playerId: string | null;
}

type Auth = Omit<Conn, 'socket'> & { playerName: string };

/** Live sockets, projections per role, heartbeats and guest toasts. */
export class WsHub {
  #ctx: AppContext;
  #conns = new Set<Conn>();
  #timers: ReturnType<typeof setInterval>[] = [];

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  start(): void {
    this.#ctx.session.onChange(() => this.broadcastState());
    const hb = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    const sweep = setInterval(() => this.#ctx.session.sweep(), SWEEP_INTERVAL_MS);
    hb.unref();
    sweep.unref();
    this.#timers.push(hb, sweep);
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const c of this.#conns) c.socket.close(1001, 'server closing');
  }

  get size(): number {
    return this.#conns.size;
  }

  send(conn: Conn, msg: ServerMessage): void {
    if (conn.socket.readyState === OPEN) conn.socket.send(JSON.stringify(msg));
  }

  stateFor(conn: Conn): ServerMessage {
    const s = this.#ctx.session;
    switch (conn.role) {
      case 'admin':
        return { type: 'state', state: s.toAdminState() };
      case 'player':
        return { type: 'state', state: s.toPlayerState(conn.playerId as string) };
      case 'guest':
        return { type: 'state', state: s.toGuestState(conn.guestId) };
    }
  }

  broadcastState(): void {
    let admin: string | null = null;
    const guests = new Map<string | null, string>();
    for (const c of this.#conns) {
      if (c.socket.readyState !== OPEN) continue;
      if (c.role === 'admin') {
        admin ??= JSON.stringify(this.stateFor(c));
        c.socket.send(admin);
      } else if (c.role === 'guest') {
        let text = guests.get(c.guestId);
        if (text === undefined) {
          text = JSON.stringify(this.stateFor(c));
          guests.set(c.guestId, text);
        }
        c.socket.send(text);
      } else {
        this.send(c, this.stateFor(c));
      }
    }
  }

  heartbeat(): void {
    const s = this.#ctx.session;
    const text = JSON.stringify({
      type: 'heartbeat',
      serverTime: this.#ctx.now(),
      changeSeq: s.changeSeq,
      revision: s.revision,
    } satisfies ServerMessage);
    for (const c of this.#conns) if (c.socket.readyState === OPEN) c.socket.send(text);
  }

  toastGuest(guestId: string, level: 'info' | 'warn' | 'error', message: string): void {
    for (const c of this.#conns) {
      if (c.role === 'guest' && c.guestId === guestId) {
        this.send(c, { type: 'toast', level, message, ttlMs: level === 'info' ? 4000 : 8000 });
      }
    }
  }

  add(conn: Conn): void {
    this.#conns.add(conn);
  }

  delete(conn: Conn): void {
    this.#conns.delete(conn);
  }
}

/** Authenticates a `/ws?role=` upgrade (throws 400/401/403 before the upgrade). */
function authenticate(ctx: AppContext, request: FastifyRequest): Auth {
  const q = parse(QuerySchema, request.query);
  const role = q.role ?? 'guest';
  if (role === 'guest') {
    return { role, guestId: guestFrom(ctx, request), playerId: null, playerName: '' };
  }
  requireHousehold(ctx, request);
  if (role === 'admin') {
    const token = q.token ?? presentedAdminToken(request)?.token ?? request.cookies[ADMIN_COOKIE];
    if (!ctx.auth.isValid(token))
      throw new HttpError(401, 'unauthorized', 'Sign in as the owner first.');
    return { role, guestId: null, playerId: null, playerName: '' };
  }
  const player = q.token ? ctx.repos.players.findByTokenHash(hashToken(q.token)) : null;
  if (player === null || (q.player !== undefined && q.player !== player.deviceId)) {
    throw new HttpError(401, 'unauthorized', 'This TV is not paired with the hub.');
  }
  return { role, guestId: null, playerId: player.deviceId, playerName: player.name };
}

export type SpikeWsHandler = (socket: WebSocket, request: FastifyRequest) => void;

/**
 * `GET /ws?role=guest|admin|player`. With the M0 spike enabled, a socket without `role` goes to
 * the spike handler instead.
 */
export async function registerWs(
  app: FastifyInstance,
  ctx: AppContext,
  hub: WsHub,
  spike?: SpikeWsHandler,
): Promise<void> {
  const auths = new WeakMap<IncomingMessage, Auth>();

  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request) => {
        const role = (request.query as Record<string, unknown> | undefined)?.role;
        if (spike && role === undefined) return;
        auths.set(request.raw, authenticate(ctx, request));
      },
    },
    (socket, request) => {
      const auth = auths.get(request.raw);
      if (auth === undefined) {
        if (spike) return spike(socket, request);
        socket.close(1008, 'unauthorized');
        return;
      }
      const conn: Conn = {
        socket,
        role: auth.role,
        guestId: auth.guestId,
        playerId: auth.playerId,
      };
      hub.add(conn);
      hub.send(conn, hub.stateFor(conn));
      if (conn.role === 'player') {
        ctx.session.playerConnected(auth.playerId as string, auth.playerName, sourceIp(request));
      }

      const bye = () => {
        hub.send(conn, { type: 'bye', reason: 'bad-message' });
        socket.close(1008, 'bad-message');
      };

      socket.on('message', (raw: Buffer) => {
        if (raw.length > MAX_MESSAGE_BYTES) return bye();
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return bye();
        }
        const parsed = ClientMessageSchema.safeParse(data);
        if (!parsed.success) return bye();
        const msg = parsed.data;
        const playerId = conn.playerId;
        if (msg.type === 'ping') {
          hub.send(conn, { type: 'pong', t0: msg.t0, serverTime: ctx.now() });
          if (playerId !== null) ctx.session.playerSeen(playerId);
          return;
        }
        if (conn.role !== 'player' || playerId === null) return bye();
        try {
          if (msg.type === 'position') {
            ctx.session.position(playerId, msg.position, msg.playerState, msg.revision);
          } else {
            ctx.session.event(playerId, msg.kind, msg.revision, msg.code);
          }
        } catch (err) {
          app.log.error({ err }, 'player message failed');
        }
      });

      socket.on('close', () => {
        hub.delete(conn);
        if (conn.playerId !== null) ctx.session.playerDisconnected(conn.playerId);
      });
    },
  );
}
