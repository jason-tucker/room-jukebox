import { open, stat } from 'node:fs/promises';
import {
  LoginBodySchema,
  PasswordChangeBodySchema,
  PlaylistBodySchema,
  ReorderBodySchema,
  RequestBodySchema,
  SearchBodySchema,
  SettingsPatchSchema,
  TransportBodySchema,
  type LoginReply,
  type RequestReply,
} from '@room-jukebox/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN_COOKIE, ADMIN_SESSION_MS } from '../auth/admin.ts';
import type { AdminClient } from '../auth/admin.ts';
import { sourceIp } from '../auth/gate.ts';
import type { AppContext } from '../context.ts';
import { groupSession, requireAdmin, requireHousehold, runHook } from '../context.ts';
import { backup, listBackups } from '../db/backup.ts';
import { HttpError, parse } from '../errors.ts';
import { lanReply, safeAddresses } from '../lan.ts';
import { submitRequest } from '../requests.ts';
import { OWNER_GUEST_ID, toEntryPublic } from '../session/projections.ts';

const LanPatchSchema = z.object({ chosen: z.string().min(1).nullable() });
const LogsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(5000).default(500),
});
const IdParamsSchema = z.object({ id: z.string().min(1) });
const GuestParamsSchema = z.object({ guestId: z.string().min(1) });

/** Remembers recent idempotency keys of owner commands so retries are no-ops. */
class RecentKeys {
  #keys = new Set<string>();
  /** True when `key` was seen before. */
  seen(key: string): boolean {
    if (this.#keys.has(key)) return true;
    this.#keys.add(key);
    if (this.#keys.size > 500) {
      const first = this.#keys.values().next().value;
      if (first !== undefined) this.#keys.delete(first);
    }
    return false;
  }
}

async function tailFile(path: string, lines: number): Promise<string[]> {
  const MAX_BYTES = 2 * 1024 * 1024;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - MAX_BYTES);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) all.shift();
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines);
  } finally {
    await fh.close();
  }
}

const isDesktop = (request: FastifyRequest) =>
  String(request.headers['x-client'] ?? '').toLowerCase() === 'desktop';

/** Signs in: bearer token in the body for `X-Client: desktop`, else the `rj_admin` cookie. */
export function issueAdminSession(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): LoginReply {
  const client: AdminClient = isDesktop(request) ? 'desktop' : 'web';
  const token = ctx.auth.createSession(client);
  if (client === 'desktop') return { ok: true, token };
  void reply.setCookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(ADMIN_SESSION_MS / 1000),
  });
  return { ok: true };
}

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const keys = new RecentKeys();
  const ack = (session = ctx.session) => ({
    ok: true as const,
    revision: session.revision,
    changeSeq: session.changeSeq,
  });

  app.post('/api/admin/login', async (request, reply) => {
    requireHousehold(ctx, request);
    const body = parse(LoginBodySchema, request.body);
    if (ctx.settings.needsSetup()) {
      throw new HttpError(409, 'needs-setup', 'Finish setup on the hub laptop first.');
    }
    await ctx.auth.checkPassword(body.password, sourceIp(request));
    ctx.repos.events.append(
      'admin.login',
      { client: isDesktop(request) ? 'desktop' : 'web' },
      ctx.now(),
    );
    return issueAdminSession(ctx, request, reply);
  });

  app.post('/api/admin/logout', async (request, reply) => {
    const { token } = requireAdmin(ctx, request);
    ctx.auth.revoke(token);
    void reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true as const };
  });

  // `?group=<groupId>` on the session, transport, queue and request routes acts on that group
  // (default: the main group).
  app.get('/api/admin/session', async (request) => {
    requireAdmin(ctx, request);
    return ctx.groups.adminState(groupSession(ctx, request).groupId);
  });

  app.post('/api/admin/transport', async (request) => {
    requireAdmin(ctx, request);
    const body = parse(TransportBodySchema, request.body);
    const session = groupSession(ctx, request);
    if (!keys.seen(body.idempotencyKey)) session.transport(body.action);
    return ack(session);
  });

  app.post('/api/admin/queue/reorder', async (request) => {
    requireAdmin(ctx, request);
    const body = parse(ReorderBodySchema, request.body);
    const session = groupSession(ctx, request);
    if (!keys.seen(body.idempotencyKey) && !session.reorder(body.id, body.toIndex)) {
      throw new HttpError(404, 'not-found', 'That song is no longer in the queue.');
    }
    return ack(session);
  });

  app.delete('/api/admin/queue/:id', async (request) => {
    requireAdmin(ctx, request);
    const { id } = parse(IdParamsSchema, request.params);
    const session = groupSession(ctx, request);
    if (!session.remove(id)) {
      throw new HttpError(404, 'not-found', 'That song is no longer in the queue.');
    }
    return ack(session);
  });

  app.post('/api/admin/requests', async (request, reply) => {
    requireAdmin(ctx, request);
    const body = parse(RequestBodySchema, request.body);
    const r = await submitRequest(ctx, groupSession(ctx, request), {
      videoId: body.videoId,
      idempotencyKey: body.idempotencyKey,
      guestId: null,
      name: null,
      ip: sourceIp(request),
    });
    const out: RequestReply = { entry: toEntryPublic(r.entry), duplicate: r.duplicate };
    return reply.code(201).send(out);
  });

  app.get('/api/admin/settings', async (request) => {
    requireAdmin(ctx, request);
    return ctx.settings.toPublic();
  });

  app.patch('/api/admin/settings', async (request) => {
    requireAdmin(ctx, request);
    const patch = parse(SettingsPatchSchema, request.body);
    const settings = ctx.settings.patch(patch);
    if (patch.friendlyHost !== undefined) await ctx.friendly.recheck();
    ctx.repos.events.append('admin.settings', { fields: Object.keys(patch) }, ctx.now());
    ctx.groups.touchAll();
    await runHook(request, () => ctx.hooks.onSettingsChanged?.(settings));
    return settings;
  });

  app.post('/api/admin/password', async (request, reply) => {
    requireAdmin(ctx, request);
    const body = parse(PasswordChangeBodySchema, request.body);
    // The household key rotates (and players get `rekey`) before the sessions are invalidated.
    await ctx.auth.changePassword(body.current, body.next, sourceIp(request), () =>
      ctx.rekey('password'),
    );
    // Every session is gone; the caller gets a fresh one so it stays signed in.
    return issueAdminSession(ctx, request, reply);
  });

  app.post('/api/admin/playlists', async (request) => {
    requireAdmin(ctx, request);
    const body = parse(PlaylistBodySchema, request.body);
    const info = await ctx.youtube.importPlaylist(body.url);
    ctx.groups.touchAll();
    return info;
  });

  app.delete('/api/admin/playlists/:id', async (request) => {
    requireAdmin(ctx, request);
    const { id } = parse(IdParamsSchema, request.params);
    if (!ctx.repos.playlists.delete(id)) {
      throw new HttpError(404, 'not-found', 'That playlist is not in the fallback list.');
    }
    ctx.groups.touchAll();
    return { ok: true as const };
  });

  app.post('/api/admin/playlists/:id/refresh', async (request) => {
    requireAdmin(ctx, request);
    const { id } = parse(IdParamsSchema, request.params);
    const row = ctx.repos.playlists.get(id);
    if (row === null)
      throw new HttpError(404, 'not-found', 'That playlist is not in the fallback list.');
    let info;
    try {
      info = await ctx.youtube.importPlaylist(row.url, id);
    } catch (err) {
      if (err instanceof HttpError) ctx.repos.playlists.upsert({ ...row, lastError: err.message });
      throw err;
    }
    ctx.groups.touchAll();
    return info;
  });

  app.post('/api/admin/search', async (request) => {
    requireAdmin(ctx, request);
    const body = parse(SearchBodySchema, request.body);
    const result = await ctx.youtube.search(body.q, {
      guestId: OWNER_GUEST_ID,
      ip: sourceIp(request),
      isOwner: true,
      isPublic: false,
      now: ctx.now(),
    });
    if (!result.cached) ctx.groups.touchAll();
    return result;
  });

  app.get('/api/admin/searches', async (request) => {
    requireAdmin(ctx, request);
    return ctx.youtube.searchesReply();
  });

  app.post('/api/admin/backup', async (request) => {
    requireAdmin(ctx, request);
    const info = await backup(ctx.repos.db, ctx.backupDir, ctx.now(), 'manual');
    ctx.repos.events.append('admin.backup', { path: info.path }, ctx.now());
    return info;
  });

  app.get('/api/admin/backups', async (request) => {
    requireAdmin(ctx, request);
    return { backups: listBackups(ctx.backupDir) };
  });

  app.delete('/api/admin/guests/:guestId', async (request) => {
    requireAdmin(ctx, request);
    const { guestId } = parse(GuestParamsSchema, request.params);
    ctx.groups.forgetGuest(guestId);
    return { ok: true as const };
  });

  app.get('/api/admin/players', async (request) => {
    requireAdmin(ctx, request);
    return { players: ctx.groups.players() };
  });

  app.get('/api/admin/lan', async (request) => {
    requireAdmin(ctx, request);
    return lanReply(ctx.lan, ctx.settings.data(), ctx.friendly);
  });

  app.patch('/api/admin/lan', async (request) => {
    requireAdmin(ctx, request);
    const { chosen } = parse(LanPatchSchema, request.body);
    if (chosen !== null && !safeAddresses(ctx.lan).some((a) => a.address === chosen)) {
      throw new HttpError(400, 'bad-request', `${chosen} is not one of this laptop's addresses.`);
    }
    ctx.settings.setData({ ...ctx.settings.data(), lanChosen: chosen });
    ctx.groups.touchAll();
    return lanReply(ctx.lan, ctx.settings.data(), ctx.friendly);
  });

  app.get('/api/admin/logs/tail', async (request) => {
    requireAdmin(ctx, request);
    const { lines } = parse(LogsQuerySchema, request.query);
    return { lines: ctx.logFile ? await tailFile(ctx.logFile, lines) : [] };
  });
}
