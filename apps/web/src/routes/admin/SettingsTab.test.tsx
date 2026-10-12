import type { AdminState } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';
import { SearchSourceForm } from './SettingsTab.tsx';

describe('SearchSourceForm', () => {
  afterEach(() => vi.unstubAllGlobals());

  const renderForm = (settings: object) => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const state = { settings } as unknown as AdminState;
    const run: Run = (p) => p;
    render(
      <SearchSourceForm state={state} run={run} push={() => undefined} serverNow={Date.now} />,
    );
    return fetchMock;
  };

  it('defaults to the YouTube page with one help line per option', () => {
    renderForm({});
    const page = screen.getByRole('radio', { name: S.admin.searchSources.page.label });
    expect(page).toBeChecked();
    for (const v of ['page', 'api-first', 'api-only'] as const) {
      const radio = screen.getByRole('radio', { name: S.admin.searchSources[v].label });
      expect(radio).toHaveAccessibleDescription(S.admin.searchSources[v].hint);
    }
    expect(screen.getByRole('button', { name: S.app.save })).toBeDisabled();
  });

  it('sends the chosen source in the PATCH body', async () => {
    const fetchMock = renderForm({ search: { source: 'page' } });
    fireEvent.click(screen.getByRole('radio', { name: S.admin.searchSources['api-first'].label }));
    fireEvent.click(screen.getByRole('button', { name: S.app.save }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ search: { source: 'api-first' } });
  });
});
