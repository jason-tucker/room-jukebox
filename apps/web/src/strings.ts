/**
 * Every user-visible string of the M1 pages (the M0 spike pages keep their own debug text).
 * Plain words, no jargon: guests are at a party, the owner is not a developer.
 */
import { fmtClock, fmtDuration } from './lib/format.ts';

export const LINKS = {
  youtubeTerms: 'https://www.youtube.com/t/terms',
  googlePrivacy: 'https://policies.google.com/privacy',
  googleActivity: 'https://myactivity.google.com/',
  youtube: 'https://www.youtube.com/',
  findOnYouTube: 'https://m.youtube.com/results?search_query=',
  brandingGuidelines: 'https://developers.google.com/youtube/terms/branding-guidelines',
  cloudConsole: 'https://console.cloud.google.com/',
} as const;

export const S = {
  app: {
    name: 'Room Jukebox',
    loading: 'Loading…',
    retry: 'Try again',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    saved: 'Saved',
    remove: 'Remove',
    back: 'Back',
    next: 'Next',
    yes: 'Yes',
    working: 'Working…',
  },

  attribution: {
    label: 'Developed with YouTube',
    openVideo: 'Open this video on YouTube',
  },

  footer: {
    terms: 'YouTube Terms of Service',
    googlePrivacy: 'Google Privacy Policy',
    privacy: 'Room Jukebox privacy',
    more: 'More',
    ownerLogin: 'Owner login',
  },

  notice: {
    title: 'Welcome to the jukebox',
    bodyBefore: 'By continuing you agree to the ',
    terms: 'YouTube Terms of Service',
    bodyMiddle: ' and the ',
    privacy: 'Room Jukebox privacy policy',
    bodyAfter: '.',
    continue: 'Continue',
  },

  guest: {
    find: 'Find on YouTube',
    findHint: 'Find your song in YouTube, then come back here.',
    paste: 'Paste link',
    pasteHint: 'Tap after you copied the link in YouTube.',
    stepsTitle: 'How to request a song',
    steps: [
      { title: 'Search', body: 'Tap Find on YouTube and look up your song.' },
      { title: 'Share', body: 'Under the video, tap Share.' },
      { title: 'Copy link', body: 'Tap Copy link, come back here and tap Paste link.' },
    ],
    manualLabel: 'Or paste the link here',
    manualPlaceholder: 'https://youtu.be/…',
    manualSubmit: 'Check link',
    clipboardDenied:
      "Your phone didn't let us read the copied link. Paste it into the box below instead.",
    clipboardEmpty: 'Nothing is copied yet. In YouTube tap Share, then Copy link.',
    notYouTube: "That doesn't look like a YouTube link. Copy the link from YouTube's Share button.",
    resolving: 'Looking up the song…',
    nameLabel: 'Your name (optional)',
    namePlaceholder: 'Shown next to your requests',
    nameSave: 'Save name',
    nameSaved: 'Name saved',
    nowPlaying: 'Now playing',
    nothingPlaying: 'Nothing is playing yet. Request the first song!',
    paused: 'Paused',
    upNext: 'Up next',
    queueEmpty: 'The queue is empty. Fallback music plays until someone requests a song.',
    yours: 'Your request',
    requestedBy: (name: string | null) => (name ? `Requested by ${name}` : 'Requested by a guest'),
    autoPick: 'Picked by the jukebox',
    recentlyPlayed: 'Recently played',
    forgetMe: 'Forget me',
    forgetConfirm:
      'Remove your name and your requests from this jukebox? Songs already queued stay in the queue without your name.',
    forgetDone: 'Done. Room Jukebox no longer knows who you are.',
    forgetYouTubeLine:
      'This removes what Room Jukebox stored about you; it does not affect data stored by YouTube',
    forgetYouTubeLink: 'Manage your Google activity',
    added: (title: string) => `Added: ${title}`,
    alreadyQueued: (title: string) => `${title} is already in the queue`,
    offline: 'Reconnecting to the jukebox…',
    pasteTitle: 'Have a link? Paste it',
    searchOff: 'Search is off; paste a link instead',
    nowPlayingBar: (title: string | null) =>
      title ? `Now playing: ${title}` : 'Now playing: nothing yet',
    showNowPlaying: 'Show now playing and the queue',
  },

  sheet: {
    title: 'Request this song?',
    ownerTitle: 'Add this song?',
    confirm: 'Request it',
    ownerConfirm: 'Add to queue',
    playable: 'Ready to play',
    unknownDuration: 'Length unknown',
    by: (channel: string) => `by ${channel}`,
  },

  search: {
    label: 'Search YouTube',
    placeholder: 'Search YouTube for a song',
    submit: 'Search',
    searching: 'Searching…',
    results: 'Search results',
    clear: 'Clear',
    suggestions: 'Suggestions',
    resting: 'Search is resting for today; paste a link instead',
    youtubeDown: "YouTube didn't answer, try again",
    low: 'Search is almost used up for today. Paste link always works.',
    usedUp: 'Search is used up for today. Use Find on YouTube and Paste link instead.',
    remaining: (n: number) => `${n} ${n === 1 ? 'search' : 'searches'} left for you today`,
    add: 'Add',
    noResults: 'No results. Try other words.',
    cached: 'Saved results (no search used)',
  },

  /** Plain-words reasons; `source` says whose rule it is (plan §III.A, "greyed reasons"). */
  reasons: {
    'not-found': 'This video was removed or the link is wrong (YouTube).',
    private: 'This video is private on YouTube.',
    'not-embeddable': "The video's owner doesn't allow it to play outside YouTube.",
    'age-restricted': 'Age-restricted on YouTube, so it cannot play here.',
    live: 'Live streams cannot be requested (YouTube).',
    'region-blocked': 'Not available in this country on YouTube.',
    'too-long': (maxSec: number | null) =>
      maxSec
        ? `Longer than this room's ${Math.round(maxSec / 60)}-minute limit, set by the owner.`
        : "Longer than this room's limit, set by the owner.",
  },

  errors: {
    network: "Can't reach the jukebox. Check that you're on the party Wi-Fi.",
    generic: 'Something went wrong. Try again.',
    'too-many-pending': (max: number | null) =>
      max
        ? `You already have ${max} songs waiting. Wait until one plays.`
        : 'You have too many songs waiting. Wait until one plays.',
    cooldown: (sec?: number) =>
      sec
        ? `Wait ${Math.ceil(sec)} seconds before your next request.`
        : 'Wait a moment before your next request.',
    duplicate: 'That song is already in the queue.',
    'queue-full': 'The queue is full right now. Try again after a few songs.',
    'search-budget': 'You used your searches for today. Find on YouTube and Paste link still work.',
    'daily-quota': 'Search is used up for today. Find on YouTube and Paste link still work.',
    'search-disabled': 'Search is turned off. Use Find on YouTube and Paste link.',
    'bad-password': 'Wrong password.',
    'login-throttled': (sec?: number) =>
      sec
        ? `Too many tries. Try again in ${Math.ceil(sec)} seconds.`
        : 'Too many tries. Wait before trying again.',
    'playlist-private':
      'That playlist is private. In YouTube set it to Public or Unlisted (an API key cannot read private playlists), then add it again.',
    'playlist-not-found': "That playlist doesn't exist or the link is wrong.",
    'no-api-key': 'Adding playlists needs a YouTube API key. Add one under Settings first.',
    forbidden: 'This page only works from the party Wi-Fi or the laptop itself.',
    setupDone: 'Setup is already finished.',
    needsSetup: 'Finish the setup on the laptop first.',
    youtubeUnavailable: "Can't reach YouTube right now. Try again in a minute.",
    crossSite: 'Open this page from the jukebox address, not from another site.',
  },

  privacy: {
    title: 'Privacy',
    updated: (d: string) => `Updated ${d}`,
    back: 'Back to the jukebox',
    fallbackNote: "Couldn't load the latest version from the jukebox, showing the built-in text.",
  },

  tv: {
    nothingPlaying: 'Nothing playing',
    upNext: 'Up next',
    joinWifi: 'Join the Wi-Fi',
    wifiName: (ssid: string) => `Wi-Fi: ${ssid}`,
    requestSong: 'Request a song',
    startMusic: 'Start Music',
    startMusicHint: 'Press any key or click',
    failed: (title: string) => `Couldn't play ${title}, skipped`,
    partyCode: (code: string) => `Party code ${code}`,
    pill: {
      online: 'Online',
      reconnecting: 'Reconnecting',
      delayed: 'Delayed',
      looking: 'Looking for hub',
      start: 'Press Start Music',
    },
    noPlayer: "Couldn't load the YouTube player. Check the internet connection.",
    player: 'YouTube player',
  },

  admin: {
    title: 'Owner',
    loginTitle: 'Owner login',
    password: 'Password',
    login: 'Log in',
    logout: 'Log out',
    tabs: { now: 'Now', queue: 'Queue', music: 'Music', settings: 'Settings', system: 'System' },
    play: 'Play',
    pause: 'Pause',
    skip: 'Skip',
    skipConfirm: (title: string) => `Skip ${title}?`,
    queue: 'Queue',
    moveUp: 'Move up',
    moveDown: 'Move down',
    removeConfirm: (title: string) => `Remove ${title} from the queue?`,
    deleteGuest: 'Delete guest data',
    deleteGuestConfirm: (name: string) =>
      `Delete everything stored about ${name}? Their queued songs stay, without a name.`,
    guestDeleted: 'Guest data deleted',
    history: 'Recently played',
    addSong: 'Add a song',
    addSongHint: 'Paste a YouTube link or video ID.',
    check: 'Check',
    added: (title: string) => `Added: ${title}`,
    lastErrors: 'Recent playback problems',
    playlists: 'Fallback playlists',
    playlistsHint:
      'Played when nobody has requested anything. Playlists must be Public or Unlisted: an API key cannot read private playlists.',
    playlistUrl: 'Playlist link',
    addPlaylist: 'Add playlist',
    refresh: 'Refresh',
    videos: (n: number) => `${n} videos`,
    poolSize: (n: number) => `${n} songs in the fallback pool`,
    noPlaylists: 'No playlists yet.',
    ownerSearch: 'Search from the owner reserve',
    ownerSearchHint: 'Uses the searches kept back for you, not the guests’ share.',
    ownerSearchPage: 'Search YouTube',
    ownerSearchPageHint: 'Reads YouTube’s results page; no daily searches are used.',
    searchesLeft: 'Searches today',
    searchesUsed: (guests: number, owner: number) => `Guests used ${guests}, you used ${owner}`,
    searchesTotal: (left: number, total: number) => `${left} of ${total} left`,
    resetsAt: (at: number) => `Resets at ${fmtClock(at)}`,
    players: 'Players',
    noPlayers: 'No players connected.',
    playerStatus: {
      online: 'Online',
      delayed: 'Delayed',
      reconnecting: 'Reconnecting',
      blocked: 'Needs Start Music',
      offline: 'Offline',
    },
    drift: (d: number) => `${d >= 0 ? '+' : ''}${d.toFixed(1)} s`,
    roomName: 'Room name',
    limits: 'Request limits',
    maxPending: 'Songs waiting per guest',
    cooldown: 'Seconds between requests',
    maxDurationMin: 'Longest song (minutes)',
    allowDuplicates: 'Allow the same song twice in the queue',
    budgets: 'Search budgets',
    perGuestPerDay: 'Searches per guest per day',
    perGuestIntervalSec: 'Seconds between a guest’s searches',
    perIpPerDay: 'Searches per phone address per day',
    publicPerDay: 'Searches from the public page per day',
    ownerReserve: 'Kept back for the owner',
    dailyTotal: 'Total searches per day',
    searchSource: 'Search source',
    searchSources: {
      page: {
        label: 'YouTube page (unlimited)',
        hint: 'Reads YouTube’s public results page, like a browser. No daily limit and no API key needed. Not covered by the YouTube API terms; it can break if YouTube changes its page.',
      },
      'api-first': {
        label: 'API first, then page',
        hint: 'Uses your API key’s daily searches, then YouTube’s page once they are gone.',
      },
      'api-only': {
        label: 'API only (about 100 a day)',
        hint: 'Only the official YouTube API. Search stops for the day when the allowance runs out, and is off without a key.',
      },
    },
    wifi: 'Wi-Fi QR on the TV',
    wifiHint: 'Guests scan it to join the Wi-Fi. Leave the name empty to hide it.',
    ssid: 'Wi-Fi name',
    wifiPassword: 'Wi-Fi password',
    wifiPasswordSaved: 'A password is saved. Type a new one to replace it.',
    security: 'Security',
    securityOptions: {
      WPA: 'WPA2 / mixed (most networks)',
      SAE: 'WPA3 only',
      WEP: 'WEP (old)',
      nopass: 'Open network, no password',
    },
    hidden: 'Hidden network',
    removeWifi: 'Remove Wi-Fi QR',
    lan: 'Address in the QR code',
    lanHint: 'Pick the address phones on the party Wi-Fi can reach.',
    apiKey: 'YouTube API key',
    apiKeySaved: (last4: string) => `A key ending in ${last4} is saved.`,
    apiKeyNone: 'No key saved. Playlist import is off; search reads YouTube’s page.',
    apiOnlyNoKey: 'Search is set to API only and no key is saved, so search is off.',
    apiKeyPlaceholder: 'Paste a new key',
    removeApiKey: 'Remove key',
    backup: 'Backups',
    backupNow: 'Back up now',
    backupDone: 'Backup saved',
    noBackups: 'No backups yet.',
    passwordChange: 'Change password',
    currentPassword: 'Current password',
    newPassword: 'New password (8 characters or more)',
    confirmPassword: 'Type the new password again',
    passwordMismatch: "The two passwords don't match.",
    passwordShort: 'Use at least 8 characters.',
    passwordChanged: 'Password changed. Log in again.',
    update: 'Update now',
    updateHint: 'Installs the downloaded update and restarts the app.',
    updateStarted: 'Installing the update…',
    sessionEnded: 'You were logged out.',
    version: (v: string) => `Room Jukebox ${v}`,
    gateNote: 'Owner login only works on the party Wi-Fi or on the laptop itself.',
  },

  setup: {
    title: 'Set up Room Jukebox',
    stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
    welcome: 'Welcome',
    welcomeBody:
      'This takes about two minutes. You can change everything later from the owner page.',
    accept: 'I agree to the YouTube Terms of Service and the Room Jukebox privacy policy',
    password: 'Owner password',
    passwordBody: 'Guests never need it. You type it to open the owner page on your phone.',
    roomName: 'Room name',
    roomNameBody: 'Shown on the TV and on guests’ phones.',
    roomNamePlaceholder: 'Basement',
    apiKey: 'YouTube API key (optional)',
    apiKeyBody:
      'Without a key, guests still search (through YouTube’s results page) and paste links. A key adds fallback playlist import and checks each search result before it can be requested.',
    apiKeyStepsTitle: 'How to get a key (5 minutes)',
    apiKeySteps: [
      'Open the Google Cloud console and sign in.',
      'Create a project (any name).',
      'Open APIs & Services → Library, find "YouTube Data API v3" and click Enable.',
      'Open APIs & Services → Credentials → Create credentials → API key.',
      'Copy the key and paste it here.',
    ],
    playlists: 'Fallback playlists',
    playlistsBody:
      'Music that plays when nobody requested anything. Paste YouTube playlist links (Public or Unlisted). They are checked after setup.',
    addAnother: 'Add another',
    wifi: 'Venue Wi-Fi (optional)',
    wifiBody: 'The TV shows a QR code so guests can join the Wi-Fi. Leave empty to skip.',
    lan: 'Address for phones',
    lanBody: 'Phones on the Wi-Fi open this address. The TV shows it as a QR code.',
    lanNone: 'No network address found. Connect this laptop to the Wi-Fi, then reload this page.',
    finish: 'Finish setup',
    finishing: 'Saving…',
    done: 'Done, the TV will start',
    doneBody: 'Open the owner page any time to change settings.',
    openAdmin: 'Open the owner page',
  },
} as const;

/** "4:05" or the "length unknown" text. */
export function durationText(sec: number | null | undefined): string {
  return fmtDuration(sec) || S.sheet.unknownDuration;
}

/**
 * Built-in privacy text, shown when `GET /api/privacy.json` cannot be loaded. Covers YouTube API
 * Services Developer Policies III.A.2.a–g and III.E.4.i (plan §3.3 "Policy hygiene").
 */
export const PRIVACY_FALLBACK = {
  updatedAt: '2026-10-09',
  sections: [
    {
      heading: 'What Room Jukebox is',
      body: 'Room Jukebox is a party jukebox that runs on the host’s own laptop. It uses YouTube API Services to look up and play YouTube videos. By using it you agree to the YouTube Terms of Service (https://www.youtube.com/t/terms).',
    },
    {
      heading: 'What we collect',
      body: 'The display name you choose (optional), a random guest ID kept in a cookie, your phone’s network address (only to enforce request and search limits), and the songs you request with the time you requested them. We do not ask for your email, phone number or YouTube account, and we never store video or audio files.',
    },
    {
      heading: 'How we use it',
      body: 'To show who requested each song, to apply the limits the owner set (songs waiting per guest, time between requests, searches per day), and to pick fallback music from songs that played well before.',
    },
    {
      heading: 'Who we share it with',
      body: 'Data stays on the host’s laptops. When the host runs a second Room Jukebox laptop, settings and request history are copied to it. If the host sends a diagnostics bundle to the developer for troubleshooting, it can include request history. Nothing is sold or shared with advertisers. Searches and video lookups are sent to YouTube.',
    },
    {
      heading: 'YouTube and Google',
      body: 'Videos play in the official YouTube embedded player, which shares basic data (such as your network address and device information) with YouTube when it loads. The TV player shows YouTube advertising. Google’s privacy policy applies to that data: https://policies.google.com/privacy.',
    },
    {
      heading: 'Cookies and local storage',
      body: 'A guest cookie (rj_guest) holds your random guest ID; the owner page uses an owner cookie (rj_admin). Your phone remembers that you accepted the notice, your display name and whether you have seen the request steps. The owner’s laptops remember known hub addresses.',
    },
    {
      heading: 'Deleting your data',
      body: 'Tap More → Forget me at the bottom of the jukebox page to delete your name, guest ID and request attributions at once; the owner can also delete a guest’s data. Both happen immediately (always within 7 days, including on the host’s other laptops). Anonymous play history and per-address counters are kept so limits cannot be reset. This does not affect data stored by YouTube; manage that at https://myactivity.google.com/.',
    },
    {
      heading: 'Children',
      body: 'Room Jukebox is not directed at children.',
    },
    {
      heading: 'Contact',
      body: 'Questions about this jukebox: ask the host of the party. Questions about the software: https://github.com/jason-tucker/room-jukebox/issues.',
    },
  ],
} as const;
