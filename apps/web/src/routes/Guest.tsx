import type { RequestReply } from '@room-jukebox/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ForgetDoneSheet,
  GuestFooter,
  NoticeModal,
  StepsStrip,
} from '../components/GuestChrome.tsx';
import { NowPlayingCard } from '../components/NowPlayingCard.tsx';
import { QueueList } from '../components/QueueList.tsx';
import { ResolveSheet } from '../components/ResolveSheet.tsx';
import { SearchBox } from '../components/SearchBox.tsx';
import { ToastHost, useToasts } from '../components/Toasts.tsx';
import { btn, input, Notice, Spinner, TopBar } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { failureText } from '../lib/messages.ts';
import { clearLocal, KEYS, readLocal, writeLocal } from '../lib/storage.ts';
import { useRequestFlow } from '../lib/useRequestFlow.ts';
import { useSessionState } from '../lib/ws.ts';
import { LINKS, S } from '../strings.ts';

/** On Android, open the YouTube app directly; the intent falls back to the web results page. */
export function findOnYouTubeHref(userAgent: string): string {
  const web = LINKS.findOnYouTube;
  if (!/Android/i.test(userAgent)) return web;
  return `intent://www.youtube.com/results?search_query=#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=${encodeURIComponent(web)};end`;
}

export function Guest() {
  const [helloDone, setHelloDone] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [name, setName] = useState(() => readLocal(KEYS.name) ?? '');
  const [savedName, setSavedName] = useState(() => readLocal(KEYS.name) ?? '');
  const [stepsOpen] = useState(() => readLocal(KEYS.stepsSeen) !== '1');
  const [manual, setManual] = useState('');
  const [forgetDone, setForgetDone] = useState(false);
  const manualRef = useRef<HTMLInputElement>(null);
  const { toasts, push } = useToasts();

  const { state, status, client } = useSessionState('guest', { enabled: helloDone });

  // Cookie first (hello), then the socket. The notice shows unless this phone or the server
  // already has the acceptance.
  useEffect(() => {
    let live = true;
    const localAccepted = readLocal(KEYS.notice) === '1';
    const stored = readLocal(KEYS.name);
    void api.guest.hello(stored ? { name: stored } : {}).then((r) => {
      if (!live) return;
      setHelloDone(true);
      const serverAccepted = r.ok && r.data.noticeAccepted;
      if (localAccepted && r.ok && !serverAccepted) void api.guest.notice();
      if (serverAccepted) writeLocal(KEYS.notice, '1');
      setNoticeOpen(!localAccepted && !serverAccepted);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    return client.onToast((t) => push(t.message, t.level, t.ttlMs));
  }, [client, push]);

  const serverNow = useCallback(() => (client ? client.serverNow() : Date.now()), [client]);

  const ctx = useMemo(
    () => ({
      maxPendingPerGuest: state?.limits.maxPendingPerGuest ?? null,
      maxDurationSec: state?.limits.maxDurationSec ?? null,
    }),
    [state?.limits.maxPendingPerGuest, state?.limits.maxDurationSec],
  );

  const submit = useCallback(
    (videoId: string, idempotencyKey: string) =>
      api.guest.request({ videoId, idempotencyKey, ...(savedName ? { name: savedName } : {}) }),
    [savedName],
  );
  const onDone = useCallback(
    (reply: RequestReply) => {
      push(
        reply.duplicate
          ? S.guest.alreadyQueued(reply.entry.title)
          : S.guest.added(reply.entry.title),
      );
      setManual('');
    },
    [push],
  );
  const flow = useRequestFlow({ submit, onDone, ctx });

  const acceptNotice = () => {
    writeLocal(KEYS.notice, '1');
    setNoticeOpen(false);
    void api.guest.notice();
  };

  const markStepsSeen = () => writeLocal(KEYS.stepsSeen, '1');

  const onPaste = async () => {
    markStepsSeen();
    flow.setInputError(null);
    let text: string;
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
      text = await navigator.clipboard.readText();
    } catch {
      flow.setInputError(S.guest.clipboardDenied);
      manualRef.current?.focus();
      return;
    }
    if (!text.trim()) {
      flow.setInputError(S.guest.clipboardEmpty);
      return;
    }
    setManual(text.trim());
    await flow.openFromInput(text);
  };

  const onManual = async (e: FormEvent) => {
    e.preventDefault();
    if (manual.trim()) await flow.openFromInput(manual);
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim().slice(0, 40);
    writeLocal(KEYS.name, clean || null);
    setSavedName(clean);
    const r = await api.guest.setName(clean || null);
    if (r.ok) push(S.guest.nameSaved);
    else push(failureText(r.error), 'error');
  };

  const forget = async () => {
    if (!window.confirm(S.guest.forgetConfirm)) return;
    const r = await api.guest.forget();
    if (!r.ok) {
      push(failureText(r.error), 'error');
      return;
    }
    clearLocal();
    setName('');
    setSavedName('');
    setForgetDone(true);
  };

  const roomName = state?.roomName ?? S.app.name;

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar title={roomName} />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-4">
        {helloDone && status === 'reconnecting' && <Notice tone="warn">{S.guest.offline}</Notice>}

        <section aria-label={S.guest.stepsTitle} className="flex flex-col gap-3">
          <a
            href={findOnYouTubeHref(navigator.userAgent)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={markStepsSeen}
            className={`${btn.primary} min-h-16 w-full text-xl`}
          >
            <svg aria-hidden viewBox="0 0 24 24" className="size-7" fill="currentColor">
              <path d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" />
            </svg>
            {S.guest.find}
          </a>
          <details open={stepsOpen} className="rounded-2xl">
            <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold text-muted">
              {S.guest.stepsTitle}
            </summary>
            <div className="pt-2">
              <StepsStrip />
            </div>
          </details>
          <button
            type="button"
            onClick={() => void onPaste()}
            disabled={flow.resolving}
            className={`${btn.secondary} min-h-14 w-full text-lg`}
          >
            <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
              <path d="M16 3h-1.2a3 3 0 0 0-5.6 0H8a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-4-1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4 18H8V5h1v2h6V5h1v15Z" />
            </svg>
            {flow.resolving ? S.guest.resolving : S.guest.paste}
          </button>
          <form onSubmit={(e) => void onManual(e)} className="flex flex-col gap-2">
            <label htmlFor="manual-link" className="text-base text-muted">
              {S.guest.manualLabel}
            </label>
            <div className="flex gap-2">
              <input
                id="manual-link"
                ref={manualRef}
                className={input}
                inputMode="url"
                autoComplete="off"
                placeholder={S.guest.manualPlaceholder}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
              />
              <button
                type="submit"
                className={btn.secondary}
                disabled={!manual.trim() || flow.resolving}
              >
                {S.guest.manualSubmit}
              </button>
            </div>
          </form>
          {flow.inputError && <Notice tone="error">{flow.inputError}</Notice>}
        </section>

        {state && (
          <SearchBox
            search={state.search}
            runSearch={api.guest.search}
            onPick={flow.open}
            ctx={ctx}
          />
        )}

        <section aria-label={S.guest.nowPlaying} className="flex flex-col gap-2">
          <h2 className="text-xl font-bold">{S.guest.nowPlaying}</h2>
          {state ? (
            <NowPlayingCard np={state.playback.nowPlaying} serverNow={serverNow} />
          ) : (
            <Spinner />
          )}
        </section>

        {state && (
          <QueueList entries={state.queue} title={S.guest.upNext} empty={S.guest.queueEmpty} />
        )}

        <form onSubmit={(e) => void saveName(e)} className="flex flex-col gap-2">
          <label htmlFor="guest-name" className="text-base font-semibold">
            {S.guest.nameLabel}
          </label>
          <div className="flex gap-2">
            <input
              id="guest-name"
              className={input}
              autoComplete="nickname"
              maxLength={40}
              placeholder={S.guest.namePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className={btn.secondary} disabled={name.trim() === savedName}>
              {S.app.save}
            </button>
          </div>
        </form>

        <GuestFooter onForget={() => void forget()} />
      </main>

      {flow.pending && (
        <ResolveSheet
          video={flow.pending.video}
          busy={flow.busy}
          error={flow.sheetError}
          onConfirm={() => void flow.confirm()}
          onClose={flow.close}
          ctx={ctx}
        />
      )}
      {noticeOpen && <NoticeModal onContinue={acceptNotice} />}
      {forgetDone && <ForgetDoneSheet onClose={() => setForgetDone(false)} />}
      <ToastHost toasts={toasts} />
    </div>
  );
}
