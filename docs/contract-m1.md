# M1 contract (frozen 2026-10-09 by the main session)

Single room, Hub mode, one TV player (the hub's own window). M2 adds remote players, groups and the household key; the shapes below leave room for that but M1 implements only what is listed. Every HTTP body and every WebSocket message is validated with the zod schemas in `packages/shared/src/m1/` (names in **bold** below). Error envelope for every 4xx/5xx: `{ "error": { "code": string, "message": string, "retryAfterSec"?: number } }` (**ApiError**). Times are epoch milliseconds. IDs are strings.

## Roles and transport

| Role | How identified | Pages | WS |
|---|---|---|---|
| guest | server-issued signed `HttpOnly; SameSite=Lax` cookie `rj_guest` (**GuestCookie**: `{ guestId, iat }` + HMAC) | `/`, `/privacy` | `GET /ws?role=guest` |
| admin (phone) | cookie `rj_admin` after `POST /api/admin/login` | `/admin` | `GET /ws?role=admin` (cookie) |
| admin (desktop windows) | `Authorization: Bearer <adminToken>` (token returned by login when the request carries `X-Client: desktop`; held in the Electron main process) | `/settings` | `GET /ws?role=admin&token=` |
| player (M1: the hub's own TV window only) | query `player=<deviceId>&token=<deviceToken>`; in M1 the hub issues one local device token at setup and injects it into the TV window URL | `/tv` | `GET /ws?role=player&player=&token=` |
| setup | loopback source only, until a password exists | `/setup` | none |

Admin and setup routes and the player WebSocket apply the **household source gate** (loopback, the hub's own IPv4 subnets, 100.64.0.0/10; deny proxy headers and the Bot VPS peer). Guest routes are open on the LAN listener.

## Projections (what each role receives in WS `state` and `GET /api/session`)

**EntryPublic** `{ id, videoId, title, thumbnail?, durationSec?, requesterName: string|null, source: 'request'|'auto', status: 'queued'|'playing'|'done'|'skipped'|'failed', failReason?: string, enqueuedAt, startedAt?, mine?: boolean }` (`mine` is set per connection for guests; never includes guestId).

**EntryAdmin** = EntryPublic + `{ requesterGuestId: string|null, idempotencyKey?: string }`.

**GuestState** `{ revision, changeSeq, serverTime, protocolVersion, roomName, playback: { state: 'playing'|'paused'|'idle'|'blocked', nowPlaying: (EntryPublic & { startedAt: number, pausedAt: number|null, accumulatedPauseMs: number }) | null }, queue: EntryPublic[], recentHistory: EntryPublic[] /* last 10 */, search: { enabled: boolean, remaining: number|null, low: boolean }, limits: { maxPendingPerGuest, cooldownSec, maxDurationSec, allowDuplicates }, flags: { hasApiKey: boolean, publicMode: boolean } }`.

- `revision` = the core queue machine's revision (changes only when `nowPlaying` changes). `changeSeq` = a monotonically increasing counter bumped on **every** broadcast; clients resync when they miss one.

**AdminState** = GuestState with `queue: EntryAdmin[]`, `recentHistory: EntryAdmin[]`, plus `{ players: PlayerInfo[], fallback: { playlists: PlaylistInfo[], poolSize: number, consecutiveFailures: number }, searchUsage: { guests: number, owner: number, resetsAt: number }, settings: SettingsPublic, lastErrors: { at, videoId, code?: string, message }[] /* last 5 */ }`.

**PlayerInfo** `{ id, name, lanAddress: string|null, status: 'online'|'delayed'|'reconnecting'|'blocked'|'offline', role: 'leader'|'follower', lastSeen: number, drift: number|null }`.

**PlaylistInfo** `{ id, playlistId, title, url, videoCount, importedAt, lastError?: string }`.

**PlayerState** (TV page) `{ revision, changeSeq, serverTime, protocolVersion, roomName, playback: GuestState['playback'], upcoming: { title, requesterName }[] /* max 5 */, qr: { lanUrl: string, publicUrl: string|null, wifi: string|null /* full WIFI: payload */ }, partyCode: string|null, me: { playerId, role: 'leader'|'follower' }, status: PlayerInfo['status'], lastError: { code?: string, message, at }|null, selfTest: { autoplayBlocked: boolean } }`.

**SettingsPublic** (admin-visible subset; never contains the password verifier, the API key, tokens or the household key) `{ roomName, lanPort, country, limits: Limits (core), fallbackPlaylists: PlaylistInfo[], wifi: { ssid, security: 'WPA'|'WEP'|'nopass', hidden: boolean }|null /* password never echoed */, hasWifiPassword: boolean, hasApiKey: boolean, apiKeyLast4: string|null, tvDisplayId: number|null, autoStart: boolean, autoFullscreen: boolean, kiosk: boolean, publicMode: boolean, hubId, hubEpoch }`.

**SettingsPatch** = partial SettingsPublic with these write-only extras: `{ youtubeApiKey?: string|null, wifiPassword?: string|null }`.

## WebSocket messages

Server → client (**ServerMessage**, discriminated on `type`): `state { state: GuestState|AdminState|PlayerState }` (projection by role), `heartbeat { serverTime, changeSeq, revision }` every 5 s, `pong { t0, serverTime }`, `toast { level: 'info'|'warn'|'error', message, ttlMs }` (guest-visible confirmations and failures), `bye { reason }`.

Client → server (**ClientMessage**): `ping { t0 }`; player only: `position { position, playerState: number, revision }` once per second, `event { kind: 'ended'|'error'|'autoplayBlocked'|'playing'|'stalled', code?: number, revision }`. Anything else closes the socket with `bye { reason: 'bad-message' }`.

## HTTP routes

All bodies JSON. Idempotent commands carry `idempotencyKey` (uuid) and are safe to retry.

**Guest**
- `POST /api/guest/hello` **HelloBody** `{ name?: string }` → **HelloReply** `{ guestId, name: string|null, noticeAccepted: boolean }`; issues the cookie. `POST /api/guest/notice` `{ accepted: true }` records the first-visit acceptance. `POST /api/guest/name` `{ name: string|null }`. `POST /api/guest/forget` → `{ ok: true }` (deletes the guest row and attributions, keeps anonymised history and per-IP counters).
- `GET /api/session` → GuestState.
- `GET /api/videos/resolve?input=<url or id>` → **ResolveReply** `{ videoId, title, thumbnail?, channelTitle?, durationSec?: number|null, playable: boolean, reason?: PrescreenReason, source?: 'youtube'|'owner', message?: string }` (oEmbed title; `videos.list` pre-screen when a key exists).
- `POST /api/requests` **RequestBody** `{ videoId, idempotencyKey, name?: string }` → `201 { entry: EntryPublic, duplicate: boolean }` or `409/422/429` ApiError with `code` ∈ `too-many-pending|cooldown|duplicate|too-long|not-found|private|not-embeddable|age-restricted|live|region-blocked|queue-full`.
- `POST /api/search` **SearchBody** `{ q: string }` → **SearchReply** `{ results: VideoCard[], remaining: number|null, cached: boolean }` or `429 { code: 'search-budget'|'daily-quota' }` / `503 { code: 'search-disabled' }`. **VideoCard** `{ videoId, title, channelTitle, thumbnail, durationSec?: number|null, playable: boolean, reason?, source?, message? }` (unaltered order from YouTube; unplayable rows keep their position).
- `GET /api/search/suggest?q=` → **SuggestReply** `{ suggestions: string[] }` (at most 10; YouTube's typing suggestions, cached 10 min per normalised prefix; `[]` on any upstream failure) or `204` with no body when the same source IP asked less than 300 ms ago.
- `GET /api/privacy.json` → `{ updatedAt, sections: { heading, body }[] }` (the page renders this).

**Admin** (gate + auth)
- `POST /api/admin/login` **LoginBody** `{ password }` → `200 { ok: true, token?: string }` (token only for `X-Client: desktop`) or `401 { code: 'bad-password', retryAfterSec? }` / `429 { code: 'login-throttled', retryAfterSec }`.
- `POST /api/admin/logout`. `GET /api/admin/session` → AdminState.
- `POST /api/admin/transport` **TransportBody** `{ action: 'play'|'pause'|'skip', idempotencyKey }`.
- `POST /api/admin/queue/reorder` `{ id, toIndex, idempotencyKey }`; `DELETE /api/admin/queue/:id`.
- `POST /api/admin/requests` **RequestBody** (owner-added request; `requesterName: "Owner"`).
- `GET /api/admin/settings` → SettingsPublic; `PATCH /api/admin/settings` **SettingsPatch** → SettingsPublic (password change is separate: `POST /api/admin/password` `{ current, next }`, invalidates every session).
- `POST /api/admin/playlists` `{ url }` → PlaylistInfo (validates with one `playlistItems.list` call; `422 { code: 'playlist-private'|'playlist-not-found'|'no-api-key' }`); `DELETE /api/admin/playlists/:id`; `POST /api/admin/playlists/:id/refresh`.
- `POST /api/admin/search` **SearchBody** → SearchReply (owner reserve).
- `GET /api/admin/searches` → `{ guests, owner, resetsAt, dailyTotal }`.
- `POST /api/admin/backup` → `{ path, bytes, at }`; `GET /api/admin/backups` → `{ backups: { path, bytes, at }[] }`.
- `DELETE /api/admin/guests/:guestId` → `{ ok: true }`.
- `GET /api/admin/players` → `{ players: PlayerInfo[] }`.
- `GET /api/admin/lan` → `{ addresses: { interface, address, cidr }[], chosen: string, lanUrl }`; `PATCH` `{ chosen }` sets the QR address.
- `GET /api/admin/logs/tail?lines=500` → `{ lines: string[] }` (server log only in M1).

**Setup** (loopback only, 409 once a password exists)
- `GET /api/setup/status` → `{ needsSetup: boolean, lan: { addresses, chosen, lanUrl } }`.
- `POST /api/setup` **SetupBody** `{ password (min 8), roomName, youtubeApiKey?: string, fallbackPlaylistUrls?: string[], wifi?: { ssid, password, security, hidden }, noticeAccepted: true }` → `{ ok: true, token: string /* desktop admin token */, playerToken: string }`.

**Health**: `GET /healthz` → `{ ok, version, protocolVersion, needsSetup }`.

## Storage (server-owned, `node:sqlite`)

Tables: `settings` (single row, JSON columns; secrets in dedicated columns encrypted by the desktop with `safeStorage` before they reach the server, or stored plaintext when the server runs standalone in Docker), `guests` (guestId, name, ip, createdAt, noticeAcceptedAt, forgottenAt), `queue_entries`, `history`, `videos` (normalised metadata with `refreshed_at`), `fallback_playlists`, `fallback_videos` (playlistId → videoId order), `search_cache` (normalised q → videoId[] + fetchedAt), `search_usage` (per day), `players` (deviceId, name, tokenHash, createdAt, revokedAt), `admin_sessions` (tokenHash, createdAt, expiresAt, client), `login_attempts`, `events` (append-only audit of transitions and admin actions). Migrations `0001_init.sql` onward. Nightly `sqlite.backup()` at 04:00 to `<userData>/backups/`, keep 7.

## Desktop ↔ server (in-process) and IPC

The desktop passes to `buildApp`: `webRoot`, `dataDir`, `loggerInstance`, `disableRequestLogging: true`, `secrets: { encrypt(plain)→string, decrypt(cipher)→string }` (safeStorage), `lan: { addresses(): LanAddress[] }`, `hooks: { onSetupComplete, onSettingsChanged }`. Preload exposes `window.jukebox` with `selfcheck()`, `lastBeacon()`, `version()`, `openSettings()`, `adminToken()` (settings window only), `quit()`, `installUpdate()`.

## Out of scope for M1 (M2/M3)

Remote players and device-token pairing beyond the local TV window, groups/linking, replication, Become hub, beacon signing, public listener and party code, Cast, search-cache rehydration and the 30-day sweep, laptop `/settings` window (the desktop may ship a password-gated window that simply loads `/admin` with the bearer token), restore UI, diagnostics zip.
