const ID = '[A-Za-z0-9_-]{11}';
const BARE_ID = new RegExp(`^${ID}$`);
const URL_PATTERNS = [
  // youtube.com, m.youtube.com, music.youtube.com, youtube-nocookie.com
  new RegExp(
    `(?:youtube(?:-nocookie)?\\.com)/(?:watch\\?(?:[^\\s#]*?&)?v=|shorts/|embed/|live/|v/)(${ID})(?![A-Za-z0-9_-])`,
    'i',
  ),
  new RegExp(`youtu\\.be/(${ID})(?![A-Za-z0-9_-])`, 'i'),
];

/**
 * The 11-character video ID from any text containing a YouTube URL (`watch?v=`, `youtu.be/`,
 * `shorts/`, `embed/`, `live/`; share-sheet text included) or a bare ID; null when none.
 */
export function extractVideoId(input: string): string | null {
  const text = input.trim();
  if (BARE_ID.test(text)) return text;
  for (const re of URL_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

const PLAYLIST_ID = /^(?:PL|UU|LL|FL|OL|RD|UL|PU)[A-Za-z0-9_-]{10,}$/;

/** The playlist ID from a URL with `list=` or a bare playlist ID; null when none. */
export function extractPlaylistId(input: string): string | null {
  const text = input.trim();
  if (PLAYLIST_ID.test(text)) return text;
  const m = /[?&]list=([A-Za-z0-9_-]{10,})/.exec(text);
  return m?.[1] ?? null;
}

/** ISO 8601 duration (`PT1H2M3S`, `P0D`, `P1DT2H`) in seconds; null when unparseable. */
export function parseIsoDuration(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (!m) return null;
  const [, w, d, h, min, s] = m;
  return (
    Number(w ?? 0) * 604800 +
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0)
  );
}
