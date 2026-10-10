import type { SearchReply } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    // Playable rows are one big button; the greyed row is not a button at all.
    expect(within(rows[0]!).getByRole('button')).toHaveTextContent('Good one');
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(rows[1]!.querySelector('[aria-disabled="true"]')).not.toBeNull();
    fireEvent.click(within(rows[1]!).getByText('Blocked one'));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(rows[0]!).getByRole('button'));
    expect(onPick).toHaveBeenCalledWith(reply.results[0]);
    // `remaining` only shows when search is low.
    expect(screen.queryByText(S.search.remaining(3), { exact: false })).toBeNull();
  });

  it('shows the low banner', () => {
    render(
      <SearchBox
        search={{ enabled: true, remaining: 1, low: true }}
        runSearch={ok}
        onPick={() => undefined}
      />,
    );
    expect(screen.getByText(S.search.low, { exact: false })).toHaveTextContent(
      S.search.remaining(1),
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', S.search.placeholder);
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

  it.each([
    [429, 'search-budget', S.search.resting, true],
    [429, 'daily-quota', S.search.resting, true],
    [503, 'search-disabled', S.search.resting, true],
    [502, 'youtube-unavailable', S.search.youtubeDown, false],
  ])('maps %i %s to plain words', async (status, code, text, resting) => {
    const run = () =>
      Promise.resolve<ApiResult<SearchReply>>({
        ok: false,
        error: { status, code, message: 'x' },
      });
    const onViewChange = vi.fn();
    render(
      <SearchBox
        search={{ enabled: true, remaining: 2, low: false }}
        runSearch={run}
        onPick={() => undefined}
        onViewChange={onViewChange}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'q' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(onViewChange).toHaveBeenLastCalledWith({ showingResults: false, resting });
  });

  it('notes the unofficial provider in one quiet line', async () => {
    render(
      <SearchBox
        search={{ enabled: true, remaining: null, low: false, provider: 'youtube-api' }}
        runSearch={() =>
          Promise.resolve({ ok: true, status: 200, data: { ...reply, provider: 'unofficial' } })
        }
        onPick={() => undefined}
      />,
    );
    expect(screen.queryByTestId('search-provider-note')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'q' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByTestId('search-provider-note')).toHaveTextContent(
      S.search.unofficial,
    );
  });

  it('shows the provider note before any search when the server says so', () => {
    render(
      <SearchBox
        search={{ enabled: true, remaining: null, low: false, provider: 'unofficial' }}
        runSearch={ok}
        onPick={() => undefined}
      />,
    );
    expect(screen.getByTestId('search-provider-note')).toBeInTheDocument();
  });
});
