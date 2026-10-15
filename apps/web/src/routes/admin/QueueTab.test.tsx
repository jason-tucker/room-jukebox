import type { AdminState } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';
import { QueueTab } from './QueueTab.tsx';

const entry = {
  id: 'e1',
  videoId: 'v1',
  title: 'Song One',
  requesterName: 'Sam',
  requesterGuestId: null,
  source: 'request',
  status: 'queued',
  enqueuedAt: 1,
};

function setup() {
  const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
  const state = { queue: [entry], recentHistory: [] } as unknown as AdminState;
  const run: Run = (p) => p;
  render(<QueueTab state={state} run={run} push={() => undefined} serverNow={Date.now} />);
  return fetchMock;
}

const deletes = (m: ReturnType<typeof setup>) =>
  (m.mock.calls as unknown as [string, RequestInit | undefined][]).filter(
    ([, init]) => init?.method === 'DELETE',
  );

describe('QueueTab remove', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a labelled Remove button on the row', () => {
    setup();
    const b = screen.getByRole('button', { name: `${S.app.remove}: Song One` });
    expect(within(b).getByText(S.app.remove)).toBeInTheDocument();
  });

  it('removes the entry when confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const m = setup();
    fireEvent.click(screen.getByRole('button', { name: `${S.app.remove}: Song One` }));
    await waitFor(() => expect(deletes(m)).toHaveLength(1));
    expect(deletes(m)[0]![0]).toBe('/api/admin/queue/e1');
  });

  it('does nothing when the confirm is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const m = setup();
    fireEvent.click(screen.getByRole('button', { name: `${S.app.remove}: Song One` }));
    expect(deletes(m)).toHaveLength(0);
  });
});
