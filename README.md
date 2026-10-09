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

_To be written during M0._ It will cover downloading the installer from GitHub Releases, the
SmartScreen "More info, then Run anyway" prompt (the app is unsigned), Smart App Control, the
single UAC prompt that adds the firewall rules, and display/power settings.

## First run

_To be written during M0/M1._ The setup wizard (`/setup`) walks through naming the room, the owner
password, the YouTube API key and the TV display.

## Phones

_To be written during M1._ Guests join by scanning the QR code shown on the TV; no app install is
needed.

## Troubleshooting

_To be written as issues are found._ Logs live in `%APPDATA%\RoomJukebox\logs`; settings and the
tray offer _Download diagnostics_ and _Fix firewall_.

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

Electron and the Windows installer cannot be exercised in the container. They are built by
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
