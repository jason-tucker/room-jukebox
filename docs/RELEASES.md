# Releases

One section per version, newest first. `scripts/release-notes.mjs` turns the **current** version's section into `apps/desktop/build/release-notes.json` at build time (bundled into the installer), and `scripts/build-win.sh` copies the same text into `latest.yml` as `releaseNotes`. Keep every checklist line short and testable on the laptop or a phone.

## 0.0.9 — 2026-10-15

### Changes
- Browse YouTube: a big button on the guest page opens YouTube's mobile site inside the jukebox page (passed through the hub). Search there like on YouTube.
- Tapping a video in Browse asks "Request this song?"; Yes queues it and you stay in YouTube for the next pick.
- If YouTube doesn't load within 8 seconds the panel closes and the search box below takes over; the owner can turn Browse off in admin → Settings → Search source.
- Optional friendly address: Settings → Friendly address (for example `jukebox.home`) checks that your router's DNS record points at this laptop; the TV then prints and encodes that name instead of the IP address.
- The hub also answers `jukebox.local` on the local network (mDNS; Android ignores `.local`).
- Admin → Queue: every row has a labelled Remove button (asks to confirm).

### Test
- Samsung: tap Browse YouTube; YouTube's search bar shows inside the page.
- iPhone: tap Browse YouTube; YouTube's search bar shows inside the page.
- Search inside Browse; suggestions drop down and results appear.
- Tap a result: the "Request this song?" card shows its title.
- Tap Request it: "Added: …" shows and YouTube is still open behind it.
- Tap a second result without reloading; it queues too.
- Tap Done: the guest page is back; reopening the page opens Browse directly.
- The search box under Browse still finds and queues a song.
- Settings → Friendly address `jukebox.home` + UDM record → TV shows http://jukebox.home:8080 and a phone opens it.
- Admin → Queue: Remove on a row asks to confirm and takes the song out of the queue.

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
