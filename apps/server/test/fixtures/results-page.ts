/**
 * Synthetic YouTube results pages for the unofficial search parser. Only the fields the parser
 * reads are present; the surrounding HTML mimics the real page's script tags.
 */

export interface PageVideo {
  id: string;
  title: string;
  channel?: string;
  /** `lengthText.simpleText`; omit for a live stream. */
  length?: string;
}

const thumbs = (id: string) => ({
  thumbnails: [
    { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg?small`, width: 360, height: 202 },
    { url: `https://i.ytimg.com/vi/${id}/hq720.jpg`, width: 720, height: 404 },
  ],
});

export const videoRenderer = (v: PageVideo) => ({
  videoRenderer: {
    videoId: v.id,
    thumbnail: thumbs(v.id),
    title: { runs: [{ text: v.title }] },
    ownerText: { runs: [{ text: v.channel ?? 'Channel' }] },
    ...(v.length !== undefined
      ? { lengthText: { simpleText: v.length } }
      : { badges: [{ metadataBadgeRenderer: { label: 'LIVE' } }] }),
  },
});

const page = (initialData: unknown, style: 'var' | 'window' = 'var') => {
  const assign =
    style === 'var'
      ? `var ytInitialData = ${JSON.stringify(initialData)};`
      : `window["ytInitialData"] = ${JSON.stringify(initialData)};`;
  return `<!DOCTYPE html><html><head><title>results - YouTube</title></head><body>
<script nonce="abc">window.ytcfg = {"x": 1};</script>
<script nonce="abc">${assign}</script>
<script nonce="abc">var ytInitialPlayerResponse = {"a": "};"};</script>
</body></html>`;
};

export const initialData = (sections: unknown[][]) => ({
  responseContext: {},
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            ...sections.map((contents) => ({ itemSectionRenderer: { contents } })),
            { continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN' } },
          ],
        },
      },
    },
  },
});

/** A results page with `videos` as plain video results. */
export const resultsPage = (videos: PageVideo[], style: 'var' | 'window' = 'var') =>
  page(initialData([videos.map(videoRenderer)]), style);

/**
 * The main fixture: three videos (one multi-run title, one `h:mm:ss`, one live) mixed with a
 * shorts shelf, an ad, a playlist and a channel, which are all skipped.
 */
export const FIXTURE_PAGE = page(
  initialData([
    [
      { adSlotRenderer: { adSlotMetadata: {} } },
      {
        videoRenderer: {
          videoId: 'aaaaaaaaaaa',
          thumbnail: thumbs('aaaaaaaaaaa'),
          title: { runs: [{ text: 'Daft Punk - ' }, { text: 'One More Time };' }] },
          ownerText: { runs: [{ text: 'Daft Punk' }] },
          lengthText: { simpleText: '5:21' },
        },
      },
      {
        reelShelfRenderer: {
          items: [{ reelItemRenderer: { videoId: 'shortshorts' } }],
        },
      },
      { playlistRenderer: { playlistId: 'PLxxxxxxxxxx' } },
      { channelRenderer: { channelId: 'UCxxxxxxxxxx' } },
      {
        videoRenderer: {
          videoId: 'bbbbbbbbbbb',
          thumbnail: thumbs('bbbbbbbbbbb'),
          title: { runs: [{ text: 'Party Mix 2026' }] },
          ownerText: { runs: [{ text: 'DJ "Quotes" Mixer' }] },
          lengthText: { simpleText: '1:02:03' },
        },
      },
    ],
    [videoRenderer({ id: 'ccccccccccc', title: 'Lofi radio 24/7', channel: 'Lofi Girl' })],
  ]),
);

/** The EU consent interstitial: no `ytInitialData` at all. */
export const CONSENT_PAGE = `<!DOCTYPE html><html><head><title>Before you continue to YouTube</title></head>
<body><form action="https://consent.youtube.com/save" method="POST">
<button>Accept all</button></form></body></html>`;

/** A results page with no video results. */
export const EMPTY_PAGE = page(
  initialData([[{ backgroundPromoRenderer: { title: { runs: [{ text: 'No results found' }] } } }]]),
);

export const WINDOW_STYLE_PAGE = resultsPage(
  [{ id: 'ddddddddddd', title: 'Window style', length: '3:30' }],
  'window',
);
