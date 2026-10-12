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

  it('shows no provider note on the results-page path, and no low banner', async () => {
    render(
      <SearchBox
        search={{ enabled: true, remaining: null, low: true, provider: 'unofficial' }}
        runSearch={() =>
          Promise.resolve({ ok: true, status: 200, data: { ...reply, provider: 'unofficial' } })
        }
        onPick={() => undefined}
      />,
    );
    expect(screen.queryByText(S.search.low, { exact: false })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'q' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(screen.getAllByTestId('search-row')).toHaveLength(3));
    expect(screen.queryByTestId('search-provider-note')).toBeNull();
    expect(screen.queryByText(/public page/i)).toBeNull();
  });
});

describe('SearchBox suggestions', () => {
  const words = ['queen bohemian rhapsody', 'queen we will rock you', 'queens of the stone age'];

  function setup(suggest = vi.fn((_q: string, _s: AbortSignal) => Promise.resolve(words))) {
    const run = vi.fn(ok);
    render(
      <SearchBox
        search={{ enabled: true, remaining: null, low: false, provider: 'unofficial' }}
        runSearch={run}
        suggest={suggest}
        onPick={() => undefined}
      />,
    );
    return { run, suggest, box: screen.getByRole('searchbox') };
  }

  it('lists suggestions after a pause, YouTube style, and a tap searches it', async () => {
    const { run, suggest, box } = setup();
    fireEvent.change(box, { target: { value: 'q' } });
    fireEvent.change(box, { target: { value: 'qu' } });
    fireEvent.change(box, { target: { value: 'quee' } });
    expect(suggest).not.toHaveBeenCalled();
    const list = await screen.findByRole('listbox', { name: S.search.suggestions });
    // debounced: one request for the last text only
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[0]).toBe('quee');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(words);
    // typed part plain, completion bold, with a search icon
    expect(options[0]!.querySelector('b')).toHaveTextContent('n bohemian rhapsody');
    expect(options[0]!.querySelector('svg')).not.toBeNull();
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(options[1]!);
    expect(run).toHaveBeenCalledWith('queen we will rock you');
    expect(box).toHaveValue('queen we will rock you');
    expect(screen.queryByRole('listbox')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('search-row')).toHaveLength(3));
  });

  it('arrow keys move through the list and Enter searches the highlighted one', async () => {
    const { run, box } = setup();
    fireEvent.change(box, { target: { value: 'queen' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', options[1]!.id);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    // back on the typed text, then wrap to the last
    expect(box).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.submit(screen.getByRole('search'));
    expect(run).toHaveBeenCalledWith('queens of the stone age');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Enter without a highlight searches the typed text; Escape closes the list', async () => {
    const { run, box } = setup();
    fireEvent.change(box, { target: { value: 'queen live' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.submit(screen.getByRole('search'));
    expect(run).toHaveBeenCalledWith('queen live');
  });

  it('needs 2 characters, aborts stale requests and ignores late answers', async () => {
    let release: (v: string[]) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const suggest = vi.fn((q: string, signal: AbortSignal) => {
      signals.push(signal);
      return q === 'ab' ? new Promise<string[]>((r) => (release = r)) : Promise.resolve(['abc']);
    });
    const { box } = setup(suggest);
    fireEvent.change(box, { target: { value: 'a' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(suggest).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'ab' } });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(signals[0]?.aborted).toBe(true);
    const list = await screen.findByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['abc']);
    release(['stale']);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('a submit cancels a pending suggestion request', async () => {
    const { run, suggest, box } = setup();
    fireEvent.change(box, { target: { value: 'queen' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(run).toHaveBeenCalledWith('queen');
    await new Promise((r) => setTimeout(r, 300));
    expect(suggest).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
