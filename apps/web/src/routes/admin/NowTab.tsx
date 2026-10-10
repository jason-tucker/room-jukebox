import type { RequestReply } from '@room-jukebox/shared';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { NowPlayingCard } from '../../components/NowPlayingCard.tsx';
import { ResolveSheet } from '../../components/ResolveSheet.tsx';
import { btn, input, Notice, Section } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { fmtClock } from '../../lib/format.ts';
import { useRequestFlow } from '../../lib/useRequestFlow.ts';
import { uuid } from '../../lib/uuid.ts';
import { S } from '../../strings.ts';
import type { TabProps } from './common.ts';

export function NowTab({ state, run, push, serverNow }: TabProps) {
  const np = state.playback.nowPlaying;
  const paused = state.playback.state === 'paused' || (np?.pausedAt ?? null) !== null;
  const [busy, setBusy] = useState(false);

  const transport = async (action: 'play' | 'pause' | 'skip') => {
    if (action === 'skip' && !window.confirm(S.admin.skipConfirm(np?.title ?? ''))) return;
    setBusy(true);
    await run(api.admin.transport({ action, idempotencyKey: uuid() }));
    setBusy(false);
  };

  return (
    <>
      <Section title={S.guest.nowPlaying}>
        <NowPlayingCard np={np} serverNow={serverNow} />
        <div className="flex gap-2">
          <button
            type="button"
            className={`${btn.primary} flex-1`}
            disabled={busy}
            onClick={() => void transport(paused || !np ? 'play' : 'pause')}
          >
            {paused || !np ? S.admin.play : S.admin.pause}
          </button>
          <button
            type="button"
            className={btn.secondary}
            disabled={busy || !np}
            onClick={() => void transport('skip')}
          >
            {S.admin.skip}
          </button>
        </div>
      </Section>
      <AddSong state={state} run={run} push={push} serverNow={serverNow} />
      {state.lastErrors.length > 0 && (
        <Section title={S.admin.lastErrors}>
          <ul className="flex flex-col gap-2">
            {state.lastErrors.map((e) => (
              <li key={`${e.at}-${e.videoId}`} className="rounded-xl bg-surface p-3 text-base">
                <span aria-hidden className="mr-2 inline-block size-2.5 rounded-full bg-danger" />
                {fmtClock(e.at)} · {e.videoId}: {e.message}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** Owner request flow: same resolve sheet as guests, posted to /api/admin/requests. */
export function useOwnerRequest(
  state: TabProps['state'],
  push: TabProps['push'],
  onAdded?: () => void,
) {
  const ctx = useMemo(
    () => ({ maxDurationSec: state.settings.limits.maxDurationSec }),
    [state.settings.limits.maxDurationSec],
  );
  const submit = useCallback(
    (videoId: string, idempotencyKey: string) => api.admin.request({ videoId, idempotencyKey }),
    [],
  );
  const onDone = useCallback(
    (r: RequestReply) => {
      push(S.admin.added(r.entry.title));
      onAdded?.();
    },
    [push, onAdded],
  );
  const flow = useRequestFlow({ submit, onDone, ctx });
  const sheet = flow.pending ? (
    <ResolveSheet
      owner
      video={flow.pending.video}
      busy={flow.busy}
      error={flow.sheetError}
      onConfirm={() => void flow.confirm()}
      onClose={flow.close}
      ctx={ctx}
    />
  ) : null;
  return { flow, sheet, ctx };
}

export function AddSong({ state, push }: TabProps) {
  const [text, setText] = useState('');
  const clear = useCallback(() => setText(''), []);
  const { flow, sheet } = useOwnerRequest(state, push, clear);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) await flow.openFromInput(text);
  };

  return (
    <Section title={S.admin.addSong}>
      <form onSubmit={(e) => void onSubmit(e)} className="flex gap-2">
        <input
          aria-label={S.admin.addSongHint}
          placeholder={S.admin.addSongHint}
          className={input}
          inputMode="url"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className={btn.secondary} disabled={!text.trim() || flow.resolving}>
          {S.admin.check}
        </button>
      </form>
      {flow.inputError && <Notice tone="error">{flow.inputError}</Notice>}
      {sheet}
    </Section>
  );
}
