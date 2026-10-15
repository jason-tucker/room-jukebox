import { randomUUID } from 'node:crypto';
import { SetupBodySchema, type SetupReply, type SetupStatusReply } from '@room-jukebox/shared';
import type { FastifyInstance } from 'fastify';
import { hashToken, newToken } from '../auth/crypto.ts';
import type { AppContext } from '../context.ts';
import { requireLoopback, runHook } from '../context.ts';
import { HttpError, parse } from '../errors.ts';
import { lanReply } from '../lan.ts';

/** Name and ID prefix of the hub's own TV player device. */
export const LOCAL_PLAYER_NAME = 'TV';

/**
 * Issues a fresh token for the hub's own TV player (creating its device row the first time).
 * Only the hash is stored; the previous token stops working.
 */
export function issueLocalPlayerToken(ctx: AppContext): { playerId: string; token: string } {
  const existing = ctx.repos.players.list()[0];
  const playerId = existing?.deviceId ?? `tv-${randomUUID()}`;
  const token = newToken();
  const name = existing?.name ?? LOCAL_PLAYER_NAME;
  ctx.repos.players.upsert(playerId, name, hashToken(token), ctx.now());
  ctx.session.addPlayer(playerId, name);
  return { playerId, token };
}

/** First-run API: loopback only; `POST /api/setup` answers 409 once a password exists. */
export async function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/setup/status', async (request): Promise<SetupStatusReply> => {
    requireLoopback(ctx, request);
    return {
      needsSetup: ctx.settings.needsSetup(),
      lan: lanReply(ctx.lan, ctx.settings.data(), ctx.friendly),
    };
  });

  let inProgress = false;
  app.post('/api/setup', async (request): Promise<SetupReply> => {
    requireLoopback(ctx, request);
    if (!ctx.settings.needsSetup() || inProgress) {
      throw new HttpError(409, 'already-set-up', 'This jukebox is already set up.');
    }
    const body = parse(SetupBodySchema, request.body);
    inProgress = true;
    try {
      await ctx.auth.setPassword(body.password);
    } finally {
      inProgress = false;
    }
    const now = ctx.now();
    const data = { ...ctx.settings.data(), roomName: body.roomName.trim() };
    if (body.wifi) {
      data.wifi = { ssid: body.wifi.ssid, security: body.wifi.security, hidden: body.wifi.hidden };
    }
    ctx.settings.setData(data);
    if (body.wifi) ctx.settings.setWifiPassword(body.wifi.password);
    if (body.youtubeApiKey !== undefined) ctx.settings.setApiKey(body.youtubeApiKey);
    ctx.repos.settings.setNoticeAccepted(now);

    const player = issueLocalPlayerToken(ctx);
    const token = ctx.auth.createSession('desktop', true);
    ctx.repos.events.append('setup', { roomName: data.roomName }, now);

    for (const url of body.fallbackPlaylistUrls ?? []) {
      if (url.trim() === '') continue;
      try {
        await ctx.youtube.importPlaylist(url);
      } catch (err) {
        const message = err instanceof HttpError ? err.message : 'Import failed.';
        ctx.youtube.recordPlaylistError(url, message);
      }
    }
    ctx.session.touch();
    await runHook(request, () =>
      ctx.hooks.onSetupComplete?.({ token, playerToken: player.token, playerId: player.playerId }),
    );
    return { ok: true, token, playerToken: player.token, playerId: player.playerId };
  });
}
