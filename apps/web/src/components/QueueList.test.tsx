import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { entry } from '../test/fixtures.ts';
import { S } from '../strings.ts';
import { QueueList } from './QueueList.tsx';

describe('QueueList', () => {
  it('highlights the guest’s own requests and labels every requester', () => {
    render(
      <QueueList
        title="Up next"
        entries={[
          entry({ id: 'a', title: 'Song A', requesterName: 'Alex' }),
          entry({ id: 'b', title: 'Song B', requesterName: null, mine: true }),
          entry({ id: 'c', title: 'Song C', source: 'auto', requesterName: null }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId('queue-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Requested by Alex')).toBeInTheDocument();
    expect(rows[0]).not.toHaveAttribute('data-mine');
    expect(rows[1]).toHaveAttribute('data-mine', 'true');
    expect(within(rows[1]!).getByText(S.guest.yours)).toBeInTheDocument();
    expect(within(rows[2]!).getByText(S.guest.autoPick)).toBeInTheDocument();
    expect(screen.getAllByText(S.guest.yours)).toHaveLength(1);
    expect(screen.getByTestId('yt-attribution')).toBeInTheDocument();
  });

  it('shows the empty text without an attribution mark', () => {
    render(<QueueList title="Up next" entries={[]} empty="Nothing queued" />);
    expect(screen.getByText('Nothing queued')).toBeInTheDocument();
    expect(screen.queryByTestId('yt-attribution')).toBeNull();
  });
});
