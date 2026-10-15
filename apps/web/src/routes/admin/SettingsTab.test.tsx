import type { AdminState } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../strings.ts';
import type { Run } from './common.ts';
import { FriendlyForm, SearchSourceForm, WifiForm } from './SettingsTab.tsx';

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

describe('FriendlyForm', () => {
  afterEach(() => vi.unstubAllGlobals());

  const lanReply = (friendly: object) => ({
    addresses: [],
    chosen: '192.168.1.20',
    lanUrl: 'http://192.168.1.20:8080/',
    friendly,
  });

  const renderForm = (friendly: object) => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(init?.method === 'PATCH' ? {} : lanReply(friendly)), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const run: Run = (p) => p;
    render(
      <FriendlyForm
        state={{ settings: {} } as unknown as AdminState}
        run={run}
        push={() => undefined}
        serverNow={Date.now}
      />,
    );
    return fetchMock;
  };

  it('saves the host in the settings PATCH body', async () => {
    const fetchMock = renderForm({
      host: null,
      resolvesTo: [],
      ok: false,
      checkedAt: null,
      hint: null,
    });
    const field = await screen.findByLabelText(S.admin.friendlyHost);
    expect(screen.getByRole('button', { name: S.app.save })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'jukebox.home' } });
    fireEvent.click(screen.getByRole('button', { name: S.app.save }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')!;
    expect(patch[0]).toBe('/api/admin/settings');
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ friendlyHost: 'jukebox.home' });
  });

  it('shows the success line when the name points at this laptop', async () => {
    renderForm({
      host: 'jukebox.home',
      resolvesTo: ['192.168.1.20'],
      ok: true,
      checkedAt: 1,
      hint: null,
    });
    expect(await screen.findByText(S.admin.friendlyOk('jukebox.home'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: S.admin.friendlyCopy })).toBeNull();
  });

  it('shows the hint with a copy button for the record line when it does not', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const hint =
      'Add a DNS record on the UDM: jukebox.home → 192.168.1.20 (UniFi Network → Settings → Routing → DNS → Create New DNS Record, type A)';
    renderForm({ host: 'jukebox.home', resolvesTo: [], ok: false, checkedAt: 1, hint });
    expect(await screen.findByText(hint)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: S.admin.friendlyCopy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('jukebox.home → 192.168.1.20'));
  });
});
