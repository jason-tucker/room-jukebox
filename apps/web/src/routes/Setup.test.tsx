import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeardHub, JukeboxBridge, PairResult } from '../lib/jukebox.ts';
import { S } from '../strings.ts';
import { stubFetch } from '../test/stubFetch.ts';
import { Setup } from './Setup.tsx';

const STATUS = {
  needsSetup: true,
  lan: {
    addresses: [{ interface: 'Wi-Fi', address: '192.168.1.31', cidr: '192.168.1.0/24' }],
    chosen: '192.168.1.31',
    lanUrl: 'http://192.168.1.31:8080/',
    friendly: { host: null, resolvesTo: [], ok: false, checkedAt: null, hint: null },
  },
};

const BASEMENT: HeardHub = {
  hubId: 'hub1',
  roomName: 'Basement',
  address: '192.168.1.20',
  port: 8080,
};

function installBridge(heard: HeardHub[], result: PairResult = { ok: true }) {
  const pair = vi.fn<NonNullable<JukeboxBridge['pair']>>(() => Promise.resolve(result));
  let emit: ((h: HeardHub[]) => void) | null = null;
  window.jukebox = {
    pair,
    hubs: () => [],
    onHubs: (cb) => {
      emit = cb;
      return () => undefined;
    },
  };
  return { pair, hear: () => emit?.(heard) };
}

function renderSetup() {
  return render(
    <MemoryRouter>
      <Setup />
    </MemoryRouter>,
  );
}

async function accept() {
  fireEvent.click(await screen.findByRole('checkbox', { name: S.setup.accept }));
}

describe('Setup wizard, Player path', () => {
  beforeEach(() => {
    stubFetch({ 'GET /api/setup/status': () => ({ body: STATUS }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.jukebox;
  });

  it('defaults to Join <room> when a hub is heard and pairs with it', async () => {
    const b = installBridge([BASEMENT]);
    renderSetup();
    await accept();
    // Before any beacon the hub path is the default.
    expect(screen.getByRole('radio', { name: new RegExp(S.setup.newHub) })).toBeChecked();
    act(() => b.hear());
    const join = await screen.findByRole('radio', {
      name: new RegExp(S.setup.joinHub('Basement')),
    });
    expect(join).toBeChecked();

    // A separate hub needs confirmation; declining keeps Join.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(S.setup.separateHub) }));
    expect(confirm).toHaveBeenCalledWith(S.setup.separateConfirm('Basement'));
    expect(join).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: S.app.next }));
    expect(screen.getByRole('heading', { name: S.setup.joinTitle })).toBeInTheDocument();
    expect(screen.getByText(S.setup.stepOf(2, 2))).toBeInTheDocument();
    // A hub is heard: no address field.
    expect(screen.queryByLabelText(S.setup.hubAddress)).toBeNull();
    const joinButton = screen.getByRole('button', { name: S.setup.joinButton });
    expect(joinButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(S.setup.ownerPassword), {
      target: { value: 'jukebox1' },
    });
    fireEvent.change(screen.getByLabelText(S.setup.thisRoom), { target: { value: ' Den ' } });
    fireEvent.click(joinButton);
    expect(await screen.findByText(S.setup.joinDone)).toBeInTheDocument();
    expect(b.pair).toHaveBeenCalledWith({
      hubAddress: 'http://192.168.1.20:8080',
      password: 'jukebox1',
      deviceName: 'Den',
    });
  });

  it('a confirmed separate hub continues with the hub wizard', async () => {
    const b = installBridge([BASEMENT]);
    renderSetup();
    await accept();
    act(() => b.hear());
    await screen.findByRole('radio', { name: new RegExp(S.setup.joinHub('Basement')) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(S.setup.separateHub) }));
    expect(screen.getByRole('radio', { name: new RegExp(S.setup.separateHub) })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: S.app.next }));
    expect(screen.getByRole('heading', { name: S.setup.password })).toBeInTheDocument();
    expect(b.pair).not.toHaveBeenCalled();
  });

  it('with no hub heard: asks for the address and shows pairing errors', async () => {
    const b = installBridge([], { ok: false, code: 'unreachable' });
    renderSetup();
    await accept();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(S.setup.joinAnother) }));
    fireEvent.click(screen.getByRole('button', { name: S.app.next }));
    expect(screen.getByText(S.setup.turnOn(null))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(S.setup.hubAddress), {
      target: { value: '192.168.1.50' },
    });
    fireEvent.change(screen.getByLabelText(S.setup.ownerPassword), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText(S.setup.thisRoom), { target: { value: 'Den' } });
    fireEvent.click(screen.getByRole('button', { name: S.setup.joinButton }));
    expect(await screen.findByRole('alert')).toHaveTextContent(S.setup.pairErrors.unreachable);
    expect(b.pair).toHaveBeenCalledWith({
      hubAddress: 'http://192.168.1.50:8080',
      password: 'pw',
      deviceName: 'Den',
    });

    b.pair.mockResolvedValueOnce({ ok: false, code: 'bad-password' });
    fireEvent.click(screen.getByRole('button', { name: S.setup.joinButton }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(S.setup.pairErrors['bad-password']),
    );
    b.pair.mockResolvedValueOnce({ ok: false, code: 'bad-proof' });
    fireEvent.click(screen.getByRole('button', { name: S.setup.joinButton }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(S.setup.pairErrors['bad-proof']),
    );
    expect(screen.queryByText(S.setup.joinDone)).toBeNull();
  });

  it('without the desktop bridge the wizard has no role choice', async () => {
    renderSetup();
    await accept();
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.app.next }));
    expect(screen.getByRole('heading', { name: S.setup.password })).toBeInTheDocument();
  });
});
