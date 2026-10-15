import type { IncomingMessage } from 'node:http';
import type { WebSocket } from '@fastify/websocket';
import {
  AuthMessageSchema,
  ClientMessageSchema,
  type M2ServerMessage,
  type Role,
  type ServerMessage,
} from '@room-jukebox/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN_COOKIE, presentedAdminToken } from '../auth/admin.ts';
import { hashToken } from '../auth/crypto.ts';
import { sourceIp } from '../auth/gate.ts';
import { FailureThrottle } from '../auth/throttle.ts';
import type { AppContext } from '../context.ts';
import { guestFrom, requireHousehold } from '../context.ts';
import { HttpError, parse } from '../errors.ts';
import { joinAckProof, joinProofParts, newNonce, verifyProof } from '../household.ts';
import { dialledAddress } from '../lan.ts';
import { REPLICA_DEBOUNCE_MS, REPLICA_INTERVAL_MS } from '../replica.ts';
import { isLocalPlayer } from '../session/groups.ts';
import type { Session } from '../session/session.ts';

export const HEARTBEAT_INTERVAL_MS = 5000;
/** A player socket must send `auth` within this window. */
export const PLAYER_AUTH_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 1000;
const MAX_MESSAGE_BYTES = 4096;
const OPEN = 1;
const SEEN_NONCES = 2000;

const QuerySchema = z.object({
  role: z.enum(['guest', 'admin', 'player']).optional(),
  player: z.string().optional(),
  token: z.string().optional(),
  /** Guests and admins: the group the page acts on (default main). */
  group: z.string().optional(),
});

/**
 * `replicaAck { snapshotAt }` (player → hub) acknowledges a `replica` message. Server-local until
 * `packages/shared` adds it to **M2ClientMessage** (contract-m2 "Lane clarifications").
 */
export const ReplicaAckMessageSchema = z.object({
  type: z.literal('replicaAck'),
  snapshotAt: z.number().int().nonnegative(),
});

const PlayerMessageSchema = z.union([ClientMessageSchema, ReplicaAckMessageSchema]);

interface Conn {
  socket: WebSocket;
  role: Role;
  guestId: string | null;
  playerId: string | null;
  /** Guests and admins: the requested group (resolved on every send). */
  groupId: string | null;
  /** Players: true after a valid `auth`. Others: always true. */
  authed: boolean;
}

type Auth = Omit<Conn, 'socket' | 'authed'> & { playerName: string };

/** Live sockets, projections per role and group, heartbeats, toasts, rekey and replication. */
export class WsHub {
  #ctx: AppContext;
  #conns = new Set<Conn>();
  #timers: ReturnType<typeof setInterval>[] = [];
  #replicaTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  start(): void {
    const { groups } = this.#ctx;
    groups.onChange((groupId) => {
      this.broadcastGroup(groupId);
      this.scheduleReplica();
    });
    groups.onPlayFailure((f) => {
      const guestId = f.entry?.requester?.guestId;
      if (f.entry && guestId) {
        this.toastGuest(
          guestId,
          'warn',
          `Couldn't play ${f.entry.title}: ${f.reason}. It was skipped.`,
        );
      }
      if (f.stopped) {
        this.toastAdmins(
          'error',
          `Playback stopped after repeated failures (${f.reason}). Press Start Music to resume.`,
        );
      }
    });
    const hb = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    const sweep = setInterval(() => groups.sweep(), SWEEP_INTERVAL_MS);
    const replica = setInterval(() => this.sendReplicas(), REPLICA_INTERVAL_MS);
    hb.unref();
    sweep.unref();
    replica.unref();
    this.#timers.push(hb, sweep, replica);
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    if (this.#replicaTimer) clearTimeout(this.#replicaTimer);
    this.#replicaTimer = null;
    for (const c of this.#conns) c.socket.close(1001, 'server closing');
  }

  get size(): number {
    return this.#conns.size;
  }

  send(conn: Conn, msg: ServerMessage | M2ServerMessage): void {
    if (conn.socket.readyState === OPEN) conn.socket.send(JSON.stringify(msg));
  }

  sessionFor(conn: Conn): Session {
    const { groups } = this.#ctx;
    return conn.role === 'player'
      ? groups.sessionOfPlayer(conn.playerId as string)
      : groups.resolve(conn.groupId);
  }

  stateFor(conn: Conn): ServerMessage {
    switch (conn.role) {
      case 'admin':
        return { type: 'state', state: this.#ctx.groups.adminState(conn.groupId) };
      case 'player':
        return {
          type: 'state',
          state: this.sessionFor(conn).toPlayerState(conn.playerId as string),
        };
      case 'guest':
        return { type: 'state', state: this.sessionFor(conn).toGuestState(conn.guestId) };
    }
  }

  /** Sends `state` to every socket that shows `groupId` (admins always). */
  broadcastGroup(groupId: string): void {
    const admin = new Map<string | null, string>();
    const guests = new Map<string, string>();
    for (const c of this.#conns) {
      if (c.socket.readyState !== OPEN || !c.authed) continue;
      if (c.role === 'admin') {
        let text = admin.get(c.groupId);
        if (text === undefined) {
          text = JSON.stringify(this.stateFor(c));
          admin.set(c.groupId, text);
        }
        c.socket.send(text);
        continue;
      }
      const session = this.sessionFor(c);
      if (session.groupId !== groupId && c.groupId !== groupId) continue;
      if (c.role === 'guest') {
        const key = `${session.groupId}\u0000${c.guestId ?? ''}`;
        let text = guests.get(key);
        if (text === undefined) {
          text = JSON.stringify(this.stateFor(c));
          guests.set(key, text);
        }
        c.socket.send(text);
      } else {
        this.send(c, this.stateFor(c));
      }
    }
  }

  /** Every group. */
  broadcastState(): void {
    for (const s of this.#ctx.groups.sessions()) this.broadcastGroup(s.groupId);
  }

  heartbeat(): void {
    const now = this.#ctx.now();
    for (const c of this.#conns) {
      if (c.socket.readyState !== OPEN || !c.authed) continue;
      const s = this.sessionFor(c);
      this.send(c, {
        type: 'heartbeat',
        serverTime: now,
        changeSeq: s.changeSeq,
        revision: s.revision,
      });
    }
  }

  toastGuest(guestId: string, level: 'info' | 'warn' | 'error', message: string): void {
    for (const c of this.#conns) {
      if (c.role === 'guest' && c.guestId === guestId) {
        this.send(c, { type: 'toast', level, message, ttlMs: level === 'info' ? 4000 : 8000 });
      }
    }
  }

  /** Every connected page (guests, admins, players), e.g. the 'Updating in 15 s' notice. */
  toastAll(level: 'info' | 'warn' | 'error', message: string, ttlMs = 6000): void {
    for (const c of this.#conns) {
      if (c.authed) this.send(c, { type: 'toast', level, message, ttlMs });
    }
  }

  toastAdmins(level: 'info' | 'warn' | 'error', message: string): void {
    for (const c of this.#conns) {
      if (c.role === 'admin') {
        this.send(c, { type: 'toast', level, message, ttlMs: level === 'info' ? 4000 : 8000 });
      }
    }
  }

  #remotePlayers(): Conn[] {
    return [...this.#conns].filter(
      (c) =>
        c.role === 'player' &&
        c.authed &&
        c.playerId !== null &&
        !isLocalPlayer(c.playerId) &&
        c.socket.readyState === OPEN,
    );
  }

  /** Closes every socket of `deviceId` with `bye { reason }`. */
  closePlayer(deviceId: string, reason: string): void {
    for (const c of this.#conns) {
      if (c.role === 'player' && c.playerId === deviceId) {
        this.send(c, { type: 'bye', reason });
        c.socket.close(1008, reason);
      }
    }
  }

  /**
   * Household key rotation: `rekey` to every other authenticated remote player (they store it,
   * then reconnect with proofs under the new key), then their sockets close. `revoked` gets
   * `bye { reason: 'revoked' }` and no key. The hub's own TV is in-process and keeps its socket.
   */
  rekey(householdKey: string, keyEpoch: number, revoked?: string): void {
    if (revoked !== undefined) this.closePlayer(revoked, 'revoked');
    const targets = this.#remotePlayers().filter((c) => c.playerId !== revoked);
    for (const c of targets) this.send(c, { type: 'rekey', householdKey, keyEpoch });
    for (const c of targets) {
      this.send(c, { type: 'bye', reason: 'rekey' });
      c.socket.close(1012, 'rekey');
    }
  }

  /** Batches changes into one extra snapshot. */
  scheduleReplica(): void {
    if (this.#replicaTimer !== null) return;
    this.#replicaTimer = setTimeout(() => {
      this.#replicaTimer = null;
      this.sendReplicas();
    }, REPLICA_DEBOUNCE_MS);
    this.#replicaTimer.unref();
  }

  /** A `replica` snapshot to every authenticated remote player. Returns the number sent. */
  sendReplicas(): number {
    const targets = this.#remotePlayers();
    if (targets.length === 0) return 0;
    const { replica } = this.#ctx;
    const base = replica.build();
    let bytes = 0;
    for (const c of targets) {
      const text = replica.messageFor(base, c.playerId as string);
      bytes = Math.max(bytes, Buffer.byteLength(text));
      c.socket.send(text);
    }
    replica.sent(bytes);
    return targets.length;
  }

  add(conn: Conn): void {
    this.#conns.add(conn);
  }

  delete(conn: Conn): void {
    this.#conns.delete(conn);
  }
}

/** Authenticates a `/ws?role=` upgrade (throws 400/401/403/429 before the upgrade). */
function authenticate(ctx: AppContext, request: FastifyRequest, throttle: FailureThrottle): Auth {
  const q = parse(QuerySchema, request.query);
  const role = q.role ?? 'guest';
  const groupId = q.group ?? null;
  if (role === 'guest') {
    return { role, guestId: guestFrom(ctx, request), playerId: null, playerName: '', groupId };
  }
  requireHousehold(ctx, request);
  if (role === 'admin') {
    const token = q.token ?? presentedAdminToken(request)?.token ?? request.cookies[ADMIN_COOKIE];
    if (!ctx.auth.isValid(token))
      throw new HttpError(401, 'unauthorized', 'Sign in as the owner first.');
    return { role, guestId: null, playerId: null, playerName: '', groupId };
  }
  const wait = throttle.waitMs(sourceIp(request));
  if (wait > 0) {
    throw new HttpError(
      429,
      'auth-throttled',
      'Too many failed player sign-ins. Wait a moment.',
      Math.ceil(wait / 1000),
    );
  }
  const player = q.token ? ctx.repos.players.findByTokenHash(hashToken(q.token)) : null;
  if (player === null || (q.player !== undefined && q.player !== player.deviceId)) {
    throw new HttpError(401, 'unauthorized', 'This TV is not paired with the hub.');
  }
  return {
    role,
    guestId: null,
    playerId: player.deviceId,
    playerName: player.name,
    groupId: null,
  };
}

/** Recently used `(deviceId, nonceP)` pairs: an `auth` message is good for one socket. */
class NonceLog {
  #seen = new Set<string>();
  /** True when new (and records it). */
  add(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > SEEN_NONCES) {
      const first = this.#seen.values().next().value;
      if (first !== undefined) this.#seen.delete(first);
    }
    return true;
  }
}

/**
 * True when `proof` is the join proof for `deviceId`/`nonceP` under the current household key,
 * bound to the address and port the player dialled (the upgrade request's `Host`).
 */
export function checkJoinProof(
  ctx: AppContext,
  msg: { deviceId: string; nonceP: string; proof: string },
  dialled: { hubAddress: string; hubPort: number },
): boolean {
  if (dialled.hubAddress === '') return false;
  return verifyProof(
    ctx.household.keys().playerProof,
    joinProofParts({
      deviceId: msg.deviceId,
      hubId: ctx.settings.data().hubId,
      nonceP: msg.nonceP,
      ...dialled,
    }),
    msg.proof,
  );
}

export type SpikeWsHandler = (socket: WebSocket, request: FastifyRequest) => void;

/**
 * `GET /ws?role=guest|admin|player`. Player sockets must send `auth` first (contract-m2 §1).
 * With the M0 spike enabled, a socket without `role` goes to the spike handler instead.
 */
export async function registerWs(
  app: FastifyInstance,
  ctx: AppContext,
  hub: WsHub,
  spike?: SpikeWsHandler,
): Promise<void> {
  const auths = new WeakMap<IncomingMessage, Auth>();
  const throttle = new FailureThrottle(ctx.repos, ctx.now, 'player-auth');
  const nonces = new NonceLog();

  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request) => {
        const role = (request.query as Record<string, unknown> | undefined)?.role;
        if (spike && role === undefined) return;
        auths.set(request.raw, authenticate(ctx, request, throttle));
      },
    },
    (socket, request) => {
      const auth = auths.get(request.raw);
      if (auth === undefined) {
        if (spike) return spike(socket, request);
        socket.close(1008, 'unauthorized');
        return;
      }
      const ip = sourceIp(request);
      const dialled = dialledAddress(request.headers.host);
      const conn: Conn = {
        socket,
        role: auth.role,
        guestId: auth.guestId,
        playerId: auth.playerId,
        groupId: auth.groupId,
        authed: auth.role !== 'player',
      };
      hub.add(conn);
      let authTimer: ReturnType<typeof setTimeout> | null = null;
      if (conn.authed) {
        hub.send(conn, hub.stateFor(conn));
      } else {
        authTimer = setTimeout(() => {
          hub.send(conn, { type: 'bye', reason: 'auth-timeout' });
          socket.close(1008, 'auth-timeout');
        }, PLAYER_AUTH_TIMEOUT_MS);
        authTimer.unref();
      }

      const bye = (reason = 'bad-message') => {
        hub.send(conn, { type: 'bye', reason });
        socket.close(1008, reason);
      };

      const onAuth = (data: unknown) => {
        if (authTimer) clearTimeout(authTimer);
        authTimer = null;
        const deviceId = conn.playerId as string;
        const parsed = AuthMessageSchema.safeParse(data);
        if (
          !parsed.success ||
          parsed.data.deviceId !== deviceId ||
          !checkJoinProof(ctx, parsed.data, dialled) ||
          !nonces.add(`${deviceId}\u0000${parsed.data.nonceP}`)
        ) {
          throttle.fail(ip);
          ctx.repos.events.append('player.bad-proof', { deviceId }, ctx.now());
          return bye('bad-proof');
        }
        throttle.reset(ip);
        const nonceH = newNonce();
        hub.send(conn, {
          type: 'authOk',
          nonceH,
          proof: joinAckProof(ctx.household.keys().hubProof, {
            hubId: ctx.settings.data().hubId,
            deviceId,
            nonceP: parsed.data.nonceP,
            nonceH,
          }),
        });
        conn.authed = true;
        hub.send(conn, hub.stateFor(conn));
        ctx.groups.roomSeen(deviceId, ip);
        hub.sessionFor(conn).playerConnected(deviceId, auth.playerName, ip);
        if (!isLocalPlayer(deviceId)) hub.scheduleReplica();
      };

      socket.on('message', (raw: Buffer) => {
        const fail = conn.authed ? 'bad-message' : 'bad-proof';
        if (raw.length > MAX_MESSAGE_BYTES) return bye(fail);
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return bye(fail);
        }
        if (!conn.authed) return onAuth(data);
        const parsed = PlayerMessageSchema.safeParse(data);
        if (!parsed.success) return bye();
        const msg = parsed.data;
        const playerId = conn.playerId;
        if (msg.type === 'ping') {
          hub.send(conn, { type: 'pong', t0: msg.t0, serverTime: ctx.now() });
          if (playerId !== null) hub.sessionFor(conn).playerSeen(playerId);
          return;
        }
        if (conn.role !== 'player' || playerId === null) return bye();
        try {
          const session = hub.sessionFor(conn);
          if (msg.type === 'replicaAck') {
            ctx.replica.ack(playerId, msg.snapshotAt);
          } else if (msg.type === 'position') {
            session.position(playerId, msg.position, msg.playerState, msg.revision);
          } else {
            session.event(playerId, msg.kind, msg.revision, msg.code);
          }
        } catch (err) {
          app.log.error({ err }, 'player message failed');
        }
      });

      socket.on('close', () => {
        if (authTimer) clearTimeout(authTimer);
        hub.delete(conn);
        if (conn.playerId !== null && conn.authed) {
          hub.sessionFor(conn).playerDisconnected(conn.playerId);
        }
      });
    },
  );
}
