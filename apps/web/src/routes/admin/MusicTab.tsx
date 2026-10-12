import type { SearchesReply } from '@room-jukebox/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { SearchBox } from '../../components/SearchBox.tsx';
import { btn, input, Notice, Section } from '../../components/ui.tsx';
import { YouTubeAttribution } from '../../components/YouTubeAttribution.tsx';
import { api } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { failureText } from '../../lib/messages.ts';
import { S } from '../../strings.ts';
import type { TabProps } from './common.ts';
import { useOwnerRequest } from './NowTab.tsx';

export function MusicTab(props: TabProps) {
  return (
    <>
      <Playlists {...props} />
      <OwnerSearch {...props} />
      <SearchesLeft {...props} />
    </>
  );
}

function Playlists({ state, run }: TabProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playlists = state.fallback.playlists;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    const r = await api.admin.addPlaylist(url.trim());
    setBusy(false);
    if (r.ok) setUrl('');
    else if (r.error.status === 401) void run(Promise.resolve(r));
    else setError(failureText(r.error));
  };

  return (
    <Section
      title={S.admin.playlists}
      right={playlists.length > 0 ? <YouTubeAttribution /> : undefined}
    >
      <p className="text-base text-muted">{S.admin.playlistsHint}</p>
      <p className="text-base">{S.admin.poolSize(state.fallback.poolSize)}</p>
      {playlists.length === 0 && <p className="text-base text-muted">{S.admin.noPlaylists}</p>}
      <ul className="flex flex-col gap-2">
        {playlists.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 rounded-2xl bg-surface p-3">
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lg font-semibold break-words underline-offset-4 hover:underline"
            >
              {p.title}
            </a>
            <div className="text-base text-muted">
              {S.admin.videos(p.videoCount)} · {fmtDateTime(p.importedAt)}
            </div>
            {p.lastError && <Notice tone="error">{p.lastError}</Notice>}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={btn.secondary}
                onClick={() => void run(api.admin.refreshPlaylist(p.id))}
              >
                {S.admin.refresh}
              </button>
              <button
                type="button"
                className={btn.danger}
                onClick={() => {
                  if (window.confirm(`${S.app.remove} ${p.title}?`))
                    void run(api.admin.removePlaylist(p.id));
                }}
              >
                {S.app.remove}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2">
        <label htmlFor="playlist-url" className="text-base font-semibold">
          {S.admin.playlistUrl}
        </label>
        <div className="flex gap-2">
          <input
            id="playlist-url"
            className={input}
            inputMode="url"
            placeholder="https://www.youtube.com/playlist?list=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className={btn.secondary} disabled={busy || !url.trim()}>
            {busy ? S.app.working : S.admin.addPlaylist}
          </button>
        </div>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

function OwnerSearch({ state, push }: TabProps) {
  const { flow, sheet, ctx } = useOwnerRequest(state, push);
  const source = state.settings.search?.source ?? 'page';
  const page = source === 'page';
  const title = page ? S.admin.ownerSearchPage : S.admin.ownerSearch;
  return (
    <Section title={title}>
      {state.settings.hasApiKey || source !== 'api-only' ? (
        <>
          <p className="text-base text-muted">
            {page ? S.admin.ownerSearchPageHint : S.admin.ownerSearchHint}
          </p>
          <SearchBox
            label={title}
            search={{ enabled: true, remaining: null, low: false }}
            runSearch={api.admin.search}
            suggest={api.guest.suggest}
            onPick={flow.open}
            ctx={ctx}
          />
        </>
      ) : (
        <p className="text-base text-muted">{S.admin.apiOnlyNoKey}</p>
      )}
      {sheet}
    </Section>
  );
}

function SearchesLeft({ state }: TabProps) {
  const [data, setData] = useState<SearchesReply | null>(null);
  // Refetch whenever the live usage counters move.
  useEffect(() => {
    let live = true;
    void api.admin.searches().then((r) => {
      if (live && r.ok) setData(r.data);
    });
    return () => {
      live = false;
    };
  }, [state.searchUsage.guests, state.searchUsage.owner]);

  const guests = data?.guests ?? state.searchUsage.guests;
  const owner = data?.owner ?? state.searchUsage.owner;
  const resetsAt = data?.resetsAt ?? state.searchUsage.resetsAt;
  const total = data?.dailyTotal ?? state.settings.limits.search.dailyTotal;
  const left = Math.max(0, total - guests - owner);

  return (
    <Section title={S.admin.searchesLeft}>
      <div className="flex flex-col gap-1 rounded-2xl bg-surface p-4 text-base">
        <div className="text-2xl font-bold">{S.admin.searchesTotal(left, total)}</div>
        <div>{S.admin.searchesUsed(guests, owner)}</div>
        <div className="text-muted">{S.admin.resetsAt(resetsAt)}</div>
      </div>
    </Section>
  );
}
