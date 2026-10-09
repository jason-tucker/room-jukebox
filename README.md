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

_M0 throwaway build; the full owner guide is written in M1._

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

3. Plug the laptop into the TV. The player window opens full screen on the first display that is not
   the Windows primary display (the TV, when the laptop screen is primary) and follows the TV when
   it is unplugged or reconnected.

### Fix firewall

If phones or the other laptop cannot reach the app (or you clicked _Cancel_ on the Windows Security
Alert, which creates a Block rule), open PowerShell **as administrator** and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Room Jukebox\resources\fix-firewall.ps1"
```

(Adjust the path if the app is installed elsewhere; `-ProgramPath <path to Room Jukebox.exe>`
overrides the executable.) It deletes every firewall rule bound to `Room Jukebox.exe` and re-adds the
two Allow rules.

### Command-line flags (M0)

Add them to the shortcut's _Target_ after the closing quote of the exe path:

| Flag                        | Effect                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `--mode=hub` (default)      | Runs the embedded server on `LAN_PORT` (env, default 8080) and broadcasts the UDP beacon    |
| `--mode=player --hub=<url>` | Player only, e.g. `--hub=http://192.168.1.20:8080`; serves the page from `127.0.0.1`        |
| `--display=<id>`            | Forces the TV display (ids are listed in `selfcheck.json` and the log)                      |
| `--kiosk`                   | Kiosk + always on top; Esc, F11 and Alt+F4 are ignored, **Ctrl+Shift+Q** quits (M0 only)    |
| `--windowed`                | A 1280x720 window instead of full screen (testing without a TV)                             |
| `--occlusion-fix`           | Disables `CalculateNativeWinOcclusion` (gate 8: playback stalls when the window is covered) |

Logs are in `%APPDATA%\RoomJukebox\logs`: `main.log` (rotated at 10 MB, 10 files kept, including the
TV page's console) and `selfcheck.json` (SQLite, argon2/scrypt, versions, displays, network adapters
and the Windows network category, written at every start).

## First run

_To be written during M0/M1._ The setup wizard (`/setup`) walks through naming the room, the owner
password, the YouTube API key and the TV display.

## Phones

_To be written during M1._ Guests join by scanning the QR code shown on the TV; no app install is
needed.

During M0 a phone on the same Wi-Fi can open the spike control page at
`http://<hub-lan-ip>:8080/spike` to play, pause, seek and skip. Phones never embed the YouTube
player themselves, so the raw LAN IP is fine for them.

## Troubleshooting

_To be written as issues are found._ Logs live in `%APPDATA%\RoomJukebox\logs`; settings and the
tray offer _Download diagnostics_ and _Fix firewall_.

### M0 spike pages (temporary, removed in M1)

**No authentication in M0:** every `/api/spike/*` route and the `/ws` socket accept anyone who can
reach port 8080 on the LAN. Only run the spike on a trusted network.

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

Room Jukebox plays music through the official YouTube embedded player and searches through the
YouTube Data API. By using it you agree to the
[YouTube Terms of Service](https://www.youtube.com/t/terms) and the
[Google Privacy Policy](https://policies.google.com/privacy). The app's own privacy notice is shown
at `/privacy`. It stores only what is needed to run the party on the owner's laptop (the queue,
request names guests choose to type, and settings); nothing is sent anywhere other than YouTube's
APIs. Each owner supplies their own YouTube API key; keys are never committed to this repository.

## License

MIT, see [LICENSE](LICENSE).
