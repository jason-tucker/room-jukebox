import type { ReactNode } from 'react';

export function thumbFor(videoId: string, thumbnail?: string | null): string {
  return thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
}

const THUMB = {
  sm: 'h-[68px] w-[120px]',
  md: 'aspect-video w-28 sm:w-40',
  lg: 'aspect-video w-40 sm:w-56',
} as const;

/** YouTube-style row: 16:9 thumbnail on the left, title and details on the right. */
export function VideoRow({
  videoId,
  thumbnail,
  title,
  lines = [],
  badge,
  action,
  dimmed = false,
  highlight = false,
  size = 'md',
}: {
  videoId: string;
  thumbnail?: string | null;
  title: string;
  lines?: ReactNode[];
  badge?: ReactNode;
  action?: ReactNode;
  dimmed?: boolean;
  highlight?: boolean;
  /** `sm` is the search-result row: a fixed 120×68 thumbnail. */
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <div
      data-dimmed={dimmed || undefined}
      data-highlight={highlight || undefined}
      className={`grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-2xl p-2 sm:grid-cols-[auto_1fr_auto] ${highlight ? 'bg-accent-soft ring-2 ring-accent' : ''} ${dimmed ? 'opacity-55 grayscale' : ''}`}
    >
      <img
        src={thumbFor(videoId, thumbnail)}
        alt=""
        loading="lazy"
        className={`${THUMB[size]} shrink-0 rounded-xl bg-surface-2 object-cover`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className={`line-clamp-2 ${size === 'sm' ? 'text-base' : 'text-lg'} leading-snug font-semibold break-words`}
        >
          {title}
        </div>
        {lines.map((l, i) =>
          l ? (
            <div key={i} className="text-base text-muted">
              {l}
            </div>
          ) : null,
        )}
        {badge && <div className="mt-1">{badge}</div>}
      </div>
      {/* Under the text on phones, at the right on wider screens. */}
      {action && (
        <div className="col-start-2 justify-self-start sm:col-start-3 sm:row-start-1 sm:self-center">
          {action}
        </div>
      )}
    </div>
  );
}
