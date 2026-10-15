import {
  HelloBodySchema,
  RequestBodySchema,
  SearchBodySchema,
  type HelloReply,
  type RequestReply,
  type SuggestReply,
} from '@room-jukebox/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sourceIp } from '../auth/gate.ts';
import { GUEST_COOKIE } from '../auth/guest-cookie.ts';
import type { AppContext } from '../context.ts';
import { ensureGuest, guestFrom } from '../context.ts';
import { HttpError, parse } from '../errors.ts';
import { PRIVACY_POLICY } from '../privacy.ts';
import { submitRequest } from '../requests.ts';
import { toEntryPublic } from '../session/projections.ts';
import { extractVideoId } from '../youtube/ids.ts';

const NameBodySchema = z.object({ name: z.string().trim().min(1).max(40).nullable() });
const NoticeBodySchema = z.object({ accepted: z.literal(true) });
const ResolveQuerySchema = z.object({ input: z.string().min(1).max(2000) });
const SuggestQuerySchema = z.object({ q: z.string().max(200).default('') });
const GroupQuerySchema = z.object({ group: z.string().max(200).optional() });
/** M2: `POST /api/requests` may name the group (`/r/<groupId>` pages); default main. */
const RequestGroupSchema = z.object({ groupId: z.string().max(200).optional() });

/** Guest routes: open on the LAN listener (no household gate). */
export async function registerGuestRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const helloReply = (guestId: string): HelloReply => {
    const row = ctx.repos.guests.get(guestId);
    return {
      guestId,
      name: row?.name ?? null,
      noticeAccepted: row?.noticeAcceptedAt != null,
    };
  };

  app.post('/api/guest/hello', async (request, reply) => {
    const body = parse(HelloBodySchema, request.body);
    const guestId = ensureGuest(ctx, request, reply);
    if (body.name !== undefined) ctx.repos.guests.setName(guestId, body.name);
    return helloReply(guestId);
  });

  app.post('/api/guest/notice', async (request, reply) => {
    parse(NoticeBodySchema, request.body);
    const guestId = ensureGuest(ctx, request, reply);
    ctx.repos.guests.acceptNotice(guestId, ctx.now());
    return helloReply(guestId);
  });

  app.post('/api/guest/name', async (request, reply) => {
    const body = parse(NameBodySchema, request.body);
    const guestId = ensureGuest(ctx, request, reply);
    ctx.repos.guests.setName(guestId, body.name);
    return helloReply(guestId);
  });

  app.post('/api/guest/forget', async (request, reply) => {
    const guestId = guestFrom(ctx, request);
    if (guestId !== null) ctx.groups.forgetGuest(guestId);
    void reply.clearCookie(GUEST_COOKIE, { path: '/' });
    return { ok: true as const };
  });

  // `?group=<groupId>`: that group's state (unknown or merged groups fall back to main).
  app.get('/api/session', async (request) => {
    const { group } = parse(GroupQuerySchema, request.query);
    return ctx.groups.resolve(group).toGuestState(guestFrom(ctx, request));
  });

  app.get('/api/videos/resolve', async (request) => {
    const { input } = parse(ResolveQuerySchema, request.query);
    const videoId = extractVideoId(input);
    if (videoId === null) {
      throw new HttpError(
        400,
        'bad-link',
        "That doesn't look like a YouTube link. Copy the link from YouTube's Share button.",
      );
    }
    return ctx.youtube.resolve(videoId);
  });

  app.post('/api/requests', async (request, reply) => {
    const body = parse(RequestBodySchema, request.body);
    const { groupId } = parse(RequestGroupSchema, request.body);
    const guestId = ensureGuest(ctx, request, reply);
    if (body.name !== undefined) ctx.repos.guests.setName(guestId, body.name);
    const name = ctx.repos.guests.get(guestId)?.name ?? null;
    try {
      const r = await submitRequest(ctx, ctx.groups.resolve(groupId), {
        videoId: body.videoId,
        idempotencyKey: body.idempotencyKey,
        guestId,
        name,
        ip: sourceIp(request),
      });
      if (!r.duplicate) {
        ctx.toastGuest(guestId, 'info', `Added “${r.entry.title}” to the queue.`);
      }
      const out: RequestReply = { entry: toEntryPublic(r.entry, guestId), duplicate: r.duplicate };
      return reply.code(201).send(out);
    } catch (err) {
      if (err instanceof HttpError) ctx.toastGuest(guestId, 'warn', err.message);
      throw err;
    }
  });

  app.post('/api/search', async (request, reply) => {
    const body = parse(SearchBodySchema, request.body);
    const guestId = ensureGuest(ctx, request, reply);
    const result = await ctx.youtube.search(body.q, {
      guestId,
      ip: sourceIp(request),
      isOwner: false,
      isPublic: false,
      now: ctx.now(),
    });
    // A cache miss spent budget: everyone's "searches left" changed.
    if (!result.cached) ctx.groups.touchAll();
    return result;
  });

  // YouTube's typing suggestions (no quota). Fails soft to an empty list; 204 when this source
  // asked less than 300 ms ago.
  app.get('/api/search/suggest', async (request, reply) => {
    const { q } = parse(SuggestQuerySchema, request.query);
    const suggestions = await ctx.suggest.suggest(q, sourceIp(request));
    if (suggestions === null) return reply.code(204).send();
    const out: SuggestReply = { suggestions };
    return out;
  });

  app.get('/api/privacy.json', async () => PRIVACY_POLICY);
}
