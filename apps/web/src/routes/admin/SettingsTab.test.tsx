import type { AdminState } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';
import { SearchFallback } from './SettingsTab.tsx';

describe('SearchFallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the flipped switch in the PATCH body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const state = { settings: { search: { unofficialFallback: false } } } as unknown as AdminState;
    const run: Run = (p) => p;
    render(<SearchFallback state={state} run={run} push={() => undefined} serverNow={Date.now} />);

    const sw = screen.getByRole('switch', { name: S.admin.unofficialFallback });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: S.app.save }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ search: { unofficialFallback: true } });
  });
});
