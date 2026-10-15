/**
 * M2 routes (docs/contract-m2.md): pairing, rooms and groups, revoke, replica status, the
 * hub-to-hub challenge and `/hub.json`.
 */
import {
  HubChallengeBodySchema,
  LinkStateSchema,
  M2_PROTOCOL_VERSION,
  PairBodySchema,
  RoomStateBodySchema,
  type HubChallengeReply,
  type HubJson,
  type LinkState,
  type PairReply,
  type RoomsReply,
} from '@room-jukebox/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashToken, newToken } from '../auth/crypto.ts';
import { sourceIp } from '../auth/gate.ts';
import { RateLimit } from '../auth/throttle.ts';
import type { AppContext } from '../context.ts';
import { requireAdmin, requireHousehold } from '../context.ts';
import { HttpError, parse } from '../errors.ts';
import { hubChallengeProof, newNonce, pairProof } from '../household.ts';
import { dialledAddress, hubOrigin, lanReply } from '../lan.ts';
import type { LinkResult } from '../session/groups.ts';
import { isLocalPlayer } from '../session/groups.ts';

const DeviceParamsSchema = z.object({ deviceId: z.string().min(1) });
const IdParamsSchema = z.object({ id: z.string().min(1) });
/** Hub challenges per source per minute. */
const CHALLENGES_PER_MINUTE = 20;

/** The hub's address for pairing proofs and `/hub.json`: the chosen QR address and LAN port. */
export function pairAddress(ctx: AppContext): { hubAddress: string; hubPort: number } {
  const data = ctx.settings.data();
  return { hubAddress: lanReply(ctx.lan, data).chosen, hubPort: data.lanPort };
}

export function hubJson(ctx: AppContext): HubJson {
  const data = ctx.settings.data();
  const { hubAddress, hubPort } = pairAddress(ctx);
  return {
    hubAddress: hubOrigin(hubAddress, hubPort),
    hubEpoch: data.hubEpoch,
    protocolVersion: M2_PROTOCOL_VERSION,
    roomName: data.roomName,
  };
}

/** The paired device presenting `Authorization: Bearer <deviceToken>` (401 otherwise). */
function requireDevice(ctx: AppContext, request: FastifyRequest): { deviceId: string } {
  requireHousehold(ctx, request);
  const auth = request.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const player = token ? ctx.repos.players.findByTokenHash(hashToken(token)) : null;
  if (player === null) throw new HttpError(401, 'unauthorized', 'This laptop is not paired.');
  return { deviceId: player.deviceId };
}

function linkOrThrow(ctx: AppContext, deviceId: string, linkState: LinkState): LinkResult {
  const r = ctx.groups.setLinkState(deviceId, linkState);
  if (r === null) throw new HttpError(404, 'not-found', 'That room is not paired with the hub.');
  return r;
}

export async function registerM2Routes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Pairing (Player first run): owner password, throttled with the login counters.
  app.post('/api/pair', async (request): Promise<PairReply & { keyEpoch: number }> => {
    requireHousehold(ctx, request);
    const body = parse(PairBodySchema, request.body);
    if (ctx.settings.needsSetup()) {
      throw new HttpError(409, 'needs-setup', 'Finish setup on the hub laptop first.');
    }
    await ctx.auth.checkPassword(body.password, sourceIp(request));
    if (isLocalPlayer(body.deviceId) || body.deviceId.includes('|')) {
      throw new HttpError(400, 'bad-request', 'That device ID is reserved.');
    }
    if (body.nonceP.includes('|')) throw new HttpError(400, 'bad-request', 'Bad nonce.');
    const now = ctx.now();
    const deviceToken = newToken();
    const name = body.deviceName.trim().slice(0, 60) || 'Room';
    ctx.repos.players.upsert(body.deviceId, name, hashToken(deviceToken), now);
    ctx.groups.ensureRoom(body.deviceId, name);
    ctx.repos.events.append('player.paired', { deviceId: body.deviceId }, now);
    const data = ctx.settings.data();
    const nonceH = newNonce();
    // Bound to the address and port the player dialled (its request's Host).
    const { hubAddress, hubPort } = dialledAddress(request.headers.host);
    const reply: PairReply & { keyEpoch: number } = {
      ok: true,
      playerId: body.deviceId,
      deviceToken,
      householdKey: ctx.household.key(),
      hubId: data.hubId,
      hubEpoch: data.hubEpoch,
      roomName: data.roomName,
      protocolVersion: M2_PROTOCOL_VERSION,
      nonceH,
      proof: pairProof(ctx.household.keys().hubProof, {
        hubId: data.hubId,
        deviceId: body.deviceId,
        nonceP: body.nonceP,
        nonceH,
        hubAddress,
        hubPort,
      }),
      // The key's generation, so the player stores the right epoch.
      keyEpoch: ctx.household.keyEpoch(),
    };
    return reply;
  });

  // The player's join popup result (device-token auth).
  app.post('/api/rooms/me', async (request): Promise<LinkResult> => {
    const { deviceId } = requireDevice(ctx, request);
    const body = parse(RoomStateBodySchema, request.body);
    return linkOrThrow(ctx, deviceId, body.linkState);
  });

  app.get('/api/admin/rooms', async (request): Promise<RoomsReply> => {
    requireAdmin(ctx, request);
    return { rooms: ctx.groups.rooms(), groups: ctx.groups.groups() };
  });

  for (const [action, linkState] of [
    ['link', 'linked'],
    ['split', 'independent'],
  ] as const) {
    app.post(`/api/admin/rooms/:deviceId/${action}`, async (request): Promise<LinkResult> => {
      requireAdmin(ctx, request);
      const { deviceId } = parse(DeviceParamsSchema, request.params);
      if (isLocalPlayer(deviceId)) {
        throw new HttpError(409, 'hub-room', "The hub's own TV always plays the main group.");
      }
      return linkOrThrow(ctx, deviceId, LinkStateSchema.parse(linkState));
    });
  }

  app.post('/api/admin/players/:id/revoke', async (request) => {
    requireAdmin(ctx, request);
    const { id } = parse(IdParamsSchema, request.params);
    if (isLocalPlayer(id)) {
      throw new HttpError(409, 'hub-room', "The hub's own TV can't be revoked.");
    }
    if (!ctx.repos.players.revoke(id, ctx.now())) {
      throw new HttpError(404, 'not-found', 'That player is not paired.');
    }
    ctx.groups.removeRoom(id);
    ctx.replica.forget(id);
    ctx.repos.events.append('player.revoked', { deviceId: id }, ctx.now());
    ctx.rekey('revoke', id);
    return { ok: true as const, keyEpoch: ctx.household.keyEpoch() };
  });

  app.get('/api/admin/replica/status', async (request) => {
    requireAdmin(ctx, request);
    return ctx.replica.status();
  });

  // Hub-to-hub challenge (Become hub; contract §4).
  const challenges = new RateLimit(CHALLENGES_PER_MINUTE, 60_000, ctx.now);
  app.post('/api/hub/challenge', async (request): Promise<HubChallengeReply> => {
    requireHousehold(ctx, request);
    const wait = challenges.hit(sourceIp(request));
    if (wait > 0) {
      throw new HttpError(429, 'challenge-throttled', 'Too many hub challenges.', wait);
    }
    const body = parse(HubChallengeBodySchema, request.body);
    if (body.hubId.includes('|') || body.nonce.includes('|')) {
      throw new HttpError(400, 'bad-request', 'Bad challenge.');
    }
    const data = ctx.settings.data();
    return {
      proof: hubChallengeProof(ctx.household.keys().hubProof, {
        theirHubId: body.hubId,
        myHubId: data.hubId,
        nonce: body.nonce,
        epoch: data.hubEpoch,
      }),
    };
  });

  app.get('/hub.json', async (_request, reply) => {
    void reply.header('Access-Control-Allow-Origin', '*');
    return hubJson(ctx);
  });
}
