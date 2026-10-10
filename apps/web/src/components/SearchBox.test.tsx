import type { SearchReply } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../lib/api.ts';
import { S } from '../strings.ts';
import { SearchBox } from './SearchBox.tsx';

const reply: SearchReply = {
  remaining: 3,
  cached: false,
  results: [
    {
      videoId: 'aaaaaaaaaaa',
      title: 'Good one',
      channelTitle: 'Ch',
      thumbnail: 't',
      playable: true,
    },
    {
      videoId: 'bbbbbbbbbbb',
      title: 'Blocked one',
      channelTitle: 'Ch',
      thumbnail: 't',
      playable: false,
      reason: 'not-embeddable',
      source: 'youtube',
    },
    { videoId: 'ccccccccccc', title: 'Third', channelTitle: 'Ch', thumbnail: 't', playable: true },
  ],
};
const ok = (): Promise<ApiResult<SearchReply>> =>
  Promise.resolve({ ok: true, status: 200, data: reply });

describe('SearchBox', () => {
  it('renders nothing when search is disabled', () => {
    const { container } = render(
      <SearchBox
        search={{ enabled: false, remaining: null, low: false }}
        runSearch={ok}
        onPick={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is submit-only and keeps the server order with unplayable rows greyed', async () => {
    const run = vi.fn(ok);
    const onPick = vi.fn();
    render(
      <SearchBox
        search={{ enabled: true, remaining: 5, low: false }}
        runSearch={run}
        onPick={onPick}
      />,
    );
    expect(screen.queryByText(S.search.low)).toBeNull();
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'queen' } });
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: S.search.submit }));
    await waitFor(() => expect(screen.getAllByTestId('search-row')).toHaveLength(3));
    expect(run).toHaveBeenCalledWith('queen');
    const rows = screen.getAllByTestId('search-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Good one'),
      expect.stringContaining('Blocked one'),
      expect.stringContaining('Third'),
    ]);
    expect(rows[1]).toHaveTextContent(S.reasons['not-embeddable']);
    expect(screen.getByRole('button', { name: `${S.search.add}: Blocked one` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: `${S.search.add}: Good one` }));
    expect(onPick).toHaveBeenCalledWith(reply.results[0]);
    expect(screen.getByText(S.search.remaining(3))).toBeInTheDocument();
  });

  it('shows the low banner', () => {
    render(
      <SearchBox
        search={{ enabled: true, remaining: 1, low: true }}
        runSearch={ok}
        onPick={() => undefined}
      />,
    );
    expect(screen.getByText(S.search.low)).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });

  it('hides the box when nothing remains', () => {
    render(
      <SearchBox
        search={{ enabled: true, remaining: 0, low: true }}
        runSearch={ok}
        onPick={() => undefined}
      />,
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText(S.search.usedUp)).toBeInTheDocument();
  });

  it('shows a plain-words error on budget exhaustion', async () => {
    const run = () =>
      Promise.resolve<ApiResult<SearchReply>>({
        ok: false,
        error: { status: 429, code: 'search-budget', message: 'x' },
      });
    render(
      <SearchBox
        search={{ enabled: true, remaining: 2, low: false }}
        runSearch={run}
        onPick={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'q' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByText(S.errors['search-budget'])).toBeInTheDocument();
  });
});
