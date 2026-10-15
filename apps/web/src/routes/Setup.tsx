import type { SetupBody, SetupStatusReply } from '@room-jukebox/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { btn, Field, input, Notice, Spinner, TopBar } from '../components/ui.tsx';
import { api, type ApiFailure } from '../lib/api.ts';
import { normalizeHubAddress } from '../lib/hub.ts';
import { bridge, type HeardHub, type PairResult } from '../lib/jukebox.ts';
import { failureText } from '../lib/messages.ts';
import { LINKS, S } from '../strings.ts';

/*
 * /setup: first-run wizard (plan §4 "First run", M1 subset). Loopback only on the server side;
 * reachable only while `needsSetup` is true, otherwise it sends the owner to /admin.
 * Nothing secret is kept by the page: the reply's tokens are used once (LAN choice), handed to the
 * desktop via `window.jukebox.setupComplete(reply)`, and dropped.
 */

type Security = 'WPA' | 'SAE' | 'WEP' | 'nopass';
const STEPS = ['welcome', 'password', 'room', 'key', 'playlists', 'wifi', 'lan', 'finish'] as const;
/** Player path (M2): join a hub instead of becoming one. */
const PLAYER_STEPS = ['welcome', 'join'] as const;
type Step = (typeof STEPS)[number] | 'join';
type Role = 'hub' | 'player';

const hubUrl = (h: HeardHub) => `http://${h.address}:${h.port}`;

/** Plain words for a failed `pair()`. */
export function pairErrorText(r: Extract<PairResult, { ok: false }>): string {
  if (r.code === 'bad-password' || r.code === 'unreachable' || r.code === 'bad-proof') {
    return S.setup.pairErrors[r.code];
  }
  if (r.code === 'login-throttled') return S.errors['login-throttled'](r.retryAfterSec);
  return r.message || S.errors.generic;
}

export function isLoopback(address: string): boolean {
  const a = address.toLowerCase();
  return a === 'localhost' || a === '::1' || a.startsWith('127.') || a === '0.0.0.0';
}

export function Setup() {
  const [status, setStatus] = useState<SetupStatusReply | null>(null);
  const [loadError, setLoadError] = useState<ApiFailure | null>(null);
  const [step, setStep] = useState<Step>('welcome');
  const [accepted, setAccepted] = useState(false);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [roomName, setRoomName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [playlists, setPlaylists] = useState<string[]>(['']);
  const [ssid, setSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [security, setSecurity] = useState<Security>('WPA');
  const [hidden, setHidden] = useState(false);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // M2: hubs heard on the LAN, and whether this laptop joins one (Player) or becomes one (Hub).
  const [canPair] = useState(() => typeof bridge()?.pair === 'function');
  const [hubs, setHubs] = useState<HeardHub[]>([]);
  const [lastHeardRoom, setLastHeardRoom] = useState<string | null>(null);
  const [roleChoice, setRoleChoice] = useState<Role | null>(null);
  const [pickedHub, setPickedHub] = useState<string | null>(null);
  const [manualAddress, setManualAddress] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    const b = bridge();
    if (!canPair || !b) return;
    let live = true;
    const apply = (list: HeardHub[]) => {
      if (!live || !Array.isArray(list)) return;
      setHubs(list);
      if (list[0]) setLastHeardRoom(list[0].roomName);
    };
    if (typeof b.hubs === 'function') {
      void Promise.resolve()
        .then(() => b.hubs!())
        .then(apply, () => undefined);
    }
    let off: (() => void) | undefined;
    try {
      off = b.onHubs?.(apply) ?? undefined;
    } catch {
      off = undefined;
    }
    return () => {
      live = false;
      off?.();
    };
  }, [canPair]);

  useEffect(() => {
    let live = true;
    void api.setup.status().then((r) => {
      if (!live) return;
      if (!r.ok) {
        setLoadError(r.error);
        return;
      }
      setStatus(r.data);
      const usable = r.data.lan.addresses.filter((a) => !isLoopback(a.address));
      const initial = usable.find((a) => a.address === r.data.lan.chosen) ?? usable[0];
      setChosen(initial?.address ?? '');
    });
    return () => {
      live = false;
    };
  }, []);

  if (loadError?.status === 409 || (status && !status.needsSetup && !done)) {
    return <Navigate to="/admin" replace />;
  }

  const heard = hubs.length > 0;
  const role: Role = roleChoice ?? (canPair && heard ? 'player' : 'hub');
  const steps: readonly Step[] = role === 'player' ? PLAYER_STEPS : STEPS;
  const index = steps.indexOf(step);
  const go = (delta: number) =>
    setStep(steps[Math.min(steps.length - 1, Math.max(0, index + delta))]!);
  const chosenHub = hubs.find((h) => h.hubId === pickedHub) ?? hubs[0] ?? null;
  const joinAddress = chosenHub ? hubUrl(chosenHub) : normalizeHubAddress(manualAddress);
  const joinRoom = chosenHub?.roomName ?? lastHeardRoom;

  const pickRole = (next: Role) => {
    // Starting a second hub next to a running one is almost always a mistake: confirm it.
    if (next === 'hub' && heard && !window.confirm(S.setup.separateConfirm(hubs[0]!.roomName))) {
      return;
    }
    setRoleChoice(next);
  };

  const join = async () => {
    const pair = bridge()?.pair;
    if (!pair || !joinAddress) return;
    setBusy(true);
    setSubmitError(null);
    let r: PairResult;
    try {
      r = await pair({
        hubAddress: joinAddress,
        password: ownerPassword,
        deviceName: deviceName.trim(),
      });
    } catch {
      r = { ok: false, code: 'unreachable' };
    }
    setBusy(false);
    if (!r.ok) {
      setSubmitError(pairErrorText(r));
      return;
    }
    setOwnerPassword('');
    setJoined(true);
  };
  const usable = status?.lan.addresses.filter((a) => !isLoopback(a.address)) ?? [];

  const pwProblem =
    password.length > 0 && password.length < 8
      ? S.admin.passwordShort
      : password2.length > 0 && password !== password2
        ? S.admin.passwordMismatch
        : null;

  const canNext: Record<Step, boolean> = {
    welcome: accepted,
    password: password.length >= 8 && password === password2,
    room: roomName.trim().length > 0,
    key: true,
    playlists: true,
    wifi: true,
    lan: true,
    finish: true,
    join: !!joinAddress && ownerPassword.length > 0 && deviceName.trim().length > 0,
  };

  const finish = async () => {
    setBusy(true);
    setSubmitError(null);
    const urls = playlists.map((u) => u.trim()).filter(Boolean);
    const body: SetupBody = {
      password,
      roomName: roomName.trim(),
      noticeAccepted: true,
      ...(apiKey.trim() ? { youtubeApiKey: apiKey.trim() } : {}),
      ...(urls.length ? { fallbackPlaylistUrls: urls } : {}),
      ...(ssid.trim()
        ? {
            wifi: {
              ssid: ssid.trim(),
              password: security === 'nopass' ? '' : wifiPassword,
              security,
              hidden,
            },
          }
        : {}),
    };
    const r = await api.setup.submit(body);
    if (!r.ok) {
      setBusy(false);
      setSubmitError(r.error.status === 409 ? S.errors.setupDone : failureText(r.error));
      return;
    }
    // The LAN choice is not part of SetupBody: apply it once with the fresh desktop token.
    if (chosen && status && chosen !== status.lan.chosen) {
      await api.admin.setLan(chosen, r.data.token);
    }
    setBusy(false);
    setPassword('');
    setPassword2('');
    setDone(true);
    try {
      void Promise.resolve(bridge()?.setupComplete?.(r.data));
    } catch {
      // the desktop picks it up from the server hook anyway
    }
  };

  if (joined) {
    return (
      <Shell>
        <div className="flex flex-col gap-4" data-testid="join-done">
          <h2 className="text-3xl font-bold">{S.setup.joinDone}</h2>
          <p className="text-lg">{S.setup.joinDoneBody}</p>
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="flex flex-col gap-4">
          <h2 className="text-3xl font-bold">{S.setup.done}</h2>
          <p className="text-lg">{S.setup.doneBody}</p>
          <Link to="/admin" className={`${btn.primary} self-start`}>
            {S.setup.openAdmin}
          </Link>
        </div>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell>
        <Notice tone="error">{failureText(loadError)}</Notice>
      </Shell>
    );
  }
  if (!status) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }

  let body: ReactNode;
  switch (step) {
    case 'welcome':
      body = (
        <Panel title={S.setup.welcome}>
          <p className="text-lg">{S.setup.welcomeBody}</p>
          <label className="flex min-h-11 items-start gap-3 text-lg">
            <input
              type="checkbox"
              className="mt-1 size-6 shrink-0 accent-[var(--rj-accent)]"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>{S.setup.accept}</span>
          </label>
          <p className="flex flex-wrap gap-x-5 text-base">
            <a
              className="inline-flex min-h-11 items-center text-accent underline"
              href={LINKS.youtubeTerms}
              target="_blank"
              rel="noopener noreferrer"
            >
              {S.footer.terms}
            </a>
            <Link
              className="inline-flex min-h-11 items-center text-accent underline"
              to="/privacy"
              target="_blank"
            >
              {S.footer.privacy}
            </Link>
          </p>
          {canPair && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-lg font-semibold">{S.setup.role}</legend>
              <RoleOption
                checked={role === 'player'}
                onPick={() => pickRole('player')}
                title={heard ? S.setup.joinHub(hubs[0]!.roomName) : S.setup.joinAnother}
                body={S.setup.joinHubBody}
              />
              <RoleOption
                checked={role === 'hub'}
                onPick={() => pickRole('hub')}
                title={heard ? S.setup.separateHub : S.setup.newHub}
                body={heard ? S.setup.separateHubBody : S.setup.newHubBody}
              />
            </fieldset>
          )}
        </Panel>
      );
      break;
    case 'join':
      body = (
        <Panel title={S.setup.joinTitle}>
          <p className="text-lg">{S.setup.joinBody}</p>
          {hubs.length > 1 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-base font-semibold">{S.setup.pickHub}</legend>
              {hubs.map((h) => (
                <label
                  key={h.hubId}
                  className="flex min-h-11 items-center gap-3 rounded-xl bg-surface px-3 text-base"
                >
                  <input
                    type="radio"
                    name="hub"
                    className="size-6 accent-[var(--rj-accent)]"
                    checked={chosenHub?.hubId === h.hubId}
                    onChange={() => setPickedHub(h.hubId)}
                  />
                  <span className="font-semibold">{h.roomName}</span>
                  <span className="text-muted">
                    {h.address}:{h.port}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {!heard && (
            <>
              <Notice tone="warn">{S.setup.turnOn(joinRoom)}</Notice>
              <Field label={S.setup.hubAddress}>
                <input
                  className={input}
                  inputMode="url"
                  autoComplete="off"
                  placeholder={S.setup.hubAddressPlaceholder}
                  value={manualAddress}
                  onChange={(e) => setManualAddress(e.target.value)}
                />
              </Field>
            </>
          )}
          <Field label={S.setup.ownerPassword}>
            <input
              className={input}
              type="password"
              autoComplete="current-password"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
            />
          </Field>
          <Field label={S.setup.thisRoom}>
            <input
              className={input}
              maxLength={40}
              placeholder={S.setup.thisRoomPlaceholder}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </Field>
          <p className="-mt-2 text-base text-muted">{S.setup.thisRoomBody}</p>
          {submitError && <Notice tone="error">{submitError}</Notice>}
        </Panel>
      );
      break;
    case 'password':
      body = (
        <Panel title={S.setup.password}>
          <p className="text-lg">{S.setup.passwordBody}</p>
          <Field label={S.admin.newPassword}>
            <input
              className={input}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={S.admin.confirmPassword}>
            <input
              className={input}
              type="password"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
            />
          </Field>
          {pwProblem && <Notice tone="error">{pwProblem}</Notice>}
        </Panel>
      );
      break;
    case 'room':
      body = (
        <Panel title={S.setup.roomName}>
          <p className="text-lg">{S.setup.roomNameBody}</p>
          <input
            aria-label={S.setup.roomName}
            className={input}
            maxLength={40}
            placeholder={S.setup.roomNamePlaceholder}
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
          />
        </Panel>
      );
      break;
    case 'key':
      body = (
        <Panel title={S.setup.apiKey}>
          <p className="text-lg">{S.setup.apiKeyBody}</p>
          <details className="rounded-2xl bg-surface p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold">
              {S.setup.apiKeyStepsTitle}
            </summary>
            <ol className="list-decimal pl-6 text-base">
              {S.setup.apiKeySteps.map((s, i) => (
                <li key={s} className="py-1">
                  {i === 0 ? (
                    <a
                      className="text-accent underline"
                      href={LINKS.cloudConsole}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {s}
                    </a>
                  ) : (
                    s
                  )}
                </li>
              ))}
            </ol>
          </details>
          <input
            aria-label={S.admin.apiKey}
            className={input}
            type="password"
            autoComplete="off"
            placeholder={S.admin.apiKeyPlaceholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Panel>
      );
      break;
    case 'playlists':
      body = (
        <Panel title={S.setup.playlists}>
          <p className="text-lg">{S.setup.playlistsBody}</p>
          {playlists.map((u, i) => (
            <input
              key={i}
              aria-label={`${S.admin.playlistUrl} ${i + 1}`}
              className={input}
              inputMode="url"
              placeholder="https://www.youtube.com/playlist?list=…"
              value={u}
              onChange={(e) => setPlaylists((p) => p.map((x, j) => (j === i ? e.target.value : x)))}
            />
          ))}
          <button
            type="button"
            className={`${btn.secondary} self-start`}
            onClick={() => setPlaylists((p) => [...p, ''])}
          >
            {S.setup.addAnother}
          </button>
        </Panel>
      );
      break;
    case 'wifi':
      body = (
        <Panel title={S.setup.wifi}>
          <p className="text-lg">{S.setup.wifiBody}</p>
          <Field label={S.admin.ssid}>
            <input
              className={input}
              autoComplete="off"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
            />
          </Field>
          <Field label={S.admin.security}>
            <select
              className={input}
              value={security}
              onChange={(e) => setSecurity(e.target.value as Security)}
            >
              {(Object.keys(S.admin.securityOptions) as Security[]).map((k) => (
                <option key={k} value={k}>
                  {S.admin.securityOptions[k]}
                </option>
              ))}
            </select>
          </Field>
          {security !== 'nopass' && (
            <Field label={S.admin.wifiPassword}>
              <input
                className={input}
                type="password"
                autoComplete="off"
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
              />
            </Field>
          )}
          <label className="flex min-h-11 items-center gap-3 text-base">
            <input
              type="checkbox"
              className="size-6 accent-[var(--rj-accent)]"
              checked={hidden}
              onChange={(e) => setHidden(e.target.checked)}
            />
            {S.admin.hidden}
          </label>
        </Panel>
      );
      break;
    case 'lan':
      body = (
        <Panel title={S.setup.lan}>
          <p className="text-lg">{S.setup.lanBody}</p>
          {usable.length === 0 && <Notice tone="warn">{S.setup.lanNone}</Notice>}
          {usable.map((a) => (
            <label
              key={`${a.interface}-${a.address}`}
              className="flex min-h-11 items-center gap-3 rounded-xl bg-surface px-3 text-base"
            >
              <input
                type="radio"
                name="lan"
                className="size-6 accent-[var(--rj-accent)]"
                checked={chosen === a.address}
                onChange={() => setChosen(a.address)}
              />
              <span className="font-semibold">{a.address}</span>
              <span className="text-muted">
                {a.interface} · {a.cidr}
              </span>
            </label>
          ))}
        </Panel>
      );
      break;
    case 'finish':
      body = (
        <Panel title={S.setup.finish}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
            <dt className="text-muted">{S.setup.roomName}</dt>
            <dd>{roomName}</dd>
            <dt className="text-muted">{S.admin.apiKey}</dt>
            <dd>{apiKey.trim() ? `…${apiKey.trim().slice(-4)}` : '-'}</dd>
            <dt className="text-muted">{S.setup.playlists}</dt>
            <dd>{playlists.filter((u) => u.trim()).length}</dd>
            <dt className="text-muted">{S.admin.ssid}</dt>
            <dd>{ssid.trim() || '-'}</dd>
            <dt className="text-muted">{S.setup.lan}</dt>
            <dd className="break-all">{chosen || '-'}</dd>
          </dl>
          {submitError && <Notice tone="error">{submitError}</Notice>}
        </Panel>
      );
      break;
  }

  return (
    <Shell>
      <p className="text-base text-muted">{S.setup.stepOf(index + 1, steps.length)}</p>
      {body}
      <div className="mt-6 flex items-center justify-between gap-2">
        <button
          type="button"
          className={btn.ghost}
          disabled={index === 0 || busy}
          onClick={() => go(-1)}
        >
          {S.app.back}
        </button>
        {step === 'join' ? (
          <button
            type="button"
            className={btn.primary}
            disabled={busy || !canNext.join}
            onClick={() => void join()}
          >
            {busy ? S.setup.joining : S.setup.joinButton}
          </button>
        ) : step === 'finish' ? (
          <button
            type="button"
            className={btn.primary}
            disabled={busy}
            onClick={() => void finish()}
          >
            {busy ? S.setup.finishing : S.setup.finish}
          </button>
        ) : (
          <button
            type="button"
            className={btn.primary}
            disabled={!canNext[step]}
            onClick={() => go(1)}
          >
            {S.app.next}
          </button>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar title={S.setup.title} />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">{children}</main>
    </div>
  );
}

function RoleOption({
  checked,
  onPick,
  title,
  body,
}: {
  checked: boolean;
  onPick: () => void;
  title: string;
  body: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl bg-surface p-3 text-base">
      <input
        type="radio"
        name="role"
        className="mt-0.5 size-6 shrink-0 accent-[var(--rj-accent)]"
        checked={checked}
        onChange={onPick}
      />
      <span className="flex flex-col">
        <span className="text-lg font-semibold">{title}</span>
        <span className="text-muted">{body}</span>
      </span>
    </label>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </section>
  );
}
