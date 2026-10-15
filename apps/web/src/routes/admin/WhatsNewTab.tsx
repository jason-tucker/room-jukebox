import type { ChecklistState, ReleaseNotesReply, UpdateStatus } from '@room-jukebox/shared';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { btn, Notice, Section, Spinner } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { fmtClock, fmtDateTime } from '../../lib/format.ts';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';

/** How often the Updates card refreshes while the tab is open. */
export const UPDATE_POLL_MS = 10_000;

const T = S.admin.whatsNew;
const MODES = ['immediate', 'quiet', 'off'] as const;
const FEEDS = ['tango', 'github'] as const;

/** The checklist as stored, or an empty one for the installed version. */
export function checklistOf(reply: ReleaseNotesReply): ChecklistState {
  return reply.checklist?.version === reply.installedVersion
    ? reply.checklist
    : { version: reply.installedVersion, done: {}, updatedAt: null };
}

/** Checklist items of the installed version's notes that are not ticked yet. */
export function unverifiedCount(reply: ReleaseNotesReply | null): number {
  if (!reply?.notes) return 0;
  const { done } = checklistOf(reply);
  return reply.notes.checklist.filter((item) => !done[item.id]).length;
}

/** How often the desktop checks the feed in each mode (no automatic checks when off). */
export const CHECK_INTERVAL_MS: Record<UpdateStatus['mode'], number | null> = {
  immediate: 10 * 60_000,
  quiet: 6 * 3600_000,
  off: null,
};

/** When the next automatic check is due, or null (never checked, or updates off). */
export function nextCheckAt(s: Pick<UpdateStatus, 'mode' | 'lastCheckAt'>): number | null {
  const every = CHECK_INTERVAL_MS[s.mode];
  return every === null || s.lastCheckAt === null ? null : s.lastCheckAt + every;
}

export function stateLine(s: UpdateStatus): string {
  const text = T.states[s.state];
  return typeof text === 'function' ? text(s.available) : text;
}

export interface WhatsNewProps {
  reply: ReleaseNotesReply | null;
  setReply: Dispatch<SetStateAction<ReleaseNotesReply | null>>;
  run: Run;
}

/** Admin → What's new: the installed version's changes, its test checklist and update controls. */
export function WhatsNewTab({ reply, setReply, run }: WhatsNewProps) {
  return (
    <>
      {reply === null ? <Spinner /> : <Notes reply={reply} setReply={setReply} run={run} />}
      <Updates run={run} />
    </>
  );
}

function Notes({ reply, setReply, run }: WhatsNewProps & { reply: ReleaseNotesReply }) {
  const notes = reply.notes;
  const checklist = checklistOf(reply);

  const setDone = (id: string, value: boolean) =>
    setReply((r) => {
      if (r === null) return r;
      const c = checklistOf(r);
      return { ...r, checklist: { ...c, done: { ...c.done, [id]: value } } };
    });

  const toggle = async (id: string, value: boolean) => {
    setDone(id, value); // optimistic
    const r = await run(
      api.admin.patchChecklist({ version: checklist.version, done: { [id]: value } }),
    );
    if (!r.ok) setDone(id, !value);
  };

  if (!notes) {
    return <Notice>{T.noNotes(reply.installedVersion)}</Notice>;
  }
  const total = notes.checklist.length;
  const verified = notes.checklist.filter((item) => checklist.done[item.id]).length;

  return (
    <>
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{T.title(notes.version)}</h2>
        <p className="text-base text-muted">{T.released(notes.date)}</p>
      </header>

      {notes.changes.length > 0 && (
        <Section title={T.changes}>
          <ul className="flex list-disc flex-col gap-2 pl-6 text-base">
            {notes.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Section>
      )}

      {total > 0 && (
        <Section
          title={T.checklist}
          right={
            <span data-testid="checklist-progress" className="text-base font-semibold text-muted">
              {T.progress(verified, total)}
            </span>
          }
        >
          <p className="text-base text-muted">{T.checklistHint}</p>
          <ul className="flex flex-col gap-2">
            {notes.checklist.map((item) => {
              const done = !!checklist.done[item.id];
              return (
                <li key={item.id}>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl bg-surface p-3 text-base">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-7 shrink-0 accent-[var(--rj-accent)]"
                      checked={done}
                      onChange={(e) => void toggle(item.id, e.target.checked)}
                    />
                    <span className={done ? 'text-muted line-through' : ''}>{item.text}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {verified === total && <Notice>{T.allVerified}</Notice>}
        </Section>
      )}
    </>
  );
}

function Updates({ run }: { run: Run }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = () =>
      void api.admin.updateStatus().then((r) => {
        if (live && r.ok) setStatus(r.data);
      });
    refresh();
    const t = setInterval(refresh, UPDATE_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const act = async (p: () => ReturnType<typeof api.admin.updateStatus>) => {
    setBusy(true);
    const r = await run(p());
    setBusy(false);
    if (r.ok) setStatus(r.data);
  };

  if (status === null) {
    return (
      <Section title={T.updates}>
        <Spinner />
      </Section>
    );
  }

  const installable = status.state === 'available' || status.state === 'downloaded';

  return (
    <Section title={T.updates}>
      <div className="flex flex-col gap-4 rounded-2xl bg-surface p-4 text-base">
        <p className="font-semibold">{T.current(status.current)}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">{T.mode}</legend>
          {MODES.map((m) => (
            <label key={m} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                name="update-mode"
                value={m}
                className="size-6 shrink-0 accent-[var(--rj-accent)]"
                checked={status.mode === m}
                disabled={busy}
                onChange={() => void act(() => api.admin.updateMode(m))}
              />
              {T.modes[m]}
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">{T.feed}</legend>
          <div className="flex flex-wrap gap-x-6">
            {FEEDS.map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="update-feed"
                  value={f}
                  className="size-6 shrink-0 accent-[var(--rj-accent)]"
                  checked={status.feed === f}
                  disabled={busy}
                  onChange={() => void act(() => api.admin.updateFeed(f))}
                />
                {T.feeds[f]}
              </label>
            ))}
          </div>
          {status.feedUrl && (
            <p data-testid="feed-url" className="break-all text-muted">
              {status.feedUrl}
            </p>
          )}
        </fieldset>

        <div className="flex flex-col gap-1">
          <p data-testid="update-state" className="font-semibold">
            {stateLine(status)}
          </p>
          <p className="text-muted">
            {status.lastCheckAt !== null
              ? T.lastCheck(fmtDateTime(status.lastCheckAt))
              : T.neverChecked}
          </p>
          {nextCheckAt(status) !== null && (
            <p data-testid="next-check" className="text-muted">
              {T.nextCheck(fmtClock(nextCheckAt(status)!))}
            </p>
          )}
        </div>

        {status.message &&
          (status.state === 'error' ? (
            <Notice tone="error">{status.message}</Notice>
          ) : (
            <p className="text-muted">{status.message}</p>
          ))}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={btn.secondary}
            disabled={busy || status.state === 'checking'}
            onClick={() => void act(() => api.admin.updateCheck())}
          >
            {busy ? S.app.working : T.checkNow}
          </button>
          <button
            type="button"
            className={btn.primary}
            disabled={busy || !installable}
            onClick={() => {
              if (window.confirm(T.installConfirm)) void act(() => api.admin.updateInstall());
            }}
          >
            {T.installNow}
          </button>
        </div>
      </div>
    </Section>
  );
}
