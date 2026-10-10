import type { M1NowPlaying } from '@room-jukebox/shared';
import { useEffect, useState } from 'react';
import { elapsedSec, fmtDuration, progressFraction } from '../lib/format.ts';
import { S } from '../strings.ts';
import { Chip } from './ui.tsx';
import { thumbFor } from './VideoRow.tsx';
import { YouTubeAttribution } from './YouTubeAttribution.tsx';

export function NowPlayingCard({
  np,
  serverNow,
}: {
  np: M1NowPlaying | null;
  serverNow: () => number;
}) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, [serverNow]);

  if (!np) {
    return (
      <div className="rounded-2xl bg-surface p-4 text-lg text-muted">{S.guest.nothingPlaying}</div>
    );
  }
  const elapsed = elapsedSec(np, now);
  const frac = progressFraction(elapsed, np.durationSec);
  return (
    <article
      aria-label={S.guest.nowPlaying}
      className="flex flex-col gap-3 rounded-2xl bg-surface p-3"
    >
      <img
        src={thumbFor(np.videoId, np.thumbnail)}
        alt=""
        className="aspect-video w-full rounded-xl bg-surface-2 object-cover"
      />
      <div className="flex flex-col gap-1 px-1">
        <div className="text-xl leading-snug font-bold break-words">{np.title}</div>
        <div className="text-base text-muted">
          {np.source === 'auto' ? S.guest.autoPick : S.guest.requestedBy(np.requesterName)}
        </div>
        {np.mine && (
          <div>
            <Chip tone="accent">{S.guest.yours}</Chip>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(np.durationSec ?? 0)}
          aria-valuenow={Math.round(elapsed)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full bg-accent" style={{ width: `${(frac ?? 0) * 100}%` }} />
        </div>
        <div className="flex justify-between text-base text-muted tabular-nums">
          <span>
            {fmtDuration(elapsed)}
            {np.pausedAt !== null && ` · ${S.guest.paused}`}
          </span>
          <span>{fmtDuration(np.durationSec)}</span>
        </div>
      </div>
      <YouTubeAttribution videoId={np.videoId} className="self-end" />
    </article>
  );
}
