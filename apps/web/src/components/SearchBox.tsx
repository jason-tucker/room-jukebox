import type { GuestState, SearchReply, VideoCard } from '@room-jukebox/shared';
import { useState, type FormEvent } from 'react';
import type { ApiResult } from '../lib/api.ts';
import { fmtDuration } from '../lib/format.ts';
import { failureText, reasonText, type MessageContext } from '../lib/messages.ts';
import { S } from '../strings.ts';
import { btn, input, Notice } from './ui.tsx';
import { VideoRow } from './VideoRow.tsx';
import { YouTubeAttribution } from './YouTubeAttribution.tsx';

/**
 * Optional, submit-only search (never search-as-you-type: each submit costs quota). Rendered only
 * when `search.enabled`; hidden once `remaining` hits 0. Results keep the server's (YouTube's)
 * order; unplayable rows stay in place, greyed, with their reason and Add disabled.
 */
export function SearchBox({
  search,
  runSearch,
  onPick,
  ctx = {},
  label = S.search.label,
}: {
  search: GuestState['search'];
  runSearch: (q: string) => Promise<ApiResult<SearchReply>>;
  onPick: (card: VideoCard) => void;
  ctx?: MessageContext;
  label?: string;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<SearchReply | null>(null);

  if (!search.enabled) return null;
  const remaining = reply?.remaining ?? search.remaining;
  if (remaining === 0) {
    return (
      <div data-testid="search-used-up">
        <Notice>{S.search.usedUp}</Notice>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const r = await runSearch(text);
    setBusy(false);
    if (r.ok) setReply(r.data);
    else setError(failureText(r.error, ctx));
  };

  return (
    <section aria-label={label} className="flex flex-col gap-3" data-testid="search-box">
      {search.low && <Notice tone="warn">{S.search.low}</Notice>}
      <form role="search" onSubmit={submit} className="flex gap-2">
        <input
          type="search"
          enterKeyHint="search"
          aria-label={label}
          placeholder={S.search.placeholder}
          className={input}
          value={q}
          maxLength={200}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className={btn.secondary} disabled={busy || !q.trim()}>
          {S.search.submit}
        </button>
      </form>
      {remaining !== null && remaining !== undefined && (
        <p className="text-base text-muted">{S.search.remaining(remaining)}</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {reply && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-base text-muted">{reply.cached ? S.search.cached : ''}</span>
            <YouTubeAttribution />
          </div>
          {reply.results.length === 0 && (
            <p className="text-base text-muted">{S.search.noResults}</p>
          )}
          <ul className="flex flex-col gap-1">
            {reply.results.map((card) => (
              <li key={card.videoId} data-testid="search-row" data-playable={card.playable}>
                <VideoRow
                  videoId={card.videoId}
                  thumbnail={card.thumbnail}
                  title={card.title}
                  dimmed={!card.playable}
                  lines={[
                    [card.channelTitle, fmtDuration(card.durationSec)].filter(Boolean).join(' · '),
                    card.playable ? null : reasonText(card, ctx),
                  ]}
                  action={
                    <button
                      type="button"
                      className={btn.secondary}
                      disabled={!card.playable}
                      aria-label={`${S.search.add}: ${card.title}`}
                      onClick={() => onPick(card)}
                    >
                      {S.search.add}
                    </button>
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
