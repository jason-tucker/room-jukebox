import { randomBytes } from 'node:crypto';
import { M2_PROTOCOL_VERSION, PairReplySchema } from '@room-jukebox/shared';
import type { PairBody, PairReply } from '@room-jukebox/shared';
import { hubEndpoint, joinAckProof, joinProof, pairProof, proofEquals } from './household';

export const DEFAULT_HUB_PORT = 8080;

/**
 * Hub base URL from what the owner typed or a beacon gave: `192.168.1.5`, `192.168.1.5:8080`,
 * `http://jukebox.local:8080/` → `http://<host>:<port>`. Throws on anything else.
 */
export function normalizeHubAddress(input: string): string {
  const text = input.trim();
  if (!text) throw new Error('Enter the hub address.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a hub address.`);
  }
  if (u.protocol !== 'http:') throw new Error('The hub address must be http://.');
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error(`"${input}" is not a hub address.`);
  }
  return `http://${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${u.port || DEFAULT_HUB_PORT}`;
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Failure codes the web wizard words (`Setup.tsx` `pairErrorText`): `unreachable` (bad address or
 * no answer), `bad-password`, `login-throttled` (with `retryAfterSec`), `bad-proof` (the hub
 * refused us or could not prove it is the hub at that address).
 */
export type PairFailureCode = 'unreachable' | 'bad-password' | 'login-throttled' | 'bad-proof';

export type PairOutcome =
  | { ok: true; hubAddress: string; reply: PairReply; protocolMismatch: boolean }
  | { ok: false; message: string; code: PairFailureCode; retryAfterSec?: number };

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Player first run (contract §1): `POST <hub>/api/pair`, then verify `proof` with the key in the
 * reply, bound to the address and port we dialled, before the caller stores anything.
 */
export async function pairWithHub(p: {
  hubAddress: string;
  password: string;
  deviceName: string;
  deviceId: string;
  fetch: FetchFn;
  nonceP?: string;
}): Promise<PairOutcome> {
  let hubAddress: string;
  try {
    hubAddress = normalizeHubAddress(p.hubAddress);
  } catch (err) {
    return { ok: false, code: 'unreachable', message: (err as Error).message };
  }
  const nonceP = p.nonceP ?? newNonce();
  const body: PairBody = {
    password: p.password,
    deviceName: p.deviceName,
    deviceId: p.deviceId,
    nonceP,
  };
  let res: Response;
  try {
    res = await p.fetch(`${hubAddress}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: 'unreachable', message: `No hub answered at ${hubAddress}.` };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as { error?: { retryAfterSec?: number; message?: string } } | null)?.error;
    if (res.status === 401) return { ok: false, code: 'bad-password', message: 'Wrong password.' };
    if (res.status === 429) {
      const retryAfterSec = err?.retryAfterSec ?? 60;
      return {
        ok: false,
        code: 'login-throttled',
        message: `Too many attempts. Try again in ${retryAfterSec} s.`,
        retryAfterSec,
      };
    }
    return {
      ok: false,
      code: 'bad-proof',
      message: err?.message ?? `The hub refused pairing (HTTP ${res.status}).`,
    };
  }
  const parsed = PairReplySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, code: 'bad-proof', message: 'The hub sent an unexpected reply.' };
  }
  const reply = parsed.data;
  const expected = pairProof(reply.householdKey, {
    hubId: reply.hubId,
    deviceId: p.deviceId,
    nonceP,
    nonceH: reply.nonceH,
    hub: hubEndpoint(hubAddress),
  });
  if (!proofEquals(expected, reply.proof)) {
    return {
      ok: false,
      code: 'bad-proof',
      message: 'The hub could not prove it is the Room Jukebox hub at that address.',
    };
  }
  return {
    ok: true,
    hubAddress,
    reply,
    protocolMismatch: reply.protocolVersion !== M2_PROTOCOL_VERSION,
  };
}

/** The player's `auth` proof for a join to `hubAddress`. */
export function playerAuthProof(p: {
  householdKey: string;
  deviceId: string;
  hubId: string;
  hubAddress: string;
  nonceP: string;
}): string {
  return joinProof(p.householdKey, {
    deviceId: p.deviceId,
    hubId: p.hubId,
    nonceP: p.nonceP,
    hub: hubEndpoint(p.hubAddress),
  });
}

/**
 * The hub's own TV window's `auth` proof: the window's page origin (`http://localhost:<LAN_PORT>`
 * or `http://127.0.0.1:<LAN_PORT>`) is what its socket dials, so the server's Host-based check
 * sees the same host and port.
 */
export function localPlayerAuthProof(p: {
  householdKey: string;
  deviceId: string;
  hubId: string;
  pageOrigin: string;
  nonceP: string;
}): string {
  return playerAuthProof({ ...p, hubAddress: p.pageOrigin });
}

/** Checks the hub's `authOk` proof. */
export function verifyAuthOk(p: {
  householdKey: string;
  deviceId: string;
  hubId: string;
  nonceP: string;
  nonceH: string;
  proof: string;
}): boolean {
  return proofEquals(
    joinAckProof(p.householdKey, {
      hubId: p.hubId,
      deviceId: p.deviceId,
      nonceP: p.nonceP,
      nonceH: p.nonceH,
    }),
    p.proof,
  );
}
