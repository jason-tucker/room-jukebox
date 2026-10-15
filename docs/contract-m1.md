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

**PlayerState** (TV page) `{ revision, changeSeq, serverTime, protocolVersion, roomName, playback: GuestState['playback'], upcoming: { title, requesterName }[] /* max 5 */, qr: { lanUrl: string, publicUrl: string|null, wifi: string|null /* full WIFI: payload */, wifiSsid: string|null }, partyCode: string|null, me: { playerId, role: 'leader'|'follower' }, status: PlayerInfo['status'], lastError: { code?: string, message, at }|null, selfTest: { autoplayBlocked: boolean } }`.

**SettingsPublic** (admin-visible subset; never contains the password verifier, the API key, tokens or the household key) `{ roomName, lanPort, country, limits: Limits (core), fallbackPlaylists: PlaylistInfo[], wifi: { ssid, security: 'WPA'|'WEP'|'nopass'|'SAE', hidden: boolean }|null /* password never echoed */, hasWifiPassword: boolean, hasApiKey: boolean, apiKeyLast4: string|null, tvDisplayId: number|null, autoStart: boolean, autoFullscreen: boolean, kiosk: boolean, publicMode: boolean, hubId, hubEpoch }`.

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

## M1.5 updater and release notes

Added 2026-10-14. Shapes are the zod schemas in `packages/shared/src/m1/api.ts`. Every `/api/admin/*` route below applies the household source gate and needs an admin session (bearer or `rj_admin` cookie), like the rest of the admin API.

**Release notes and test checklist**
- `GET /api/admin/release-notes` → **ReleaseNotesReply** `{ notes: ReleaseNotes|null, checklist: ChecklistState|null, installedVersion }`. `notes` are the bundled notes the desktop passes to `buildApp` (`null` on a standalone server). The server always sends a `checklist`: the stored one when its `version` equals `installedVersion`, otherwise an empty `{ version: installedVersion, done: {}, updatedAt: null }` (ticks from an earlier version are not carried over).
- `PATCH /api/admin/checklist` **ChecklistPatch** `{ version, done: { [itemId]: boolean } }` → **ChecklistState**. Merges `done` into the stored ticks and sets `updatedAt` (server time). `409 version-mismatch` when `version` is not the installed version. Stored in the `settings` row's JSON as `checklist: { version, done, updatedAt }`.

**Updater** (the desktop's auto-updater; a standalone server has none)
- `GET /api/admin/update-status` → **UpdateStatus** `{ mode: 'immediate'|'quiet'|'off', feed: 'tango'|'github', feedUrl, state: 'idle'|'checking'|'available'|'downloading'|'downloaded'|'installing'|'error'|'up-to-date', current, available: string|null, message: string|null, lastCheckAt: number|null }`. Without an updater: `{ mode: 'off', feed: 'tango', feedUrl: '', state: 'idle', current: <server version>, available: null, message: 'Updater not available (standalone server)', lastCheckAt: null }`.
- `POST /api/admin/update/check` `{}`, `POST /api/admin/update/install` `{}`, `POST /api/admin/update/mode` `{ mode }`, `POST /api/admin/update/feed` `{ feed, url?: string (URL) }` → the updater's **UpdateStatus** after the action. `503 updater-unavailable` without an updater; `502 update-failed` (the updater's error message) when the action throws. Each action is recorded in `events` as `admin.update`.

**Public**
- `GET /api/version` → `{ version, protocolVersion }` (no gate; the TV footer shows it).

**TV notices**: `/tv` shows WS `toast` messages of level `info` (and `info` toasts from the desktop bridge's `onToast`) bottom-right in the side column for `ttlMs`; the desktop uses this for "Updating in 15 s" and "Updated to x.y.z". The guest page shows nothing about updates.

**Desktop → `buildApp` options**: `releaseNotes?: ReleaseNotes` and `updater?: { status(): UpdateStatus, checkNow(): Promise<void>, installNow(): Promise<void>, setMode(mode): void, setFeed(feed, url?): void }` (exported as `UpdaterApi`). Both optional.

## 0.0.9 YouTube mirror (`/yt/*`)

Added 2026-10-15. Implemented in `apps/server/src/youtube/mirror.ts` (proxy) and `mirror-scripts.ts` (injected scripts). Like the page search it is not an API and breaks YouTube's terms; it can stop working whenever YouTube changes its mobile site.

**Routes** (LAN listener, no gate, no auth; token bucket per source IP: burst 60, 30 req/s; `429` with `Retry-After: 1` beyond):
- `GET|POST /yt/*` → `https://m.youtube.com/*` (`/s/player/*`, `/s/desktop/*`, `/yts/*` → `https://www.youtube.com`). `/yt/_suggest/*` → `https://suggestqueries-clients6.youtube.com/*`, `/yt/_gstatic/youtube/img/*` → `https://www.gstatic.com/youtube/img/*` (both fetched by YouTube's page with CORS). `GET /yt` → `302 /yt/`.
- Root aliases for calls YouTube's code still aims at the hub root: `GET|POST /youtubei/*`, `/s/*`, `/sw.js` are proxied like `/yt/…`; `GET /results`, `/watch`, `/shorts/*` → `302 /yt/<same path and query>`.
- Answered locally, never forwarded: `/yt/sw.js` (empty script), telemetry/ads/player (`/youtubei/v1/log_event`, `/youtubei/v1/att/*`, `/youtubei/v1/player`, `/api/stats/*`, `/ptracking`, `/generate_204`, `/csi_204`, `/error_204`, `/pagead/*`, `/web-reports`) → `204`; `/yt/watch?v=<id>`, `/yt/shorts/<id>`, `/yt/live/<id>`, `/yt/embed/<id>`, `/yt/playlist…` → a tiny HTML page (`<meta name="rj-mirror-watch">`) that posts `{ type: 'rj-pick', videoId, title: '' }` to `parent` and goes `history.back()`.
- Upstream unreachable → `502` HTML with `<meta name="rj-mirror-error" content="…">`.
- Settings `search.mirror === false` → every route above answers `404` (JSON `not-found` for `/yt/*`, empty for the root redirects).

**Upstream request**: method, query and body passed through (a `Content-Encoding: gzip` body is gunzipped; JSON/text bodies get `<origin>/yt` and `<origin>` replaced by `https://m.youtube.com`); headers: mobile Chrome `User-Agent` (Android 14, Chrome 141), `Accept-Language: en-US,en;q=0.9`, `Accept-Encoding: identity`, `Origin`/`Referer` `https://m.youtube.com`, plus the phone's `Content-Type`, `Accept`, `X-YouTube-*`, `X-Goog-*` and `X-Origin` (rewritten to `https://m.youtube.com`). `Cookie`: `SOCS=CAI; CONSENT=YES+cb; PREF=f5=30000&hl=en&gl=US` overlaid with the phone's cookies, minus `rj_guest`/`rj_admin`. Redirects are not followed (15 s timeout).

**Response**: status as upstream. Headers allowlisted: `Content-Type`, `Cache-Control`, `Expires`, `Last-Modified`, `ETag`, `Content-Disposition`, `X-Content-Type-Options` (so `X-Frame-Options`, `Content-Security-Policy(-Report-Only)`, `Cross-Origin-*-Policy`, `Strict-Transport-Security`, `Report-To`, `NEL`, `Alt-Svc`, … never reach the phone). `Location` → `/yt/…` for YouTube hosts and root-relative targets. `Set-Cookie` re-scoped: `Domain`, `Secure`, `Partitioned` and `SameSite=None` dropped, `Path` and the rest kept; `__Secure-`/`__Host-` cookies and hub cookie names dropped. `GET /s/*` and `/static/*` 200s without cookies are cached in memory (48 MB LRU, keyed by origin + path).

**Rewrite rules** (bodies with `Content-Type` `text/html`, `text/css`, `text/javascript`, `application/(x-)javascript`, `application/json`, `text/plain`):
1. `(https?:)?//` + `m.youtube.com` | `www.youtube.com` | `youtube.com` (not followed by `[\w.-]`) → `<origin>/yt`; `suggestqueries-clients6.youtube.com` → `<origin>/yt/_suggest`; `www.gstatic.com` when followed by `/youtube/img/` → `<origin>/yt/_gstatic`. The slashes may be `/`, `\/`, `\x2F` or `\u002F`; the replacement keeps the escaping of the match. `<origin>` = `http://<Host header>`. Untouched: `i.ytimg.com`, `yt3.ggpht.com`, `*.googlevideo.com`, `fonts.gstatic.com`, other `*.youtube.com` hosts, URL-encoded (`%2F`) forms.
2. HTML only: `src|href|action|poster="/x"` (root-relative, not `//`, not already `/yt/`) → `/yt/x`; every `<base>` → `<base href="<origin>/yt/">`; right after `<head>`: `<meta name="referrer" content="no-referrer">` + the head script; before the last `</body>`: the pick script.

**Head script** (runs before YouTube's): `history.replaceState` from `/yt/<path>` to `/<path>` so YouTube's router sees its own URLs; `fetch` (streamed request bodies are buffered, Chrome only streams over HTTP/2), `XMLHttpRequest.open`, `sendBeacon`, `Worker`, script/link/img/iframe/source `src`/`href` setters and `setAttribute` send hub-root and YouTube URLs to `/yt/…`; `pushState`/`replaceState` to `/watch`, `/shorts/`, `/playlist` become a pick and do not happen; `navigator.serviceWorker.register` rejects; `window.open` returns null; `HTMLMediaElement.play` rejects; plain link clicks YouTube didn't handle stay under `/yt`.

**Pick script**: capture-phase `click` on `window`; the tap target or an ancestor that is an `<a href>` with `?v=<id>`/`/shorts/<id>`, or carries `data-video-id`/`video-id`/`data-videoid`/`data-vid`, or a `ytm-*` video renderer containing such an anchor, resolves to `videoId`; taps inside menus (`ytm-menu-renderer`, `[aria-haspopup]`, menu/action buttons) are ignored. Title: the renderer's `.compact-media-item-headline`, `.media-item-headline`, `h3`/`h4`/`[role=heading]` text, else the anchor's `aria-label` up to " - <duration>". `preventDefault` + `stopImmediatePropagation`, then `parent.postMessage({ type: 'rj-pick', videoId, title }, '*')`; the same ID within 500 ms is sent once.

**Guest page**: `GuestState.flags.mirror?: boolean` (absent before 0.0.9 = on). The Browse panel is an `<iframe src="/yt/results?search_query=" sandbox="allow-scripts allow-same-origin allow-forms">`; it accepts `rj-pick` only from its own frame's window (origin = page origin), opens the request sheet with the message's title, then `GET /api/videos/resolve?input=<id>` for the verdict, and `POST /api/requests` on confirm. No `load` within 8 s, or a first page with `meta[name=rj-mirror-error]` or without the head script → the panel closes with "YouTube didn't load; use the search below". `localStorage['rj.browse'] = '1'` opens the panel on the next visit (cleared on that failure).

**Settings**: `SettingsPublic.search.mirror?: boolean` (server always sends it; default `true`). `SettingsPatch.search` also accepts `{ source, mirror? }` and `{ mirror }`; stored in the settings JSON as `search.mirror`.

