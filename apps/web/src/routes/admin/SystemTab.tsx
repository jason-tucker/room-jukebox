import type { BackupReply } from '@room-jukebox/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { btn, Chip, Field, input, Notice, Section } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { fmtBytes, fmtDateTime } from '../../lib/format.ts';
import { bridge } from '../../lib/jukebox.ts';
import { S } from '../../strings.ts';
import type { TabProps } from './common.ts';

export function SystemTab(props: TabProps & { onLoggedOut: (note: string | null) => void }) {
  return (
    <>
      <Players {...props} />
      <Backups {...props} />
      <UpdateNow {...props} />
      <PasswordChange {...props} />
      <Section title={S.admin.logout}>
        <button
          type="button"
          className={btn.secondary}
          onClick={() => void api.admin.logout().then(() => props.onLoggedOut(null))}
        >
          {S.admin.logout}
        </button>
      </Section>
    </>
  );
}

function Players({ state }: TabProps) {
  return (
    <Section title={S.admin.players}>
      {state.players.length === 0 && <p className="text-base text-muted">{S.admin.noPlayers}</p>}
      <ul className="flex flex-col gap-2">
        {state.players.map((p) => (
          <li key={p.id} className="flex flex-col gap-1 rounded-2xl bg-surface p-3 text-base">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-semibold">{p.name}</span>
              <Chip
                tone={
                  p.status === 'online' ? 'accent' : p.status === 'offline' ? 'danger' : 'neutral'
                }
              >
                {S.admin.playerStatus[p.status]}
              </Chip>
            </div>
            <div className="text-muted">
              {[
                p.lanAddress,
                p.role,
                p.drift !== null ? S.admin.drift(p.drift) : null,
                fmtDateTime(p.lastSeen),
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Backups({ run }: TabProps) {
  const [list, setList] = useState<BackupReply[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void run(api.admin.backups()).then((r) => {
      if (live && r.ok) setList(r.data.backups);
    });
    return () => {
      live = false;
    };
  }, [run, reload]);

  const now = async () => {
    setBusy(true);
    const r = await run(api.admin.backup(), S.admin.backupDone);
    setBusy(false);
    if (r.ok) setReload((n) => n + 1);
  };

  return (
    <Section title={S.admin.backup}>
      <button
        type="button"
        className={`${btn.primary} self-start`}
        disabled={busy}
        onClick={() => void now()}
      >
        {busy ? S.app.working : S.admin.backupNow}
      </button>
      {list && list.length === 0 && <p className="text-base text-muted">{S.admin.noBackups}</p>}
      {list && list.length > 0 && (
        <ul className="flex flex-col gap-1 text-base">
          {list.map((b) => (
            <li key={b.path} className="flex flex-col rounded-xl bg-surface px-3 py-2">
              <span className="font-semibold">{fmtDateTime(b.at)}</span>
              <span className="break-all text-muted">
                {fmtBytes(b.bytes)} · {b.path}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function UpdateNow({ push }: TabProps) {
  const install = bridge()?.installUpdate;
  if (typeof install !== 'function') return null;
  return (
    <Section title={S.admin.update}>
      <p className="text-base text-muted">{S.admin.updateHint}</p>
      <button
        type="button"
        className={`${btn.secondary} self-start`}
        onClick={() => {
          push(S.admin.updateStarted);
          void Promise.resolve(install());
        }}
      >
        {S.admin.update}
      </button>
    </Section>
  );
}

function PasswordChange({
  run,
  onLoggedOut,
}: TabProps & { onLoggedOut: (note: string | null) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const problem =
    next && next.length < 8
      ? S.admin.passwordShort
      : confirm && next !== confirm
        ? S.admin.passwordMismatch
        : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !current || !next || next !== confirm) return;
    setBusy(true);
    const r = await run(api.admin.changePassword({ current, next }));
    setBusy(false);
    if (r.ok) onLoggedOut(S.admin.passwordChanged);
  };

  return (
    <Section title={S.admin.passwordChange}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label={S.admin.currentPassword}>
          <input
            className={input}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label={S.admin.newPassword}>
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label={S.admin.confirmPassword}>
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {problem && <Notice tone="error">{problem}</Notice>}
        <button
          type="submit"
          className={`${btn.primary} self-end`}
          disabled={busy || !!problem || !current || !next || next !== confirm}
        >
          {S.admin.passwordChange}
        </button>
      </form>
    </Section>
  );
}
