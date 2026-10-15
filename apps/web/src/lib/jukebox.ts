import type { LinkState, ReplicaSnapshot, SetupReply } from '@room-jukebox/shared';

/** A toast from the desktop shell: a plain string or the WS toast shape. */
export type DesktopToast =
  string | { message: string; level?: 'info' | 'warn' | 'error'; ttlMs?: number };

/** A hub heard on the LAN (a verified beacon, reduced to what the pages show). */
export interface HeardHub {
  hubId: string;
  roomName: string;
  address: string;
  port: number;
  hubEpoch?: number;
  protocolVersion?: number;
}

export interface PairArgs {
  /** `http://<address>:<port>` of the hub. */
  hubAddress: string;
  password: string;
  /** This laptop's room name. */
  deviceName: string;
}

/**
 * Result of `pair()`. `code` is `bad-password`, `unreachable`, `bad-proof` (the hub's pairing proof
 * did not verify), `login-throttled`, or another server error code.
 */
export type PairResult =
  | { ok: true; roomName?: string }
  | { ok: false; code: string; message?: string; retryAfterSec?: number };

/** Player join proof (contract-m2 §1): the desktop holds the household key, the page never does. */
export interface PlayerProof {
  deviceId: string;
  proof: string;
}

/**
 * `mode()`: the shell's role, either a bare string or an object that also carries what this
 * laptop remembers (its room's link state, the last hub address).
 */
export type DesktopMode =
  'hub' | 'player' | { mode: 'hub' | 'player'; linkState?: LinkState; hubAddress?: string | null };

export interface ReplicaInfo {
  snapshotAt: number | null;
  hubEpoch?: number | null;
}

/**
 * The desktop preload bridge (`window.jukebox`, contract-m1 "Desktop ↔ server and IPC"). Every
 * member is optional: the same pages run in a phone browser where the bridge does not exist.
 */
export interface JukeboxBridge {
  selfcheck?: () => unknown;
  lastBeacon?: () => unknown;
  /** App version for the owner page footer (may be async over IPC). */
  version?: () => string | null | undefined | Promise<string | null | undefined>;
  openSettings?: () => unknown;
  /**
   * Settings window only: the desktop admin bearer token (undefined elsewhere; may be async over
   * IPC). When it returns a token, /admin skips its login form and sends the bearer everywhere.
   */
  adminToken?: () => string | null | undefined | Promise<string | null | undefined>;
  quit?: () => unknown;
  installUpdate?: () => unknown;
  /** Called by /setup with the SetupReply after a successful POST /api/setup. */
  setupComplete?: (reply: SetupReply) => unknown;
  /** Desktop-originated toasts; returns an unsubscribe function. */
  onToast?: (cb: (toast: DesktopToast) => void) => (() => void) | undefined;

  // ---- M2 (docs/contract-m2.md) ----
  /** Player first run: pairs with a hub over the LAN (POST /api/pair) and stores the key. */
  pair?: (args: PairArgs) => Promise<PairResult>;
  /** Hubs heard so far. */
  hubs?: () => HeardHub[] | Promise<HeardHub[]>;
  /** Called with the full list whenever it changes; returns an unsubscribe function. */
  onHubs?: (cb: (hubs: HeardHub[]) => void) => (() => void) | undefined;
  /** Player mode: the `auth` proof for this nonce. */
  playerAuth?: (nonceP: string) => Promise<PlayerProof>;
  /** Hub mode: the same proof for the hub's own TV. */
  localPlayerAuth?: (nonceP: string) => Promise<PlayerProof>;
  /** Checks the hub's `authOk` proof. */
  verifyAuthOk?: (nonceP: string, nonceH: string, proof: string) => Promise<boolean>;
  setLinkState?: (s: LinkState) => unknown;
  setHubAddress?: (url: string) => unknown;
  storeKey?: (k: { householdKey: string; keyEpoch: number }) => unknown;
  storeReplica?: (snapshot: ReplicaSnapshot) => unknown;
  replicaInfo?: () => ReplicaInfo | null | Promise<ReplicaInfo | null>;
  mode?: () => DesktopMode | Promise<DesktopMode>;
}

declare global {
  interface Window {
    jukebox?: JukeboxBridge;
  }
}

export function bridge(): JukeboxBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.jukebox;
}

export async function desktopAdminToken(): Promise<string | null> {
  const fn = bridge()?.adminToken;
  if (typeof fn !== 'function') return null;
  try {
    const token = await fn();
    return token || null;
  } catch {
    return null;
  }
}

export async function desktopVersion(): Promise<string | null> {
  const fn = bridge()?.version;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn()) || null;
  } catch {
    return null;
  }
}

/** Subscribes to desktop toasts when the bridge offers them; returns an unsubscribe function. */
export function onDesktopToast(
  cb: (message: string, level: 'info' | 'warn' | 'error', ttlMs?: number) => void,
): () => void {
  const fn = bridge()?.onToast;
  if (typeof fn !== 'function') return () => undefined;
  try {
    const off = fn((t) => {
      if (typeof t === 'string') cb(t, 'info');
      else if (t && typeof t.message === 'string') cb(t.message, t.level ?? 'info', t.ttlMs);
    });
    return typeof off === 'function' ? off : () => undefined;
  } catch {
    return () => undefined;
  }
}

/** Calls a bridge member, swallowing a missing bridge or a throw (returns undefined). */
export async function callBridge<K extends keyof JukeboxBridge>(
  name: K,
  ...args: JukeboxBridge[K] extends ((...a: infer A) => unknown) | undefined ? A : never
): Promise<
  JukeboxBridge[K] extends ((...a: never[]) => infer R) | undefined ? Awaited<R> | undefined : never
> {
  const fn = bridge()?.[name] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof fn !== 'function') return undefined as never;
  try {
    return (await fn(...args)) as never;
  } catch {
    return undefined as never;
  }
}

/** The remembered link state and hub address from `mode()`, when the shell reports them. */
export async function desktopMemory(): Promise<{
  linkState: LinkState | null;
  hubAddress: string | null;
}> {
  const m = await callBridge('mode');
  if (m && typeof m === 'object') {
    return { linkState: m.linkState ?? null, hubAddress: m.hubAddress ?? null };
  }
  return { linkState: null, hubAddress: null };
}
