# Room Jukebox

## What it is

Room Jukebox turns a Windows laptop plugged into a TV into a party jukebox. Guests scan a QR code
and request songs from their phones; the laptop plays them full screen on the TV, falling back to
automatic picks when the queue is empty. A second laptop can join as an extra player in another
room.

This repository is a pnpm monorepo:

| Path              | What lives there                                                                   |
| ----------------- | ---------------------------------------------------------------------------------- |
| `apps/desktop`    | Electron shell (windows, tray, kiosk, updater, embedded server)                    |
| `apps/server`     | Fastify HTTP + WebSocket hub                                                       |
| `apps/web`        | React + Vite SPA: `/tv`, `/` (guests), `/admin`, `/setup`, `/settings`, `/privacy` |
| `packages/core`   | Pure domain logic (queue, revisions, sync math), no I/O                            |
| `packages/shared` | zod schemas and types shared by everything, including `PROTOCOL_VERSION`           |

## Owner setup (Windows)

1. Download `RoomJukebox-Setup-<version>.exe` (from GitHub Releases, or during M0 from the
   `Public\RoomJukebox` share on Tango) and run it. The app is unsigned: on the SmartScreen prompt
   choose **More info**, then **Run anyway**. If Smart App Control is On, Windows refuses to run it
   at all.
2. The installer is per-user. Near the end it asks **once** for administrator rights (UAC) to add two
   inbound Windows Firewall rules for `Room Jukebox.exe`, valid on every network profile (Windows 11
   treats new networks as Public):
   - `Room Jukebox (TCP)`: any local port, from the local subnet and Tailscale (`100.64.0.0/10`);
   - `Room Jukebox (UDP beacon)`: UDP port 41234, from the local subnet.

   Silent auto-updates never ask again. Uninstalling asks for UAC a second time to remove the rules.
   If you decline the prompt the install still finishes and tells you to use _Fix firewall_ below.

3. Plug the laptop into the TV. The TV window opens on the display chosen in settings (default: the
   first display that is not the Windows primary display, i.e. the TV when the laptop screen is
   primary) and follows the TV when it is unplugged or reconnected. With _Auto fullscreen_ on it is
   full screen; with _Kiosk_ on it is also always on top and Esc, F11 and Alt+F4 do nothing. If
   anything else takes it out of full screen, it goes back after 5 seconds.
4. Everything is controlled from the **tray icon** (the music note next to the clock; it may be
   under the ^ arrow). _Show TV_ brings the TV window back to full screen. _Leave fullscreen_,
   _Settings_, _Check for updates_ and _Quit_ ask for the owner password first; after a correct
   password the app does not ask again for 10 minutes of activity. Closing the TV window does
   nothing; quit from the tray. _Settings_ opens the admin page in its own window, which closes
   itself after 10 minutes without use.
5. **Auto-start:** turn on _Start with Windows_ in settings. **Updates** come from GitHub Releases:
   the app checks at start and every 6 hours, refuses any update whose `latest.yml` is not signed by
   the release job, downloads when the room is quiet (no guest request for 2 hours while a fallback
   track plays) and installs when quiet between 05:00 and 12:00, at any hour while the TV is
   unplugged, or at once with _Update now_. An update already downloaded installs at the next start.
   To change how updates install, use Admin → What's new → Updates (mode Immediate / Quiet hours / Off; feed Tango or GitHub); the same values live in
   `%APPDATA%\RoomJukebox\desktop-state.json` (manual _Check for updates_ still works).
6. **Port in use:** the hub listens on port 8080. If another program holds it, the app retries for
   30 seconds and then shows an error page; change the port in settings (applies after a restart),
   or quit from the tray, set `"lanPort": 8081` in `desktop-state.json` and start the app again.
   If the app fails to start three times within five minutes it stops restarting itself and shows
   the log folder.

### Fix firewall

If phones or the other laptop cannot reach the app (or you clicked _Cancel_ on the Windows Security
Alert, which creates a Block rule), open PowerShell **as administrator** and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Room Jukebox\resources\fix-firewall.ps1"
```

(Adjust the path if the app is installed elsewhere; `-ProgramPath <path to Room Jukebox.exe>`
overrides the executable.) It deletes every firewall rule bound to `Room Jukebox.exe` and re-adds the
two Allow rules.

### Friendly address

Optional. If your router is a UniFi UDM you can give the jukebox a readable address such as
`jukebox.home` instead of `192.168.1.20:8080`.

1. Give the laptop a DHCP reservation first (UniFi Network app → Client Devices → the laptop →
   Settings → Fixed IP Address) so its IP does not change.
2. UniFi Network app → Settings → Routing → DNS → Create New DNS Record. Type **A**, Name
   `jukebox.home` (or any name), IP = the laptop's reserved IP.
3. In the jukebox admin page: Settings → Friendly address, type the same name and Save.

The page shows a green check when the name points at this laptop, otherwise the exact record to add.
Until the check passes the TV keeps showing the IP address, so nothing breaks if the record is
missing or the laptop moves to another network. The app also answers `jukebox.local` on the local
network (mDNS) without any router setup; Android ignores `.local` names, so use the DNS record
there.

### Command-line flags (M0)

Add them to the shortcut's _Target_ after the closing quote of the exe path:

| Flag                        | Effect                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `--mode=hub` (default)      | Runs the embedded server on `LAN_PORT` (env, default 8080) and broadcasts the UDP beacon    |
| `--mode=player --hub=<url>` | Player only, e.g. `--hub=http://192.168.1.20:8080`; serves the page from `127.0.0.1`        |
| `--display=<id>`            | Forces the TV display (ids are listed in `selfcheck.json` and the log)                      |
| `--kiosk`                   | Forces kiosk + always on top (overrides the setting); Esc, F11 and Alt+F4 are ignored       |
| `--windowed`                | A 1280x720 window instead of full screen (testing without a TV)                             |
| `--occlusion-fix`           | Disables `CalculateNativeWinOcclusion` (gate 8: playback stalls when the window is covered) |

Logs are in `%APPDATA%\RoomJukebox\logs`: `main.log` (rotated at 10 MB, 10 files kept, including the
TV page's console) and `selfcheck.json` (SQLite, argon2/scrypt, versions, displays, network adapters
and the Windows network category, written at every start).

## First run

On the first start the TV window opens as a normal window showing the setup wizard (`/setup`,
reachable only from the laptop itself). It walks through the room name, the owner password (at
least 8 characters), the optional YouTube API key, fallback playlists and the Wi-Fi details for the
QR code. When you finish, the window switches to the TV page on its own and goes full screen.
The Wi-Fi QR joins WPA2 networks; a WPA3-only network needs the WPA3 choice. If a phone opens its
settings but does not join, forget the saved network on the phone or type the password shown.

The app stores its device tokens in `%APPDATA%\RoomJukebox\desktop-state.json`, encrypted with
Windows DPAPI (`safeStorage`) for your Windows account; the hub data (settings, queue, history) lives
in `%APPDATA%\RoomJukebox\data`. If DPAPI is unavailable the log says so loudly and the secrets are
stored unencrypted. Before setup there is no password, so the tray actions work without one.

## Phones

Guests join by scanning the QR codes on the TV: **Join the Wi-Fi** (when the owner entered the venue
Wi-Fi in settings), then **Request a song**. No app install and no account are needed; the page
follows the phone's light or dark setting.

1. The first visit shows a short notice (YouTube Terms of Service and the Room Jukebox privacy
   policy). Tap **Continue**; the phone remembers it.
2. Type a song or artist into **Search YouTube for a song** at the top. As you type, suggestions
   drop down under the box like on YouTube; tap one (or pick it with the arrow keys and Enter), or
   finish typing and tap **Search** (or press Enter).
3. Results appear in YouTube's order, thumbnail on the left. Songs that cannot play here (too long
   for this room, age-restricted, not allowed outside YouTube, live, private) stay in the list,
   greyed, with the reason in plain words, and cannot be tapped.
4. Tap a result. The **Request this song?** card shows the title, length and whether it can play;
   tap **Request it**. A short "Added: …" message confirms it, and the results stay so you can add
   another one.

**Have a link? Paste it** sits under the results: tap **Find on YouTube** (the YouTube app or
m.youtube.com opens), then in YouTube **Share → Copy link**, come back and tap **Paste link**. If
the phone refuses to let the page read the clipboard (some browsers on plain `http://`), paste the
link into the box under **Paste link** instead. When search is turned off this section comes first
("Search is off; paste a link instead"); when search is resting for the day it moves right under
the search box. When the owner has switched search to the YouTube API (admin → Settings → **Search
source**), a small banner warns when today's searches are almost used up.

Under the results come Now Playing and the live queue (your own requests are highlighted); while
results are on screen they fold into a small **Now playing: …** bar at the bottom, tap it to open
them. Further down is an optional name field. **More → Forget me** at the bottom deletes what Room Jukebox stored about you
(it does not affect data stored by YouTube). The small **Owner login** link at the very bottom
opens `/admin`, which works only from the party Wi-Fi or the laptop itself.

Owner pages: `/admin` on a phone (password), `/setup` on the hub laptop at first run, `/privacy`
for everyone. The M0 diagnostics pages stay at `/spike` and `/tv-spike`.

For web development without a server, `VITE_MOCK=1 pnpm --filter web dev` runs the pages against an
in-browser mock hub (`apps/web/src/dev/mock.ts`; owner password `jukebox1`, `/setup?mocksetup=1`). The mock
starts on the YouTube-page search source and suggests completions for any 2+ characters. Search
words flip the mock's modes: `budget`, `down`, `off` (guest search off until reload), and, after
picking an API source in Settings, `quota` (answers via the results page from then on), `low`,
`zero`.

## Troubleshooting

Logs live in `%APPDATA%\RoomJukebox\logs`; settings and the tray offer _Download diagnostics_ and
_Fix firewall_. The hub's database is `data.db` in the data folder (`%APPDATA%\RoomJukebox` on
Windows, `DATA_DIR` or `./data` standalone), with nightly 04:00 backups in `backups\` (7 kept).

| Symptom                                            | Likely cause                                                                                                          | Fix                                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin page says _only works from the home network_ | 403 `forbidden-source`: the phone is on another subnet, or a proxy/tunnel added `X-Forwarded-For`, `Via`, `Cf-*`      | Join the same Wi-Fi as the hub laptop; admin never works through a tunnel                                                                                 |
| _Too many wrong passwords_                         | 5 failed logins from one device; each further failure doubles the wait (max 15 min)                                   | Wait the time shown, then sign in; a correct password resets the counter                                                                                  |
| Signed out on every device                         | The owner password was changed (every session is invalidated) or the 12 h session expired                             | Sign in again; the desktop's own token is renewed by the app                                                                                              |
| `/setup` answers 409                               | A password already exists                                                                                             | Use `/admin`; to start over, quit the app and delete `data.db` (a backup is in `backups\`)                                                                |
| Search box missing on phones                       | Search source is _API only_ and there is no API key, or today's API budget is used up (resets at midnight Pacific)    | Admin → Settings → Search source: _YouTube page (unlimited)_, or add the key; guests can always use _Find on YouTube_ + _Paste link_                      |
| Search says _YouTube search is not answering_      | YouTube's results page did not answer or changed its layout (502 `youtube-unavailable`)                               | Try again in a minute; if it persists, switch Search source to _API first, then page_ (needs a key); paste-a-link keeps working                           |
| No suggestions under the search box                | YouTube's suggest service did not answer (suggestions fail quietly), or fewer than 2 characters typed                 | Nothing to fix: tap **Search** to search what you typed                                                                                                   |
| "Several videos in a row failed" on the TV         | 5 consecutive fallback videos failed (removed, private, embedding off)                                                | Press _Start Music_ or play from admin; check _Last errors_ in admin and refresh or replace the fallback playlist                                         |
| TV shows _Reconnecting_ after the app restarted    | The TV window reconnects within 10 s; otherwise the interrupted song is restarted once, then skipped on a 2nd restart | Wait a few seconds; if it stays, reload the TV window                                                                                                     |
| QR code points at the wrong address                | The laptop has several adapters (VPN, Docker, VirtualBox)                                                             | Admin → LAN: choose the Wi-Fi address                                                                                                                     |
| Restore a backup by hand (M1)                      | Settings or queue lost                                                                                                | Quit the app, copy a file from `backups\` over `data.db`, delete `data.db-wal` and `data.db-shm`, start the app (the API key needs the same Windows user) |

**Search source.** Admin → Settings → **Search source** picks where search goes
(`search.source` in `PATCH /api/admin/settings`):

- **YouTube page (unlimited)** (`page`, the default): the hub reads YouTube's public results page
  (`youtube.com/results`) for every search, guests and owner alike. No daily limit and no API key
  needed; the API key, when present, is still used to check each result (`videos.list`) and for
  playlist import, but never for search.
- **API first, then page** (`api-first`): the official YouTube Data API while today's budget lasts,
  then the results page (also when no key is set or YouTube reports `quotaExceeded`).
- **API only (about 100 a day)** (`api-only`): the Data API with no fallback; search stops at the
  daily budget and is off without a key.

Typing suggestions always come from YouTube's suggest service (`GET /api/search/suggest`, no
quota). The results and suggest pages are not official APIs: they can stop working without notice
whenever YouTube changes them; then search answers _YouTube search is not answering right now_
(502 `youtube-unavailable`) and suggestions simply stop appearing, while paste-a-link keeps working.
Results from either source are cached for 24 h, and the per-guest time between searches still
applies. Older clients may still send `{"search": {"unofficialFallback": true|false}}`, which maps
to `api-first` / `api-only`; settings saved by 0.0.5 are migrated on start (an explicit "off"
becomes `api-only`, everything else the new default `page`).

### M0 spike pages (temporary)

Off by default from M1: the spike routes exist only with `buildApp({ spike: true })` (standalone:
`SPIKE=1`). **No authentication:** every `/api/spike/*` route and the role-less `/ws` socket accept
anyone who can reach port 8080 on the LAN. Only run the spike on a trusted network.

| Page                        | URL                                                              | Purpose                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control                     | `http://<hub>:8080/spike`                                        | Play (matrix picker or any video ID), Pause, Resume, Seek ±10 s, Next, **Run matrix** (20 videos × 25 s), live player/drift table, results table, _Copy results as Markdown_ |
| TV player                   | `http://127.0.0.1:<port>/tv?player=<name>`                       | One YouTube player on the left 75 %, status column on the right; follows the hub                                                                                             |
| TV player on another laptop | `http://127.0.0.1:<port>/tv?player=<name>&hub=<hub-lan-ip>:8080` | Loopback page that talks to a hub on another laptop (gate 11)                                                                                                                |

Optional TV query parameters for tuning the sync rule: `deadband` (seconds, default 1.25),
`minseek` (ms between seeks, default 2500) and `lead` (seconds added to the seek target, default 0).

Results are appended to `spike-results.jsonl` in `SPIKE_DATA_DIR` (default `./data`, relative to
the server's working directory); `GET /api/spike/results` returns them and the Clear button on
`/spike` empties the file.

| Symptom                              | Likely cause                                                               | Fix                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Status column says _Looking for hub_ | Wrong `hub=` value, hub not running, or the firewall blocks 8080           | Open `http://<hub-ip>:8080/healthz` from the same laptop; fix the address or run _Fix firewall_ |
| _Reconnecting_ that never clears     | Hub restarted or Wi-Fi dropped                                             | The page retries with backoff up to 30 s; reload if it stays more than a minute                 |
| _Press Start Music_                  | The browser blocked autoplay with sound                                    | Click the button or press any key; Electron windows should not need it                          |
| Error 153                            | The page was opened from `file://`, a custom scheme, or without a referrer | Open it from `http://127.0.0.1:<port>` or `http://localhost:<port>`                             |
| Error 101/150                        | The video owner disallows embedding (or it is age-restricted)              | Expected for some videos; the hub skips to the next one                                         |
| _Delayed_ on one laptop              | An ad, buffering, or a hand pause on that laptop                           | Leave it: it rejoins at the live position once it plays again                                   |

## Development

The build host has no Node installed, so every Node command runs in a throwaway `node:24` Docker
container through `scripts/dev.sh`:

```sh
scripts/dev.sh pnpm install
scripts/dev.sh pnpm -r lint
scripts/dev.sh pnpm -r typecheck
scripts/dev.sh pnpm -r test
scripts/dev.sh pnpm --filter web build
```

`scripts/dev.sh` bind-mounts the repository at `/work`, keeps the pnpm store in the named Docker
volume `room-jukebox-pnpm-store`, sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and `CI=1`, enables pnpm
through corepack and then runs the arguments you pass. Files it creates are owned by root.

If you do have Node 24 locally, `corepack enable` followed by the same `pnpm` commands works
without Docker. The server can be started with `pnpm --filter server start` (it listens on
`LAN_PORT`, default 8080, on `0.0.0.0`; Node runs the TypeScript sources directly via type
stripping).

### Desktop shell

`pnpm --filter desktop build` builds the SPA (`pnpm --filter web build`) and then bundles the
Electron main process and preload with esbuild into `apps/desktop/dist/main.cjs` and
`dist/preload.cjs`. The bundle includes `apps/server`, `packages/core` and `packages/shared`, so
the packaged app ships no workspace `node_modules`; the built SPA is copied to `resources/web` by
electron-builder (`extraResources`). In a checkout the shell serves `apps/web/dist` instead.

To cross-build the unsigned Windows installer on Tango (Linux, through Wine):

```sh
scripts/build-win.sh
```

It runs the build above in the dev container, then `electron-builder --win --x64 --publish never` in
the `electronuserland/builder:wine` image (Electron downloads are cached in the Docker volumes
`room-jukebox-electron-cache` and `room-jukebox-electron-builder-cache`) and copies
`RoomJukebox-Setup-<version>.exe` and `latest.yml` to `/mnt/user/Public/RoomJukebox` (`OUT_DIR`
overrides it). It takes about two and a half minutes.

Electron itself (windows, displays, firewall, autoplay) cannot be exercised in the container. They are built by
`.github/workflows/release.yml` on a Windows runner when a `v*` tag is pushed, which publishes a
**draft** GitHub Release with a signed `latest.yml`.

## YouTube API terms and privacy

Room Jukebox plays music through the official YouTube embedded player. By using it you agree to
the [YouTube Terms of Service](https://www.youtube.com/t/terms) and the
[Google Privacy Policy](https://policies.google.com/privacy). The app's own privacy notice is shown
at `/privacy`. It stores only what is needed to run the party on the owner's laptop (the queue,
request names guests choose to type, and settings); nothing is sent anywhere other than YouTube.
Each owner supplies their own YouTube API key (optional); keys are never committed to this
repository.

**How search works.** By default, search reads YouTube's public search results page and its
typing suggestions directly, the same pages a browser loads; it does not use the YouTube Data API
for search. Those pages are not covered by the YouTube API terms, reading them this way may
conflict with YouTube's terms of service for automated access, and search can break whenever
YouTube changes them. The owner can switch search to the official API in the admin settings
(**Search source**: _API first, then page_ or _API only_; the API allows about 100 searches a day
per key). With a key, the API is also used to check results before they can be requested and to
import fallback playlists. Playback always uses the official embedded YouTube player, whichever
search source is chosen.

## License

MIT, see [LICENSE](LICENSE).
