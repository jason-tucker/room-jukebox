import type { AdminState } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';
import { SearchSourceForm, WifiForm } from './SettingsTab.tsx';

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
    expect(JSON.parse(init.body as string)).toEqual({
      search: { source: 'api-first', mirror: true },
    });
  });

  it('turns embedded YouTube browsing off', async () => {
    const fetchMock = renderForm({ search: { source: 'page', mirror: true } });
    const box = screen.getByRole('checkbox', { name: S.admin.searchMirror.label });
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: S.app.save }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ search: { source: 'page', mirror: false } });
  });
});

describe('WifiForm', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers the four security choices and sends SAE for WPA3 only', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const state = {
      settings: { wifi: { ssid: 'Net', security: 'WPA', hidden: false }, hasWifiPassword: true },
    } as unknown as AdminState;
    const run: Run = (p) => p;
    render(<WifiForm state={state} run={run} push={() => undefined} serverNow={Date.now} />);
    const select = screen.getByLabelText(S.admin.security) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual([
      'WPA2 / mixed (most networks)',
      'WPA3 only',
      'WEP (old)',
      'Open network, no password',
    ]);
    fireEvent.change(select, { target: { value: 'SAE' } });
    fireEvent.click(screen.getByRole('button', { name: S.app.save }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      wifi: { ssid: 'Net', security: 'SAE', hidden: false },
    });
  });
});
