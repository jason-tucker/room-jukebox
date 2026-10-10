import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ToastHost, useToasts } from '../../components/Toasts.tsx';
import { btn, Field, input, Notice, Spinner, TopBar } from '../../components/ui.tsx';
import { api, type ApiResult } from '../../lib/api.ts';
import { desktopAdminToken, desktopVersion, onDesktopToast } from '../../lib/jukebox.ts';
import { failureText } from '../../lib/messages.ts';
import { useSessionState } from '../../lib/ws.ts';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';
import { MusicTab } from './MusicTab.tsx';
import { NowTab } from './NowTab.tsx';
import { QueueTab } from './QueueTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { SystemTab } from './SystemTab.tsx';

type Auth = 'checking' | 'login' | 'in';
type Tab = keyof typeof S.admin.tabs;
const TABS = Object.keys(S.admin.tabs) as Tab[];

/** /admin (and /settings in the desktop window): phone-first owner page. */
export function Admin() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('now');
  const { toasts, push } = useToasts();
  const { state, status, client } = useSessionState('admin', { enabled: auth === 'in' });

  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void desktopVersion().then((v) => {
      if (live) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => onDesktopToast((m, level, ttl) => push(m, level, ttl)), [push]);

  useEffect(() => {
    let live = true;
    void (async () => {
      // Desktop settings window: the bearer is the login (no form).
      if (await desktopAdminToken()) {
        if (live) setAuth('in');
        return;
      }
      const r = await api.admin.session();
      if (!live) return;
      if (r.ok) setAuth('in');
      else {
        setAuth('login');
        if (r.error.status === 403) setLoginNote(S.errors.forbidden);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    return client.onToast((t) => push(t.message, t.level, t.ttlMs));
  }, [client, push]);

  const run: Run = useCallback(
    async <T,>(p: Promise<ApiResult<T>>, ok?: string) => {
      const r = await p;
      if (!r.ok) {
        if (r.error.status === 401) {
          setAuth('login');
          setLoginNote(S.admin.sessionEnded);
        } else push(failureText(r.error), 'error');
      } else if (ok) push(ok);
      return r;
    },
    [push],
  );

  const serverNow = useCallback(() => (client ? client.serverNow() : Date.now()), [client]);

  const loggedOut = (note: string | null) => {
    setLoginNote(note);
    setAuth('login');
  };

  if (auth === 'checking') {
    return (
      <div className="min-h-screen bg-bg text-fg">
        <TopBar title={S.admin.title} />
        <main className="mx-auto max-w-2xl px-4">
          <Spinner />
        </main>
      </div>
    );
  }

  if (auth === 'login') {
    return (
      <div className="min-h-screen bg-bg text-fg">
        <TopBar title={S.admin.loginTitle} />
        <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6">
          <LoginForm note={loginNote} onIn={() => setAuth('in')} />
          <p className="text-base text-muted">{S.admin.gateNote}</p>
          <Link to="/" className="inline-flex min-h-11 items-center text-base text-muted underline">
            {S.privacy.back}
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar title={state?.roomName ?? S.admin.title} />
      <nav
        aria-label="Sections"
        className="sticky top-14 z-10 flex gap-2 overflow-x-auto border-b border-line bg-bg px-4 py-2"
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`min-h-11 shrink-0 rounded-lg px-4 text-base font-semibold ${tab === t ? 'bg-fg text-bg' : 'bg-surface-2 text-fg'}`}
          >
            {S.admin.tabs[t]}
          </button>
        ))}
      </nav>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-4 pb-16">
        {status === 'reconnecting' && <Notice tone="warn">{S.guest.offline}</Notice>}
        {!state ? (
          <Spinner />
        ) : (
          <>
            {tab === 'now' && <NowTab state={state} run={run} push={push} serverNow={serverNow} />}
            {tab === 'queue' && (
              <QueueTab state={state} run={run} push={push} serverNow={serverNow} />
            )}
            {tab === 'music' && (
              <MusicTab state={state} run={run} push={push} serverNow={serverNow} />
            )}
            {tab === 'settings' && (
              <SettingsTab
                key={state.settings.hubEpoch}
                state={state}
                run={run}
                push={push}
                serverNow={serverNow}
              />
            )}
            {tab === 'system' && (
              <SystemTab
                state={state}
                run={run}
                push={push}
                serverNow={serverNow}
                onLoggedOut={loggedOut}
              />
            )}
          </>
        )}
      </main>
      {version && (
        <footer className="px-4 pb-6 text-center text-base text-muted">
          {S.admin.version(version)}
        </footer>
      )}
      <ToastHost toasts={toasts} />
    </div>
  );
}

function LoginForm({ note, onIn }: { note: string | null; onIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (retryUntil === null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= retryUntil) setRetryUntil(null);
    }, 500);
    return () => clearInterval(t);
  }, [retryUntil]);

  const waitSec = retryUntil !== null ? Math.max(0, Math.ceil((retryUntil - now) / 1000)) : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy || waitSec > 0) return;
    setBusy(true);
    setError(null);
    const r = await api.admin.login(password);
    setBusy(false);
    if (r.ok) {
      setPassword('');
      onIn();
      return;
    }
    if (r.error.retryAfterSec) {
      const until = Date.now() + r.error.retryAfterSec * 1000;
      setNow(Date.now());
      setRetryUntil(until);
    }
    // The live countdown below replaces the number in the throttle message.
    setError(
      r.error.code === 'login-throttled' ? S.errors['login-throttled']() : failureText(r.error),
    );
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {note && <Notice>{note}</Notice>}
      <Field label={S.admin.password}>
        <input
          type="password"
          autoComplete="current-password"
          className={input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && (
        <Notice tone="error">
          {error}
          {waitSec > 0 && ` (${waitSec} s)`}
        </Notice>
      )}
      <button
        type="submit"
        className={`${btn.primary} w-full`}
        disabled={!password || busy || waitSec > 0}
      >
        {busy ? S.app.working : S.admin.login}
      </button>
    </form>
  );
}
