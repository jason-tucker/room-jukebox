import {
  AdminStateSchema,
  ApiErrorSchema,
  BackupReplySchema,
  ChecklistStateSchema,
  GuestStateSchema,
  HelloReplySchema,
  LanReplySchema,
  LoginReplySchema,
  LogsTailReplySchema,
  PlayersReplySchema,
  PlaylistInfoSchema,
  PrivacyReplySchema,
  ReleaseNotesReplySchema,
  RequestReplySchema,
  ResolveReplySchema,
  SearchesReplySchema,
  SearchReplySchema,
  SettingsPublicSchema,
  SetupReplySchema,
  SetupStatusReplySchema,
  SuggestReplySchema,
  HealthReplySchema,
  HubJsonSchema,
  LinkReplySchema,
  RoomsReplySchema,
  UpdateStatusSchema,
  type LinkState,
  type ChecklistPatch,
  type HelloBody,
  type PasswordChangeBody,
  type RequestBody,
  type SettingsPatch,
  type SetupBody,
  type TransportBody,
  type ReorderBody,
  type UpdateStatus,
} from '@room-jukebox/shared';
import { z } from 'zod';
import { desktopAdminToken } from './jukebox.ts';

/**
 * Typed fetch wrapper for the M1 HTTP routes (docs/contract-m1.md). Never throws: every call
 * resolves to an `ApiResult`, with the server's ApiError envelope mapped to `ApiFailure`.
 */

export interface ApiFailure {
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** ApiError `code`, or `network` / `bad-reply` / `http-<status>` when the server sent none. */
  code: string;
  message: string;
  retryAfterSec?: number;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; error: ApiFailure };

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallOptions<T> {
  body?: unknown;
  schema?: z.ZodType<T>;
  /** Overrides the desktop bearer (setup uses the one-time token it just received). */
  bearer?: string | null;
  signal?: AbortSignal;
}

export async function call<T = unknown>(
  method: Method,
  path: string,
  opts: CallOptions<T> = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const bearer =
    opts.bearer !== undefined
      ? opts.bearer
      : path.startsWith('/api/admin/')
        ? await desktopAdminToken()
        : null;
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 0,
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  let json: unknown = undefined;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    if (parsed.success) {
      const { code, message, retryAfterSec } = parsed.data.error;
      return {
        ok: false,
        error: {
          status: res.status,
          code,
          message,
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        },
      };
    }
    return {
      ok: false,
      error: { status: res.status, code: `http-${res.status}`, message: text.slice(0, 200) },
    };
  }

  if (!opts.schema) return { ok: true, status: res.status, data: json as T };
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        status: res.status,
        code: 'bad-reply',
        message: `Unexpected reply from ${method} ${path}: ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, status: res.status, data: parsed.data };
}

const OkSchema = z.object({ ok: z.literal(true) });
const VersionReplySchema = z.object({ version: z.string(), protocolVersion: z.number().int() });
const BackupsReplySchema = z.object({ backups: z.array(BackupReplySchema) });

const enc = encodeURIComponent;
/** `?group=<id>` for a guest page bound to `/r/<groupId>`; empty for the main group. */
const groupQ = (group?: string, sep = '?') => (group ? `${sep}group=${enc(group)}` : '');

/**
 * A queue entry of a room that was linked back into the main group: not moved (shared
 * **LinkReply** `orphaned`), listed so the owner can re-add it (contract-m2 §3).
 */
export type OrphanedEntry = { videoId: string; title: string };

/**
 * `GET /api/admin/replica/status`: when the hub last sent a snapshot and when each remote player
 * last acknowledged one (contract-m2 "Lane clarifications").
 */
export const ReplicaStatusSchema = z
  .object({
    lastSentAt: z.number().nullable(),
    bytes: z.number().optional(),
    players: z.array(z.object({ deviceId: z.string(), lastAckAt: z.number().nullable() }).loose()),
  })
  .loose();
export type ReplicaStatus = z.infer<typeof ReplicaStatusSchema>;

/** Strips a trailing slash: `http://192.168.1.20:8080/` → `http://192.168.1.20:8080`. */
const base = (hub: string) => hub.replace(/\/+$/, '');

/** One function per contract route. */
export const api = {
  health: () => call('GET', '/healthz', { schema: HealthReplySchema }),
  version: () => call('GET', '/api/version', { schema: VersionReplySchema }),

  guest: {
    hello: (body: HelloBody) =>
      call('POST', '/api/guest/hello', { body, schema: HelloReplySchema }),
    notice: () =>
      call('POST', '/api/guest/notice', { body: { accepted: true }, schema: HelloReplySchema }),
    setName: (name: string | null) =>
      call('POST', '/api/guest/name', { body: { name }, schema: HelloReplySchema }),
    forget: () => call('POST', '/api/guest/forget', { body: {}, schema: OkSchema }),
    session: (group?: string) =>
      call('GET', `/api/session${groupQ(group)}`, { schema: GuestStateSchema }),
    resolve: (input: string) =>
      call('GET', `/api/videos/resolve?input=${enc(input)}`, { schema: ResolveReplySchema }),
    request: (body: RequestBody, group?: string) =>
      call('POST', `/api/requests${groupQ(group)}`, { body, schema: RequestReplySchema }),
    search: (q: string) => call('POST', '/api/search', { body: { q }, schema: SearchReplySchema }),
    /**
     * YouTube's typing suggestions. null when there is nothing new to show: the hub dropped the
     * request (204, asked too fast), or it failed or was aborted (keep what is on screen).
     */
    suggest: async (q: string, signal?: AbortSignal): Promise<string[] | null> => {
      const r = await call('GET', `/api/search/suggest?q=${enc(q)}`, {
        ...(signal ? { signal } : {}),
      });
      if (!r.ok || r.status === 204) return null;
      const parsed = SuggestReplySchema.safeParse(r.data);
      return parsed.success ? parsed.data.suggestions : null;
    },
    privacy: () => call('GET', '/api/privacy.json', { schema: PrivacyReplySchema }),
  },

  admin: {
    login: (password: string) =>
      call('POST', '/api/admin/login', { body: { password }, schema: LoginReplySchema }),
    logout: () => call('POST', '/api/admin/logout', { body: {} }),
    session: () => call('GET', '/api/admin/session', { schema: AdminStateSchema }),
    transport: (body: TransportBody) => call('POST', '/api/admin/transport', { body }),
    reorder: (body: ReorderBody) => call('POST', '/api/admin/queue/reorder', { body }),
    removeEntry: (id: string) => call('DELETE', `/api/admin/queue/${enc(id)}`),
    request: (body: RequestBody) =>
      call('POST', '/api/admin/requests', { body, schema: RequestReplySchema }),
    settings: () => call('GET', '/api/admin/settings', { schema: SettingsPublicSchema }),
    patchSettings: (body: SettingsPatch) =>
      call('PATCH', '/api/admin/settings', { body, schema: SettingsPublicSchema }),
    changePassword: (body: PasswordChangeBody) => call('POST', '/api/admin/password', { body }),
    addPlaylist: (url: string) =>
      call('POST', '/api/admin/playlists', { body: { url }, schema: PlaylistInfoSchema }),
    removePlaylist: (id: string) => call('DELETE', `/api/admin/playlists/${enc(id)}`),
    refreshPlaylist: (id: string) =>
      call('POST', `/api/admin/playlists/${enc(id)}/refresh`, { body: {} }),
    search: (q: string) =>
      call('POST', '/api/admin/search', { body: { q }, schema: SearchReplySchema }),
    searches: () => call('GET', '/api/admin/searches', { schema: SearchesReplySchema }),
    backup: () => call('POST', '/api/admin/backup', { body: {}, schema: BackupReplySchema }),
    backups: () => call('GET', '/api/admin/backups', { schema: BackupsReplySchema }),
    deleteGuest: (guestId: string) =>
      call('DELETE', `/api/admin/guests/${enc(guestId)}`, { schema: OkSchema }),
    players: () => call('GET', '/api/admin/players', { schema: PlayersReplySchema }),
    lan: () => call('GET', '/api/admin/lan', { schema: LanReplySchema }),
    setLan: (chosen: string, bearer?: string) =>
      call('PATCH', '/api/admin/lan', {
        body: { chosen },
        ...(bearer ? { bearer } : {}),
      }),
    logsTail: (lines = 500) =>
      call('GET', `/api/admin/logs/tail?lines=${lines}`, { schema: LogsTailReplySchema }),
    releaseNotes: () =>
      call('GET', '/api/admin/release-notes', { schema: ReleaseNotesReplySchema }),
    patchChecklist: (body: ChecklistPatch) =>
      call('PATCH', '/api/admin/checklist', { body, schema: ChecklistStateSchema }),
    updateStatus: () => call('GET', '/api/admin/update-status', { schema: UpdateStatusSchema }),
    updateCheck: () =>
      call('POST', '/api/admin/update/check', { body: {}, schema: UpdateStatusSchema }),
    updateInstall: () =>
      call('POST', '/api/admin/update/install', { body: {}, schema: UpdateStatusSchema }),
    updateMode: (mode: UpdateStatus['mode']) =>
      call('POST', '/api/admin/update/mode', { body: { mode }, schema: UpdateStatusSchema }),
    rooms: () => call('GET', '/api/admin/rooms', { schema: RoomsReplySchema.loose() }),
    linkRoom: (deviceId: string) =>
      call('POST', `/api/admin/rooms/${enc(deviceId)}/link`, { body: {}, schema: LinkReplySchema }),
    splitRoom: (deviceId: string) =>
      call('POST', `/api/admin/rooms/${enc(deviceId)}/split`, {
        body: {},
        schema: LinkReplySchema,
      }),
    revokePlayer: (id: string) =>
      call('POST', `/api/admin/players/${enc(id)}/revoke`, { body: {} }),
    replicaStatus: () => call('GET', '/api/admin/replica/status', { schema: ReplicaStatusSchema }),
    updateFeed: (feed: UpdateStatus['feed'], url?: string) =>
      call('POST', '/api/admin/update/feed', {
        body: url === undefined ? { feed } : { feed, url },
        schema: UpdateStatusSchema,
      }),
  },

  /** Calls a Player TV makes to its hub (another origin), authenticated with the device token. */
  hub: {
    info: (hub: string) => call('GET', `${base(hub)}/hub.json`, { schema: HubJsonSchema }),
    setRoomState: (hub: string, deviceToken: string | null, linkState: LinkState) =>
      call('POST', `${base(hub)}/api/rooms/me`, {
        body: { linkState },
        bearer: deviceToken,
      }),
  },

  setup: {
    status: () => call('GET', '/api/setup/status', { schema: SetupStatusReplySchema }),
    // loose(): keep fields the server adds beyond the shared schema (e.g. `playerId`) for the desktop.
    submit: (body: SetupBody) =>
      call('POST', '/api/setup', { body, schema: SetupReplySchema.loose() }),
  },
};
