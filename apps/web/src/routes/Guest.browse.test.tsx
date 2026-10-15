import type { GuestState } from '@room-jukebox/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api.ts';
import { KEYS } from '../lib/storage.ts';
import { S } from '../strings.ts';
import { guestState } from '../test/fixtures.ts';
import { Guest } from './Guest.tsx';

const h = vi.hoisted(() => ({
  state: null as GuestState | null,
  status: 'online',
  resolve: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../lib/ws.ts', () => ({
  useSessionState: () => ({ state: h.state, status: h.status, client: null }),
}));

vi.mock('../lib/api.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>();
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });
  return {
    ...real,
    api: {
      ...real.api,
      guest: {
        ...real.api.guest,
        hello: () => ok({ guestId: 'g1', name: null, noticeAccepted: true }),
        notice: () => ok({ ok: true }),
        resolve: h.resolve,
        request: h.request,
        search: vi.fn(),
        suggest: vi.fn(() => Promise.resolve(null)),
      },
    },
  };
});

const ID1 = 'OPf0YbXqDm0';
const ID2 = '5NV6Rdv1a3I';

function renderGuest() {
  return render(
    <MemoryRouter>
      <Guest />
    </MemoryRouter>,
  );
}

function pick(videoId: string, title: string) {
  const frame = screen.getByTitle(S.guest.browseFrameTitle) as HTMLIFrameElement;
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'rj-pick', videoId, title },
        origin: window.location.origin,
        source: frame.contentWindow,
      }),
    );
  });
}

function resolved(videoId: string, title: string) {
  return { ok: true, status: 200, data: { videoId, title, durationSec: 200, playable: true } };
}

describe('Guest page: Browse YouTube', () => {
  beforeEach(() => {
    h.status = 'online';
    h.resolve.mockReset();
    h.request.mockReset();
    h.state = guestState({ search: { enabled: true, remaining: 5, low: false } });
  });
  afterEach(() => vi.useRealTimers());

  it('shows Browse YouTube above the search box, and not when the owner turned it off', async () => {
    const { unmount } = renderGuest();
    const browse = await screen.findByRole('button', { name: S.guest.browse });
    const box = screen.getByRole('searchbox');
    expect(browse.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    h.state = guestState({ flags: { hasApiKey: false, publicMode: false, mirror: false } });
    renderGuest();
    await screen.findByText(S.guest.nowPlaying);
    expect(screen.queryByRole('button', { name: S.guest.browse })).toBeNull();
  });

  it('a pick opens the sheet with the title at once; Yes queues it and the panel stays for the next', async () => {
    let finish: (v: unknown) => void = () => undefined;
    h.resolve.mockReturnValueOnce(new Promise((r) => (finish = r)));
    h.request.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        duplicate: false,
        entry: {
          id: 'e9',
          videoId: ID1,
          title: 'Uptown Funk (Official)',
          durationSec: 270,
          requesterName: null,
          source: 'request',
          status: 'queued',
          enqueuedAt: 1,
          mine: true,
        },
      },
    });
    renderGuest();
    fireEvent.click(await screen.findByRole('button', { name: S.guest.browse }));
    expect(screen.getByTestId('browse-panel')).toBeInTheDocument();
    expect(window.localStorage.getItem(KEYS.browse)).toBe('1');

    pick(ID1, 'Uptown Funk');
    const sheet = await screen.findByRole('dialog', { name: S.sheet.title });
    expect(within(sheet).getByText('Uptown Funk')).toBeInTheDocument();
    expect(within(sheet).getByText(S.sheet.checking)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: S.sheet.confirm })).toBeDisabled();
    expect(h.resolve).toHaveBeenCalledWith(ID1);

    await act(async () => finish(resolved(ID1, 'Uptown Funk (Official)')));
    expect(within(sheet).getByText('Uptown Funk (Official)')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: S.sheet.confirm }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: S.sheet.title })).toBeNull());
    expect(h.request.mock.calls[0]?.[0]).toMatchObject({ videoId: ID1 });
    expect(await screen.findByText(S.guest.added('Uptown Funk (Official)'))).toBeInTheDocument();
    expect(screen.getByTestId('browse-panel')).toBeInTheDocument();

    // a second pick works the same way, no reload
    h.resolve.mockResolvedValueOnce(resolved(ID2, 'Get Lucky'));
    pick(ID2, 'Get Lucky');
    const again = await screen.findByRole('dialog', { name: S.sheet.title });
    await waitFor(() =>
      expect(within(again).getByRole('button', { name: S.sheet.confirm })).toBeEnabled(),
    );

    fireEvent.click(within(again).getByRole('button', { name: S.app.cancel }));
    fireEvent.click(screen.getByRole('button', { name: S.guest.browseDone }));
    expect(screen.queryByTestId('browse-panel')).toBeNull();
  });

  it('opens Browse directly when the guest used it last time', async () => {
    window.localStorage.setItem(KEYS.browse, '1');
    renderGuest();
    expect(await screen.findByTestId('browse-panel')).toBeInTheDocument();
  });

  it('falls back to the search box when YouTube does not load within 8 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderGuest();
    fireEvent.click(await screen.findByRole('button', { name: S.guest.browse }));
    expect(screen.getByTestId('browse-panel')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(8100));
    expect(screen.queryByTestId('browse-panel')).toBeNull();
    expect(screen.getAllByText(S.guest.browseFailed).length).toBeGreaterThan(0);
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(window.localStorage.getItem(KEYS.browse)).toBeNull();
  });
});
