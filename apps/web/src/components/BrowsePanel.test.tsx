import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../strings.ts';
import { BROWSE_SRC, BrowsePanel, parsePick } from './BrowsePanel.tsx';

function frame(): HTMLIFrameElement {
  return screen.getByTitle(S.guest.browseFrameTitle) as HTMLIFrameElement;
}

/** A message as the mirror's injected script posts it from inside the frame. */
export function postFromFrame(data: unknown, source: Window | null = frame().contentWindow) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data, origin: window.location.origin, source }),
    );
  });
}

describe('parsePick', () => {
  it('accepts rj-pick with an 11-character ID and trims the title', () => {
    expect(parsePick({ type: 'rj-pick', videoId: 'OPf0YbXqDm0', title: ' Funk ' })).toEqual({
      videoId: 'OPf0YbXqDm0',
      title: 'Funk',
    });
    expect(parsePick({ type: 'rj-pick', videoId: 'OPf0YbXqDm0' })).toEqual({
      videoId: 'OPf0YbXqDm0',
      title: '',
    });
  });
  it('rejects anything else', () => {
    for (const d of [
      null,
      'x',
      { type: 'other', videoId: 'OPf0YbXqDm0' },
      { type: 'rj-pick', videoId: 'short' },
    ]) {
      expect(parsePick(d)).toBeNull();
    }
  });
});

describe('BrowsePanel', () => {
  afterEach(() => vi.useRealTimers());

  const renderPanel = (over: Partial<Parameters<typeof BrowsePanel>[0]> = {}) => {
    const props = { title: 'Basement', onDone: vi.fn(), onPick: vi.fn(), onFail: vi.fn(), ...over };
    render(<BrowsePanel {...props} />);
    return props;
  };

  it('opens YouTube through the mirror in a sandboxed same-origin frame under a Done bar', () => {
    const p = renderPanel();
    expect(frame().getAttribute('src')).toBe(BROWSE_SRC);
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(screen.getByText('Basement')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: S.guest.browseDone }));
    expect(p.onDone).toHaveBeenCalledOnce();
  });

  it('passes rj-pick messages from its frame to onPick, ignores other windows', () => {
    const p = renderPanel();
    postFromFrame({ type: 'rj-pick', videoId: 'OPf0YbXqDm0', title: 'Uptown Funk' });
    expect(p.onPick).toHaveBeenCalledWith('OPf0YbXqDm0', 'Uptown Funk');
    postFromFrame({ type: 'rj-pick', videoId: 'aaaaaaaaaaa', title: 'x' }, window);
    postFromFrame({ type: 'nope' });
    expect(p.onPick).toHaveBeenCalledOnce();
  });

  it('gives up when the frame does not load in time', () => {
    vi.useFakeTimers();
    const p = renderPanel({ timeoutMs: 8000 });
    act(() => vi.advanceTimersByTime(7999));
    expect(p.onFail).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2));
    expect(p.onFail).toHaveBeenCalledOnce();
  });

  it('fails on the mirror error page', () => {
    const bad = renderPanel();
    const doc = frame().contentDocument as Document;
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'rj-mirror-error');
    if (!doc.documentElement) doc.append(doc.createElement('html'));
    doc.documentElement.append(meta);
    fireEvent.load(frame());
    expect(bad.onFail).toHaveBeenCalledOnce();
  });

  it('a mirrored page (the injected script ran) counts as loaded: no timeout later', () => {
    vi.useFakeTimers();
    const p = renderPanel();
    (frame().contentWindow as Window & { __rjMirror?: boolean }).__rjMirror = true;
    fireEvent.load(frame());
    act(() => vi.advanceTimersByTime(10_000));
    expect(p.onFail).not.toHaveBeenCalled();
  });
});
