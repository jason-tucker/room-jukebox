# Releases

One section per version, newest first. `scripts/release-notes.mjs` turns the **current** version's section into `apps/desktop/build/release-notes.json` at build time (bundled into the installer), and `scripts/build-win.sh` copies the same text into `latest.yml` as `releaseNotes`. Keep every checklist line short and testable on the laptop or a phone.

## 0.0.8 — 2026-10-14

### Changes
- Auto-updater: the app checks Tango's update feed every 10 minutes in test mode, verifies the signed feed, downloads, shows a 15-second notice and installs the new version in place.
- What's new tab in admin with a test checklist that remembers what you verified.
- TV shows a short "Updated to x.y.z" notice after an update.

### Test
- The TV showed "Updated to 0.0.8" after the update installed on its own.
- Admin → What's new lists this checklist; ticking an item survives a page reload.
- Admin → Settings shows update mode "Immediate (testing)" and the Tango feed address.
- Search: type two letters and suggestions appear; pick one and results show.
- Tap a result, confirm, and the song queues after the current one.
- Wi-Fi QR: a phone that was on cellular joins the network from the TV's code.
- Relaunch the app: the song resumes without looping the first seconds.
