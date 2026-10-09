/*
 * M0 gate (1) playback matrix: 20 videos chosen from memory to cover different labels, channel
 * types, encodes and ages, plus deliberate failures for gate (3). Jason's run on the laptops is the
 * ground truth; `expect` is only a prediction. IDs marked "from memory, unverified" may be wrong.
 */
export interface MatrixEntry {
  videoId: string;
  title: string;
  expect: 'play' | 'error';
  why: string;
}

export const SPIKE_MATRIX: readonly MatrixEntry[] = [
  {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up',
    expect: 'play',
    why: 'Sony Music (RCA) official upload from 2009; the canonical embed test.',
  },
  {
    videoId: 'dTAAsCNK7RA',
    title: 'OK Go - Here It Goes Again',
    expect: 'play',
    why: "Band's own channel, uploaded 2006: pre-2010 upload with a low-resolution source encode.",
  },
  {
    videoId: 'fJ9rUzIMcZQ',
    title: 'Queen - Bohemian Rhapsody (Official Video Remastered)',
    expect: 'play',
    why: 'Universal Music (Queen Official) remaster; very high view count, label-managed.',
  },
  {
    videoId: 'gAjR4_CbPpQ',
    title: 'Daft Punk - Harder, Better, Faster, Stronger',
    expect: 'play',
    why: 'Warner (Parlophone) official video on the Daft Punk channel.',
  },
  {
    videoId: '5NV6Rdv1a3I',
    title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers',
    expect: 'play',
    why: 'Static-artwork "official audio" upload (stands in for a lyric video: no lyric-video ID I could recall with confidence).',
  },
  {
    videoId: 'nfWlot6h_JM',
    title: 'Taylor Swift - Shake It Off',
    expect: 'play',
    why: 'VEVO upload (TaylorSwiftVEVO, Universal/Big Machine); VEVO embeds carry their own ad stack.',
  },
  {
    videoId: 'kJQP7kiw5Fk',
    title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
    expect: 'play',
    why: 'Universal Music Latin VEVO upload; Latin repertoire (stands in for Bad Bunny).',
  },
  {
    videoId: 'gdZLi9oWNZg',
    title: 'BTS - Dynamite (Official MV)',
    expect: 'play',
    why: 'HYBE LABELS channel: K-pop label outside the big three.',
  },
  {
    videoId: 'YQHsXMglC9A',
    title: 'Adele - Hello',
    expect: 'play',
    why: 'AdeleVEVO (XL/Columbia); 6-minute video with a long silent-ish opening.',
  },
  {
    videoId: '9bZkp7q19f0',
    title: 'PSY - GANGNAM STYLE',
    expect: 'play',
    why: "Artist's own channel (officialpsy, YG Entertainment); historic top-viewed video.",
  },
  {
    videoId: 'OPf0YbXqDm0',
    title: 'Mark Ronson - Uptown Funk ft. Bruno Mars',
    expect: 'play',
    why: 'Sony (RCA) VEVO upload.',
  },
  {
    videoId: 'JGwWNGJdvx8',
    title: 'Ed Sheeran - Shape of You',
    expect: 'play',
    why: 'Warner (Atlantic) upload on the artist channel.',
  },
  {
    videoId: 'djV11Xbc914',
    title: 'a-ha - Take On Me (Official Video, 4K remaster)',
    expect: 'play',
    why: 'Warner upload remastered to 4K: tests a 2160p stream in the embed.',
  },
  {
    videoId: 'le0BLAEO93g',
    title: 'Vulfpeck - Dean Town',
    expect: 'play',
    why: 'Independent artist (self-released, own channel), no label content ID policy.',
  },
  {
    videoId: 'QrR_gm6RqCo',
    title: 'Mac Miller: NPR Music Tiny Desk Concert',
    expect: 'play',
    why: 'Live performance on a non-label channel (NPR Music); from memory, unverified.',
  },
  {
    videoId: 'sOnqjkJTMaA',
    title: 'Michael Jackson - Thriller (Official Video)',
    expect: 'play',
    why: 'Sony (Epic) VEVO; 13+ minutes with a ~4 minute spoken/film intro before the music.',
  },
  {
    videoId: '8SbUC-UaAxE',
    title: "Guns N' Roses - November Rain",
    expect: 'play',
    why: 'Universal (Geffen) VEVO; video over 8 minutes (about 9 minutes).',
  },
  {
    videoId: 'PTFwQP86BRs',
    title: "Nine Inch Nails - Closer (Director's Cut)",
    expect: 'error',
    why: 'Expected age-restricted (embeds then fail with 150/101 or show a sign-in wall); from memory, unverified.',
  },
  {
    videoId: 'dQw4w9WgXcZ',
    title: 'Deliberately invalid ID (one character off Rick Astley)',
    expect: 'error',
    why: 'Well-formed but non-existent ID: should raise error 100 (embeds often report 150), never hang.',
  },
  {
    videoId: '!!invalid!!',
    title: 'Deliberately malformed ID',
    expect: 'error',
    why: 'Malformed ID (illegal characters): documented as error 2; headless Chrome on 2026-10-09 got 150.',
  },
];
