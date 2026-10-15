import type { ReleaseNotesReply, UpdateStatus } from '@room-jukebox/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../strings.ts';
import { Admin } from './Admin.tsx';
import type { Run } from './common.ts';
import { UPDATE_POLL_MS, WhatsNewTab } from './WhatsNewTab.tsx';

vi.mock('../../lib/ws.ts', () => ({
  useSessionState: () => ({ state: null, status: 'online', client: null }),
}));

const T = S.admin.whatsNew;

const REPLY: ReleaseNotesReply = {
  notes: {
    version: '0.0.8',
    date: '2026-10-14',
    changes: ['Auto-updater', 'What’s new tab', 'TV update notice'],
    checklist: [
      { id: 'a', text: 'First check' },
      { id: 'b', text: 'Second check' },
      { id: 'c', text: 'Third check' },
    ],
  },
  checklist: { version: '0.0.8', done: { a: true }, updatedAt: 1 },
  installedVersion: '0.0.8',
};

const STATUS: UpdateStatus = {
  mode: 'immediate',
  feed: 'tango',
  feedUrl: 'https://tango.example/rj/',
  state: 'idle',
  current: '0.0.8',
  available: null,
  message: null,
  lastCheckAt: null,
};

type Route = (init: RequestInit) => { status?: number; body: unknown };

/** A fetch stub answering `METHOD /path` routes; records every call. */
function stubFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (!route) return Promise.resolve(new Response('{}', { status: 404 }));
    const { status = 200, body } = route(init);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof stubFetch>, key: string) =>
  (fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]).filter(
    ([url, init]) => `${init?.method ?? 'GET'} ${url}` === key,
  );

function Harness({ initial }: { initial: ReleaseNotesReply }) {
  const [reply, setReply] = useState<ReleaseNotesReply | null>(initial);
  const run: Run = (p) => p;
  return <WhatsNewTab reply={reply} setReply={setReply} run={run} />;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.jukebox;
});

describe('WhatsNewTab checklist', () => {
  it('shows the version, changes and progress, and persists a tick via PATCH', async () => {
    const fetchMock = stubFetch({
      'GET /api/admin/update-status': () => ({ body: STATUS }),
      'PATCH /api/admin/checklist': (init) => ({
        body: {
          version: '0.0.8',
          done: { a: true, ...JSON.parse(init.body as string).done },
          updatedAt: 2,
        },
      }),
    });
    render(<Harness initial={REPLY} />);

    expect(screen.getByRole('heading', { name: T.title('0.0.8') })).toBeInTheDocument();
    expect(screen.getByText(T.released('2026-10-14'))).toBeInTheDocument();
    expect(screen.getByText('TV update notice')).toBeInTheDocument();
    expect(screen.getByTestId('checklist-progress')).toHaveTextContent(T.progress(1, 3));
    expect(screen.getByRole('checkbox', { name: 'First check' })).toBeChecked();

    const second = screen.getByRole('checkbox', { name: 'Second check' });
    fireEvent.click(second);
    // Optimistic: ticked before the hub answers.
    expect(second).toBeChecked();
    expect(screen.getByTestId('checklist-progress')).toHaveTextContent(T.progress(2, 3));

    await waitFor(() => expect(callsTo(fetchMock, 'PATCH /api/admin/checklist')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'PATCH /api/admin/checklist')[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ version: '0.0.8', done: { b: true } });

    fireEvent.click(screen.getByRole('checkbox', { name: 'First check' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH /api/admin/checklist')).toHaveLength(2));
    const [, untick] = callsTo(fetchMock, 'PATCH /api/admin/checklist')[1]!;
    expect(JSON.parse(untick!.body as string)).toEqual({ version: '0.0.8', done: { a: false } });
  });

  it('undoes the tick when the hub refuses it', async () => {
    stubFetch({
      'GET /api/admin/update-status': () => ({ body: STATUS }),
      'PATCH /api/admin/checklist': () => ({
        status: 409,
        body: { error: { code: 'version-mismatch', message: 'Reload' } },
      }),
    });
    render(<Harness initial={REPLY} />);
    const third = screen.getByRole('checkbox', { name: 'Third check' });
    fireEvent.click(third);
    expect(third).toBeChecked();
    await waitFor(() => expect(third).not.toBeChecked());
  });
});

describe('WhatsNewTab updates card', () => {
  it('shows the status and POSTs the chosen mode', async () => {
    const fetchMock = stubFetch({
      'GET /api/admin/update-status': () => ({ body: STATUS }),
      'POST /api/admin/update/mode': (init) => ({
        body: { ...STATUS, mode: JSON.parse(init.body as string).mode },
      }),
    });
    render(<Harness initial={REPLY} />);
    await screen.findByText(T.current('0.0.8'));
    expect(screen.getByTestId('feed-url')).toHaveTextContent('https://tango.example/rj/');
    expect(screen.getByRole('radio', { name: T.feeds.tango })).toBeChecked();
    expect(screen.getByRole('radio', { name: T.modes.immediate })).toBeChecked();
    expect(screen.getByRole('button', { name: T.installNow })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: T.modes.quiet }));
    await waitFor(() => expect(screen.getByRole('radio', { name: T.modes.quiet })).toBeChecked());
    const [, init] = callsTo(fetchMock, 'POST /api/admin/update/mode')[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ mode: 'quiet' });
  });

  it('Check now shows the returned status and polling picks up later changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current: UpdateStatus = STATUS;
    const fetchMock = stubFetch({
      'GET /api/admin/update-status': () => ({ body: current }),
      'POST /api/admin/update/check': () => {
        current = { ...STATUS, state: 'checking', lastCheckAt: Date.UTC(2026, 9, 14, 18) };
        return { body: current };
      },
      'POST /api/admin/update/install': () => ({ body: { ...current, state: 'installing' } }),
    });
    render(<Harness initial={REPLY} />);
    await screen.findByText(T.neverChecked);
    expect(screen.getByTestId('update-state')).toHaveTextContent(T.states.idle);

    fireEvent.click(screen.getByRole('button', { name: T.checkNow }));
    await waitFor(() =>
      expect(screen.getByTestId('update-state')).toHaveTextContent(T.states.checking),
    );
    expect(callsTo(fetchMock, 'POST /api/admin/update/check')).toHaveLength(1);
    expect(screen.queryByText(T.neverChecked)).not.toBeInTheDocument();

    current = { ...current, state: 'downloaded', available: '0.0.9' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
    });
    await waitFor(() =>
      expect(screen.getByTestId('update-state')).toHaveTextContent(T.states.downloaded('0.0.9')),
    );

    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(screen.getByRole('button', { name: T.installNow }));
    expect(confirm).toHaveBeenCalledWith(T.installConfirm);
    await waitFor(() =>
      expect(screen.getByTestId('update-state')).toHaveTextContent(T.states.installing),
    );
  });

  it('shows the updater error message', async () => {
    stubFetch({
      'GET /api/admin/update-status': () => ({
        body: { ...STATUS, state: 'error', message: 'Signature check failed' },
      }),
    });
    render(<Harness initial={REPLY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Signature check failed');
  });
});

describe('Admin tabs', () => {
  beforeEach(() => {
    window.jukebox = { adminToken: () => 'desktop-token' };
  });

  const renderAdmin = (reply: ReleaseNotesReply) => {
    stubFetch({
      'GET /api/admin/release-notes': () => ({ body: reply }),
      'GET /api/admin/update-status': () => ({ body: STATUS }),
    });
    render(
      <MemoryRouter>
        <Admin />
      </MemoryRouter>,
    );
  };

  it('puts What’s new first, opens it and badges the unverified count', async () => {
    renderAdmin(REPLY);
    const badge = await screen.findByTestId('whats-new-badge');
    expect(badge).toHaveTextContent('2');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const tabs = within(nav).getAllByRole('button');
    expect(tabs[0]).toHaveTextContent(S.admin.tabs.whatsNew);
    expect(tabs[0]).toHaveAttribute('aria-current', 'page');
    expect(tabs[0]).toHaveAccessibleName(`${S.admin.tabs.whatsNew}, ${S.admin.unverified(2)}`);
  });

  it('keeps the usual order without a badge when everything is verified', async () => {
    renderAdmin({
      ...REPLY,
      checklist: { version: '0.0.8', done: { a: true, b: true, c: true }, updatedAt: 3 },
    });
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    await waitFor(() => expect(within(nav).getAllByRole('button')).toHaveLength(6));
    const tabs = within(nav).getAllByRole('button');
    expect(tabs[0]).toHaveTextContent(S.admin.tabs.now);
    expect(tabs.at(-1)).toHaveTextContent(S.admin.tabs.whatsNew);
    expect(screen.queryByTestId('whats-new-badge')).not.toBeInTheDocument();
  });

  it('ignores ticks stored for another version', async () => {
    renderAdmin({
      ...REPLY,
      checklist: { version: '0.0.7', done: { a: true, b: true, c: true }, updatedAt: 3 },
    });
    expect(await screen.findByTestId('whats-new-badge')).toHaveTextContent('3');
  });
});
