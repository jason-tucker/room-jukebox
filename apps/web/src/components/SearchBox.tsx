import type { GuestState, SearchReply, VideoCard } from '@room-jukebox/shared';
import { useEffect, useState, type FormEvent } from 'react';
import type { ApiFailure, ApiResult } from '../lib/api.ts';
import { fmtDuration } from '../lib/format.ts';
import { failureText, reasonText, type MessageContext } from '../lib/messages.ts';
import { S } from '../strings.ts';
import { btn, input, Notice } from './ui.tsx';
import { VideoRow } from './VideoRow.tsx';
import { YouTubeAttribution } from './YouTubeAttribution.tsx';

/** What the page around the box needs to know to arrange itself. */
export interface SearchView {
  /** A reply is on screen (even an empty one). */
  showingResults: boolean;
  /** Search said no for today (budget, quota, switched off or used up): point at Paste link. */
  resting: boolean;
}

const RESTING = new Set(['search-budget', 'daily-quota', 'search-disabled']);

/** Search-specific wording for the failures a search can hit; everything else as usual. */
export function searchFailureText(err: ApiFailure, ctx: MessageContext = {}): string {
  if (RESTING.has(err.code)) return S.search.resting;
  if (err.code === 'youtube-unavailable') return S.search.youtubeDown;
  return failureText(err, ctx);
}

/**
 * YouTube-style, submit-only search (never search-as-you-type: each submit costs quota). Results
 * keep the server's order; a playable row is one big tap target that calls `onPick` (the caller
 * opens the "Request this song?" sheet); unplayable rows stay in place, greyed, with their reason
 * and are not tappable. Renders nothing when `search.enabled` is false.
 */
export function SearchBox({
  search,
  runSearch,
  onPick,
  onViewChange,
  ctx = {},
  label = S.search.label,
}: {
  search: GuestState['search'];
  runSearch: (q: string) => Promise<ApiResult<SearchReply>>;
  onPick: (card: VideoCard) => void;
  onViewChange?: (view: SearchView) => void;
  ctx?: MessageContext;
  label?: string;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reply, setReply] = useState<SearchReply | null>(null);

  const remaining = reply?.remaining ?? search.remaining;
  const usedUp = remaining === 0;
  const showingResults = !!reply && search.enabled && !usedUp;
  const resting = (!!error && RESTING.has(error.code)) || usedUp;

  useEffect(() => {
    onViewChange?.({ showingResults, resting });
  }, [onViewChange, showingResults, resting]);

  if (!search.enabled) return null;
  if (usedUp) {
    return (
      <div data-testid="search-used-up">
        <Notice>{S.search.usedUp}</Notice>
      </div>
    );
  }

  const provider = reply?.provider ?? search.provider;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const r = await runSearch(text);
    setBusy(false);
    if (r.ok) setReply(r.data);
    else {
      setError(r.error);
      setReply(null);
    }
  };

  return (
    <section aria-label={label} className="flex flex-col gap-3" data-testid="search-box">
      <form role="search" onSubmit={submit} className="flex gap-2">
        <input
          type="search"
          enterKeyHint="search"
          aria-label={label}
          placeholder={S.search.placeholder}
          className={`${input} rounded-full`}
          value={q}
          maxLength={200}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          type="submit"
          className={`${btn.primary} px-4`}
          disabled={busy || !q.trim()}
          aria-label={S.search.submit}
        >
          <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
            <path d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" />
          </svg>
          <span className="sr-only sm:not-sr-only">{S.search.submit}</span>
        </button>
      </form>
      {provider === 'unofficial' && (
        <p className="-mt-1 px-3 text-sm text-muted" data-testid="search-provider-note">
          {S.search.unofficial}
        </p>
      )}
      {search.low && (
        <Notice tone="warn">
          {S.search.low}
          {remaining !== null && remaining !== undefined && ` ${S.search.remaining(remaining)}`}
        </Notice>
      )}
      {busy && <p className="px-3 text-base text-muted">{S.search.searching}</p>}
      {error && <Notice tone={resting ? 'warn' : 'error'}>{searchFailureText(error, ctx)}</Notice>}
      {reply && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <button type="button" className={btn.ghost} onClick={() => setReply(null)}>
              {S.search.clear}
            </button>
            <span className="min-w-0 flex-1 truncate text-sm text-muted">
              {reply.cached ? S.search.cached : ''}
            </span>
            <YouTubeAttribution />
          </div>
          {reply.results.length === 0 && (
            <p className="px-3 text-base text-muted">{S.search.noResults}</p>
          )}
          <ul className="flex flex-col" aria-label={S.search.results}>
            {reply.results.map((card) => {
              const row = (
                <VideoRow
                  videoId={card.videoId}
                  thumbnail={card.thumbnail}
                  title={card.title}
                  dimmed={!card.playable}
                  size="sm"
                  lines={[
                    [card.channelTitle, fmtDuration(card.durationSec)].filter(Boolean).join(' · '),
                    card.playable ? null : reasonText(card, ctx),
                  ]}
                />
              );
              return (
                <li key={card.videoId} data-testid="search-row" data-playable={card.playable}>
                  {card.playable ? (
                    <button
                      type="button"
                      className="block w-full rounded-2xl text-left hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                      onClick={() => onPick(card)}
                    >
                      {row}
                    </button>
                  ) : (
                    <div aria-disabled="true">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
