import type { EntryPublic } from '@room-jukebox/shared';
import type { ReactNode } from 'react';
import { fmtDuration } from '../lib/format.ts';
import { S } from '../strings.ts';
import { Chip } from './ui.tsx';
import { VideoRow } from './VideoRow.tsx';
import { YouTubeAttribution } from './YouTubeAttribution.tsx';

/** Live queue (or history): `mine` rows are highlighted; every row names its requester. */
export function QueueList<E extends EntryPublic>({
  entries,
  title,
  empty,
  actions,
  numbered = true,
}: {
  entries: E[];
  title: string;
  empty?: string;
  actions?: (entry: E, index: number) => ReactNode;
  numbered?: boolean;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">{title}</h2>
        {entries.length > 0 && <YouTubeAttribution />}
      </div>
      {entries.length === 0 ? (
        empty ? (
          <p className="text-base text-muted">{empty}</p>
        ) : null
      ) : (
        <ol className="flex flex-col gap-1">
          {entries.map((e, i) => (
            <li key={e.id} data-testid="queue-row" data-mine={e.mine ? 'true' : undefined}>
              <VideoRow
                videoId={e.videoId}
                thumbnail={e.thumbnail ?? null}
                title={numbered ? `${i + 1}. ${e.title}` : e.title}
                lines={[
                  e.source === 'auto' ? S.guest.autoPick : S.guest.requestedBy(e.requesterName),
                  [fmtDuration(e.durationSec), e.status === 'failed' ? e.failReason : null]
                    .filter(Boolean)
                    .join(' · '),
                ]}
                badge={e.mine ? <Chip tone="accent">{S.guest.yours}</Chip> : undefined}
                highlight={!!e.mine}
              />
              {actions && (
                <div className="flex flex-wrap justify-end gap-1 pb-2">{actions(e, i)}</div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
