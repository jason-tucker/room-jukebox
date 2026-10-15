import { useEffect, useRef, useState } from 'react';
import { S } from '../strings.ts';
import { btn } from './ui.tsx';

/** YouTube's mobile site through the hub's mirror, opened on an empty search. */
export const BROWSE_SRC = '/yt/results?search_query=';
/** No `load` within this long: the panel gives up and points at the search box. */
export const BROWSE_TIMEOUT_MS = 8000;

const VIDEO_ID = /^[\w-]{11}$/;

/** A `{ type: 'rj-pick', videoId, title }` message from the mirror's injected script, or null. */
export function parsePick(data: unknown): { videoId: string; title: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'rj-pick' || typeof d.videoId !== 'string' || !VIDEO_ID.test(d.videoId)) {
    return null;
  }
  const title = typeof d.title === 'string' ? d.title.trim().slice(0, 300) : '';
  return { videoId: d.videoId, title };
}

/** True when the frame's first page is the mirror's error page or not a mirrored page at all. */
function frameFailed(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument;
    if (!doc) return false;
    if (doc.querySelector('meta[name="rj-mirror-error"]')) return true;
    const win = frame.contentWindow as (Window & { __rjMirror?: boolean }) | null;
    return win?.__rjMirror !== true;
  } catch {
    return false;
  }
}

/**
 * Full-screen "Browse YouTube": YouTube's mobile site in a same-origin iframe (the hub mirrors it
 * under `/yt/*` and injects a script that turns taps on videos into `rj-pick` messages). Each
 * pick goes to `onPick` (the page opens the request sheet over the panel); the panel stays open
 * for the next one until Done. `onFail` when YouTube doesn't load in time or the mirror answered
 * an error page.
 */
export function BrowsePanel({
  title,
  onDone,
  onPick,
  onFail,
  src = BROWSE_SRC,
  timeoutMs = BROWSE_TIMEOUT_MS,
}: {
  title: string;
  onDone: () => void;
  onPick: (videoId: string, title: string) => void;
  onFail: () => void;
  src?: string;
  timeoutMs?: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const [ready, setReady] = useState(false);
  const failRef = useRef(onFail);
  const pickRef = useRef(onPick);
  useEffect(() => {
    failRef.current = onFail;
    pickRef.current = onPick;
  });

  useEffect(() => {
    const t = setTimeout(() => {
      if (!loaded.current) failRef.current();
    }, timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (e.origin !== window.location.origin && e.origin !== 'null') return;
      const pick = parsePick(e.data);
      if (pick) pickRef.current(pick.videoId, pick.title);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const onLoad = () => {
    if (loaded.current) return;
    loaded.current = true;
    if (frame.current && frameFailed(frame.current)) {
      failRef.current();
      return;
    }
    setReady(true);
  };

  return (
    <div
      data-testid="browse-panel"
      className="fixed inset-0 z-30 flex flex-col bg-bg text-fg"
      role="dialog"
      aria-label={S.guest.browse}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-lg font-bold">{title}</span>
          <span className="truncate text-sm text-muted">{S.guest.browseHint}</span>
        </div>
        <button type="button" className={`${btn.primary} min-h-11 px-5`} onClick={onDone}>
          {S.guest.browseDone}
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-base text-muted">
            {S.guest.browseLoading}
          </div>
        )}
        <iframe
          ref={frame}
          title={S.guest.browseFrameTitle}
          src={src}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          className={`relative size-full border-0 bg-white ${ready ? '' : 'opacity-0'}`}
          onLoad={onLoad}
        />
      </div>
    </div>
  );
}
