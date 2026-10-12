import type { GuestState, SearchReply, VideoCard } from '@room-jukebox/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
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

/** Typing suggestions: wait this long after the last keystroke, and need this many characters. */
export const SUGGEST_DEBOUNCE_MS = 250;
export const SUGGEST_MIN_CHARS = 2;

/** Fetches suggestions for `q`; null keeps what is on screen (dropped, failed or aborted). */
export type SuggestFn = (q: string, signal: AbortSignal) => Promise<string[] | null>;

const SEARCH_ICON =
  'M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z';

/** YouTube shows the typed part plain and the completion bold. */
function SuggestionText({ text, typed }: { text: string; typed: string }) {
  const t = typed.trim().toLowerCase();
  if (t && text.toLowerCase().startsWith(t)) {
    return (
      <span className="min-w-0 flex-1 truncate">
        {text.slice(0, t.length)}
        <b className="font-bold">{text.slice(t.length)}</b>
      </span>
    );
  }
  return <span className="min-w-0 flex-1 truncate font-bold">{text}</span>;
}

/** Search-specific wording for the failures a search can hit; everything else as usual. */
export function searchFailureText(err: ApiFailure, ctx: MessageContext = {}): string {
  if (RESTING.has(err.code)) return S.search.resting;
  if (err.code === 'youtube-unavailable') return S.search.youtubeDown;
  return failureText(err, ctx);
}

/**
 * YouTube-style search. While typing, `suggest` (YouTube's free typing suggestions) fills a
 * dropdown under the box (debounced, stale requests aborted; arrows + Enter or a tap pick one).
 * Results come only on submit (Search, Enter or a picked suggestion) through `runSearch`. They
 * keep the server's order; a playable row is one big tap target that calls `onPick` (the caller
 * opens the "Request this song?" sheet); unplayable rows stay in place, greyed, with their reason
 * and are not tappable. Renders nothing when `search.enabled` is false.
 */
export function SearchBox({
  search,
  runSearch,
  suggest,
  onPick,
  onViewChange,
  ctx = {},
  label = S.search.label,
}: {
  search: GuestState['search'];
  runSearch: (q: string) => Promise<ApiResult<SearchReply>>;
  /** Typing suggestions; none when absent. */
  suggest?: SuggestFn;
  onPick: (card: VideoCard) => void;
  onViewChange?: (view: SearchView) => void;
  ctx?: MessageContext;
  label?: string;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reply, setReply] = useState<SearchReply | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<AbortController | null>(null);
  const listId = useId();

  const cancelSuggest = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current?.abort();
    pending.current = null;
  };
  useEffect(() => cancelSuggest, []);

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

  const showSuggestions = open && suggestions.length > 0;

  const onType = (value: string) => {
    setQ(value);
    cancelSuggest();
    setActive(-1);
    const text = value.trim();
    if (!suggest || text.length < SUGGEST_MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      const ctrl = new AbortController();
      pending.current = ctrl;
      void suggest(text, ctrl.signal).then((list) => {
        if (ctrl.signal.aborted || pending.current !== ctrl) return;
        pending.current = null;
        if (list === null) return;
        setSuggestions(list);
        setActive(-1);
        setOpen(true);
      });
    }, SUGGEST_DEBOUNCE_MS);
  };

  const run = async (raw: string) => {
    cancelSuggest();
    setOpen(false);
    setActive(-1);
    const text = raw.trim();
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const picked = showSuggestions && active >= 0 ? suggestions[active] : undefined;
    if (picked !== undefined) setQ(picked);
    void run(picked ?? q);
  };

  const pick = (text: string) => {
    setQ(text);
    void run(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && showSuggestions) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (suggestions.length === 0) return;
    e.preventDefault();
    if (!open) {
      setOpen(true);
      setActive(e.key === 'ArrowDown' ? 0 : suggestions.length - 1);
      return;
    }
    // -1 is the typed text itself; the arrows wrap through it, as on YouTube.
    const last = suggestions.length - 1;
    if (e.key === 'ArrowDown') setActive((i) => (i >= last ? -1 : i + 1));
    else setActive((i) => (i === -1 ? last : i - 1));
  };

  return (
    <section aria-label={label} className="flex flex-col gap-3" data-testid="search-box">
      <form role="search" onSubmit={submit} className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label={label}
            aria-autocomplete="list"
            aria-controls={showSuggestions ? listId : undefined}
            aria-activedescendant={
              showSuggestions && active >= 0 ? `${listId}-${active}` : undefined
            }
            placeholder={S.search.placeholder}
            className={`${input} rounded-full`}
            value={q}
            maxLength={200}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setOpen(false)}
            onFocus={() => q.trim().length >= SUGGEST_MIN_CHARS && setOpen(true)}
          />
          {showSuggestions && (
            <ul
              id={listId}
              role="listbox"
              aria-label={S.search.suggestions}
              data-testid="search-suggestions"
              className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-2xl bg-bg py-2 shadow-lg ring-1 ring-line"
            >
              {suggestions.map((text, i) => (
                <li
                  key={text}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-testid="search-suggestion"
                  className={`flex min-h-12 cursor-pointer items-center gap-4 px-4 text-lg ${
                    i === active ? 'bg-surface' : 'hover:bg-surface'
                  }`}
                  // Keep focus in the box so blur doesn't close the list before the tap lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(text)}
                >
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    className="size-5 shrink-0 text-muted"
                    fill="currentColor"
                  >
                    <path d={SEARCH_ICON} />
                  </svg>
                  <SuggestionText text={text} typed={q} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="submit"
          className={`${btn.primary} px-4`}
          disabled={busy || !q.trim()}
          aria-label={S.search.submit}
        >
          <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
            <path d={SEARCH_ICON} />
          </svg>
          <span className="sr-only sm:not-sr-only">{S.search.submit}</span>
        </button>
      </form>
      {search.low && search.provider !== 'unofficial' && (
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
