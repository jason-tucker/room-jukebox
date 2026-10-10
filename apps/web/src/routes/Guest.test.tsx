import type { GuestState, SearchReply } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api.ts';
import { S } from '../strings.ts';
import { entry, guestState } from '../test/fixtures.ts';
import { Guest } from './Guest.tsx';

const h = vi.hoisted(() => ({
  state: null as GuestState | null,
  search: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../lib/ws.ts', () => ({
  useSessionState: () => ({ state: h.state, status: 'online', client: null }),
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
        search: h.search,
        request: h.request,
      },
    },
  };
});

const reply: SearchReply = {
  remaining: 4,
  cached: false,
  provider: 'youtube-api',
  results: [
    {
      videoId: 'OPf0YbXqDm0',
      title: 'Uptown Funk',
      channelTitle: 'Mark Ronson',
      thumbnail: 't',
      durationSec: 270,
      playable: true,
    },
    {
      videoId: 'bbbbbbbbbbb',
      title: 'Blocked one',
      channelTitle: 'Ch',
      thumbnail: 't',
      playable: false,
      reason: 'age-restricted',
      source: 'youtube',
    },
  ],
};

const searchOn: GuestState['search'] = { enabled: true, remaining: 5, low: false };

/** Document order of the page's main blocks. */
function order(): string[] {
  const ids = ['search-box', 'paste-section', 'now-playing', 'now-playing-bar'];
  return [...document.querySelectorAll('[data-testid]')]
    .map((el) => el.getAttribute('data-testid') ?? '')
    .filter((id) => ids.includes(id));
}

function renderGuest() {
  return render(
    <MemoryRouter>
      <Guest />
    </MemoryRouter>,
  );
}

async function search(q: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: S.search.submit }));
}

describe('Guest page', () => {
  beforeEach(() => {
    h.search.mockReset();
    h.request.mockReset();
    h.state = guestState({ search: searchOn, queue: [entry({ mine: true })] });
  });

  it('puts the search box first and the paste flow under Now Playing', async () => {
    renderGuest();
    expect(await screen.findByRole('searchbox')).toHaveAttribute(
      'placeholder',
      'Search YouTube for a song',
    );
    expect(order()).toEqual(['search-box', 'now-playing', 'paste-section']);
    expect(screen.getByRole('heading', { name: S.guest.pasteTitle })).toBeInTheDocument();
    expect(screen.queryByText(S.guest.searchOff)).toBeNull();
  });

  it('leads with the paste flow when search is off', async () => {
    h.state = guestState({ search: { enabled: false, remaining: null, low: false } });
    renderGuest();
    expect(await screen.findByText(S.guest.searchOff)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(order()).toEqual(['paste-section', 'now-playing']);
  });

  it('tap a result, confirm in the sheet, results stay for the next pick', async () => {
    h.search.mockResolvedValue({ ok: true, status: 200, data: reply });
    h.request.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        entry: entry({ id: 'e2', videoId: 'OPf0YbXqDm0', title: 'Uptown Funk' }),
        duplicate: false,
      },
    });
    renderGuest();
    await screen.findByRole('searchbox');
    await search('uptown');
    const rows = await screen.findAllByTestId('search-row');
    expect(h.search).toHaveBeenCalledWith('uptown');
    // While results show, Now Playing folds into the sticky bar between results and paste.
    expect(order()).toEqual(['search-box', 'now-playing-bar', 'paste-section']);
    expect(screen.getByTestId('now-playing-bar')).toHaveTextContent('Now playing: nothing yet');

    // The greyed row is not tappable.
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    fireEvent.click(within(rows[1]!).getByText('Blocked one'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(rows[0]!).getByRole('button'));
    const sheet = await screen.findByRole('dialog', { name: S.sheet.title });
    expect(sheet).toHaveTextContent('Uptown Funk');
    expect(sheet).toHaveTextContent(S.sheet.playable);
    fireEvent.click(within(sheet).getByRole('button', { name: S.sheet.confirm }));
    expect(await screen.findByText('Added: Uptown Funk')).toBeInTheDocument();
    expect(h.request).toHaveBeenCalledWith({
      videoId: 'OPf0YbXqDm0',
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByTestId('search-row')).toHaveLength(2);

    // The bar opens the full Now Playing card and the queue again.
    fireEvent.click(screen.getByTestId('now-playing-bar'));
    expect(order()).toEqual(['search-box', 'now-playing', 'paste-section']);
    expect(screen.getByText(S.guest.yours)).toBeInTheDocument();
  });

  it('raises the paste flow right under the box when search is resting', async () => {
    h.search.mockResolvedValue({
      ok: false,
      error: { status: 429, code: 'daily-quota', message: 'x' },
    });
    renderGuest();
    await screen.findByRole('searchbox');
    await search('anything');
    expect(await screen.findByText(S.search.resting)).toBeInTheDocument();
    expect(order()).toEqual(['search-box', 'paste-section', 'now-playing']);
    expect(screen.getByRole('button', { name: S.guest.paste })).toBeVisible();
  });
});
