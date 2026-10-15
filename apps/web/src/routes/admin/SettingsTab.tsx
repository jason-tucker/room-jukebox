import type { LanReply, Limits, SearchSource, SettingsPatch } from '@room-jukebox/shared';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { btn, Field, input, Section } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { S } from '../../strings.ts';
import type { TabProps } from './common.ts';

export function SettingsTab(props: TabProps) {
  return (
    <>
      <RoomName {...props} />
      <LimitsForm {...props} />
      <SearchSourceForm {...props} />
      <WifiForm {...props} />
      <LanPicker {...props} />
      <ApiKey {...props} />
    </>
  );
}

function SaveRow({
  busy,
  disabled,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {children}
      <button type="submit" className={btn.primary} disabled={busy || disabled}>
        {busy ? S.app.working : S.app.save}
      </button>
    </div>
  );
}

function usePatch({ run }: Pick<TabProps, 'run'>) {
  const [busy, setBusy] = useState(false);
  const patch = async (body: SettingsPatch) => {
    setBusy(true);
    const r = await run(api.admin.patchSettings(body), S.app.saved);
    setBusy(false);
    return r.ok;
  };
  return { busy, patch };
}

function RoomName({ state, run }: TabProps) {
  const [name, setName] = useState(state.settings.roomName);
  const { busy, patch } = usePatch({ run });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void patch({ roomName: name.trim() });
  };
  return (
    <Section title={S.admin.roomName}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          aria-label={S.admin.roomName}
          className={input}
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <SaveRow busy={busy} disabled={!name.trim() || name.trim() === state.settings.roomName} />
      </form>
    </Section>
  );
}

type NumKey =
  | 'maxPendingPerGuest'
  | 'cooldownSec'
  | 'maxDurationMin'
  | 'perGuestPerDay'
  | 'perGuestIntervalSec'
  | 'perIpPerDay'
  | 'publicPerDay'
  | 'ownerReserve'
  | 'dailyTotal';

function limitsToForm(l: Limits): Record<NumKey, string> {
  return {
    maxPendingPerGuest: String(l.maxPendingPerGuest),
    cooldownSec: String(l.cooldownSec),
    maxDurationMin: String(Math.round((l.maxDurationSec / 60) * 10) / 10),
    perGuestPerDay: String(l.search.perGuestPerDay),
    perGuestIntervalSec: String(l.search.perGuestIntervalSec),
    perIpPerDay: String(l.search.perIpPerDay),
    publicPerDay: String(l.search.publicPerDay),
    ownerReserve: String(l.search.ownerReserve),
    dailyTotal: String(l.search.dailyTotal),
  };
}

const INT_KEYS: NumKey[] = [
  'maxPendingPerGuest',
  'perGuestPerDay',
  'perIpPerDay',
  'publicPerDay',
  'ownerReserve',
  'dailyTotal',
];

function LimitsForm({ state, run }: TabProps) {
  const [form, setForm] = useState(() => limitsToForm(state.settings.limits));
  const [dups, setDups] = useState(state.settings.limits.allowDuplicates);
  const { busy, patch } = usePatch({ run });

  const num = (k: NumKey) => Number(form[k]);
  const valid = (Object.keys(form) as NumKey[]).every((k) => {
    const v = num(k);
    return (
      form[k].trim() !== '' &&
      Number.isFinite(v) &&
      v >= 0 &&
      (!INT_KEYS.includes(k) || Number.isInteger(v))
    );
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const limits: Limits = {
      maxPendingPerGuest: num('maxPendingPerGuest'),
      cooldownSec: num('cooldownSec'),
      allowDuplicates: dups,
      maxDurationSec: Math.round(num('maxDurationMin') * 60),
      search: {
        perGuestPerDay: num('perGuestPerDay'),
        perGuestIntervalSec: num('perGuestIntervalSec'),
        perIpPerDay: num('perIpPerDay'),
        publicPerDay: num('publicPerDay'),
        ownerReserve: num('ownerReserve'),
        dailyTotal: num('dailyTotal'),
      },
    };
    void patch({ limits });
  };

  const numField = (k: NumKey, label: string) => (
    <Field key={k} label={label}>
      <input
        className={input}
        type="number"
        inputMode={INT_KEYS.includes(k) ? 'numeric' : 'decimal'}
        min={0}
        step={INT_KEYS.includes(k) ? 1 : 'any'}
        value={form[k]}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
      />
    </Field>
  );

  return (
    <Section title={S.admin.limits}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {numField('maxPendingPerGuest', S.admin.maxPending)}
          {numField('cooldownSec', S.admin.cooldown)}
          {numField('maxDurationMin', S.admin.maxDurationMin)}
        </div>
        <label className="flex min-h-11 items-center gap-3 text-base">
          <input
            type="checkbox"
            className="size-6 accent-[var(--rj-accent)]"
            checked={dups}
            onChange={(e) => setDups(e.target.checked)}
          />
          {S.admin.allowDuplicates}
        </label>
        <h3 className="text-lg font-bold">{S.admin.budgets}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {numField('dailyTotal', S.admin.dailyTotal)}
          {numField('ownerReserve', S.admin.ownerReserve)}
          {numField('perGuestPerDay', S.admin.perGuestPerDay)}
          {numField('perGuestIntervalSec', S.admin.perGuestIntervalSec)}
          {numField('perIpPerDay', S.admin.perIpPerDay)}
          {numField('publicPerDay', S.admin.publicPerDay)}
        </div>
        <SaveRow busy={busy} disabled={!valid} />
      </form>
    </Section>
  );
}

const SEARCH_SOURCES: SearchSource[] = ['page', 'api-first', 'api-only'];

export function SearchSourceForm({ state, run }: TabProps) {
  const saved: SearchSource = state.settings.search?.source ?? 'page';
  const [source, setSource] = useState<SearchSource>(saved);
  const savedMirror = state.settings.search?.mirror ?? true;
  const [mirror, setMirror] = useState(savedMirror);
  const { busy, patch } = usePatch({ run });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void patch({ search: { source, mirror } });
  };
  return (
    <Section title={S.admin.searchSource}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">{S.admin.searchSource}</legend>
          {SEARCH_SOURCES.map((value) => {
            const text = S.admin.searchSources[value];
            const id = `search-source-${value}`;
            return (
              <label key={value} className="flex items-start gap-3 text-base">
                <input
                  type="radio"
                  name="search-source"
                  value={value}
                  className="mt-0.5 size-6 shrink-0 accent-[var(--rj-accent)]"
                  checked={source === value}
                  aria-labelledby={`${id}-label`}
                  aria-describedby={`${id}-hint`}
                  onChange={() => setSource(value)}
                />
                <span className="flex flex-col">
                  <span id={`${id}-label`} className="font-semibold">
                    {text.label}
                  </span>
                  <span id={`${id}-hint`} className="text-muted">
                    {text.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <label className="flex items-start gap-3 text-base">
          <input
            type="checkbox"
            className="mt-0.5 size-6 shrink-0 accent-[var(--rj-accent)]"
            checked={mirror}
            aria-labelledby="search-mirror-label"
            aria-describedby="search-mirror-hint"
            onChange={(e) => setMirror(e.target.checked)}
          />
          <span className="flex flex-col">
            <span id="search-mirror-label" className="font-semibold">
              {S.admin.searchMirror.label}
            </span>
            <span id="search-mirror-hint" className="text-muted">
              {S.admin.searchMirror.hint}
            </span>
          </span>
        </label>
        <SaveRow busy={busy} disabled={source === saved && mirror === savedMirror} />
      </form>
    </Section>
  );
}

type Security = 'WPA' | 'SAE' | 'WEP' | 'nopass';

export function WifiForm({ state, run }: TabProps) {
  const w = state.settings.wifi;
  const [ssid, setSsid] = useState(w?.ssid ?? '');
  const [password, setPassword] = useState('');
  const [security, setSecurity] = useState<Security>(w?.security ?? 'WPA');
  const [hidden, setHidden] = useState(w?.hidden ?? false);
  const { busy, patch } = usePatch({ run });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ssid.trim()) {
      await patch({ wifi: null, wifiPassword: null });
      return;
    }
    const body: SettingsPatch = { wifi: { ssid: ssid.trim(), security, hidden } };
    if (security === 'nopass') body.wifiPassword = null;
    else if (password) body.wifiPassword = password;
    if (await patch(body)) setPassword('');
  };

  const remove = async () => {
    if (await patch({ wifi: null, wifiPassword: null })) {
      setSsid('');
      setPassword('');
    }
  };

  return (
    <Section title={S.admin.wifi}>
      <p className="text-base text-muted">{S.admin.wifiHint}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
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
          <Field
            label={S.admin.wifiPassword}
            hint={state.settings.hasWifiPassword ? S.admin.wifiPasswordSaved : undefined}
          >
            <input
              className={input}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
        <SaveRow busy={busy}>
          {w && (
            <button
              type="button"
              className={btn.danger}
              disabled={busy}
              onClick={() => void remove()}
            >
              {S.admin.removeWifi}
            </button>
          )}
        </SaveRow>
      </form>
    </Section>
  );
}

function LanPicker({ run }: TabProps) {
  const [lan, setLan] = useState<LanReply | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void run(api.admin.lan()).then((r) => {
      if (live && r.ok) {
        setLan(r.data);
        setChosen(r.data.chosen);
      }
    });
    return () => {
      live = false;
    };
  }, [run]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await run(api.admin.setLan(chosen), S.app.saved);
    if (r.ok) {
      const fresh = await api.admin.lan();
      if (fresh.ok) setLan(fresh.data);
    }
    setBusy(false);
  };

  return (
    <Section title={S.admin.lan}>
      <p className="text-base text-muted">{S.admin.lanHint}</p>
      {lan && (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
          <p className="text-lg font-semibold break-all">{lan.lanUrl}</p>
          {lan.addresses.map((a) => (
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
          <SaveRow busy={busy} disabled={chosen === lan.chosen} />
        </form>
      )}
    </Section>
  );
}

function ApiKey({ state, run }: TabProps) {
  const [key, setKey] = useState('');
  const { busy, patch } = usePatch({ run });
  const { hasApiKey, apiKeyLast4 } = state.settings;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (key.trim() && (await patch({ youtubeApiKey: key.trim() }))) setKey('');
  };

  return (
    <Section title={S.admin.apiKey}>
      <p className="text-base text-muted">
        {hasApiKey ? S.admin.apiKeySaved(apiKeyLast4 ?? '????') : S.admin.apiKeyNone}
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <input
          aria-label={S.admin.apiKey}
          className={input}
          type="password"
          autoComplete="off"
          placeholder={S.admin.apiKeyPlaceholder}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <SaveRow busy={busy} disabled={!key.trim()}>
          {hasApiKey && (
            <button
              type="button"
              className={btn.danger}
              disabled={busy}
              onClick={() => void patch({ youtubeApiKey: null })}
            >
              {S.admin.removeApiKey}
            </button>
          )}
        </SaveRow>
      </form>
    </Section>
  );
}
