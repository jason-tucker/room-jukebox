import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { S } from '../strings.ts';
import { ResolveSheet } from './ResolveSheet.tsx';

const base = {
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  durationSec: 213,
  channelTitle: 'Rick Astley',
};

describe('ResolveSheet', () => {
  it('shows the song and confirms a playable video', () => {
    const onConfirm = vi.fn();
    render(
      <ResolveSheet
        video={{ ...base, playable: true }}
        onConfirm={onConfirm}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog', { name: S.sheet.title })).toBeInTheDocument();
    expect(screen.getByText(base.title)).toBeInTheDocument();
    expect(screen.getByText('3:33')).toBeInTheDocument();
    expect(screen.getByText(S.sheet.playable)).toBeInTheDocument();
    expect(screen.getByTestId('yt-attribution')).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    fireEvent.click(screen.getByRole('button', { name: S.sheet.confirm }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('greys an unplayable video with its plain-words reason and disables confirm', () => {
    render(
      <ResolveSheet
        video={{ ...base, playable: false, reason: 'too-long', source: 'owner' }}
        onConfirm={() => undefined}
        onClose={() => undefined}
        ctx={{ maxDurationSec: 480 }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Longer than this room's 8-minute limit, set by the owner.",
    );
    expect(screen.getByRole('button', { name: S.sheet.confirm })).toBeDisabled();
  });

  it('names YouTube as the source of a YouTube refusal and shows request errors', () => {
    render(
      <ResolveSheet
        video={{ ...base, playable: false, reason: 'age-restricted', source: 'youtube' }}
        error="You already have 5 songs waiting."
        onConfirm={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(S.reasons['age-restricted'])).toBeInTheDocument();
    expect(screen.getByText('You already have 5 songs waiting.')).toBeInTheDocument();
  });

  it('closes on Cancel', () => {
    const onClose = vi.fn();
    render(
      <ResolveSheet
        video={{ ...base, playable: true }}
        onConfirm={() => undefined}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: S.app.cancel }));
    expect(onClose).toHaveBeenCalled();
  });
});
