import { SettingsPatchSchema } from '@room-jukebox/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHub, setup } from './helpers.ts';
import type { TestHub } from './helpers.ts';

let hub: TestHub;

/** The hub's addresses in helpers.ts: 192.168.1.20 (Wi-Fi, chosen) and 172.20.0.1. */
function fakeDns(map: Record<string, string[]>) {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (host: string): Promise<string[]> => {
      calls.push(host);
      const r = map[host];
      if (!r) throw new Error('ENOTFOUND');
      return r;
    },
  };
}

describe('friendlyHost validation', () => {
  it('accepts bare lowercase hostnames and null', () => {
    for (const h of ['jukebox.home', 'a', 'my-box.lan', 'x1.y2.z3', null]) {
      expect(SettingsPatchSchema.safeParse({ friendlyHost: h }).success).toBe(true);
    }
  });
  it('rejects schemes, ports, uppercase, spaces, empty and long labels', () => {
    for (const h of [
      'http://jukebox.home',
      'jukebox.home:8080',
      'Jukebox.home',
      'juke box',
      '',
      'a..b',
      '.home',
      `${'a'.repeat(64)}.home`,
    ]) {
      expect(SettingsPatchSchema.safeParse({ friendlyHost: h }).success).toBe(false);
    }
  });
});

describe('friendly address check', () => {
  afterEach(async () => hub.close());
  const patch = (token: string, payload: object) =>
    hub.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  const lan = async (token: string) =>
    (
      await hub.app.inject({
        method: 'GET',
        url: '/api/admin/lan',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();

  it('is empty without a host and never looks anything up', async () => {
    const dns = fakeDns({});
    hub = await makeHub({ resolveHost: dns.resolve });
    const creds = await setup(hub.app);
    const r = await lan(creds.token);
    expect(r.friendly).toEqual({
      host: null,
      resolvesTo: [],
      ok: false,
      checkedAt: null,
      hint: null,
    });
    expect(dns.calls).toEqual([]);
    expect(hub.app.jukebox.session.toPlayerState(creds.playerId).qr.joinUrl).toBe(r.lanUrl);
  });

  it('ok when the name resolves to one of our addresses; joinUrl uses the friendly name', async () => {
    const dns = fakeDns({ 'jukebox.home': ['192.168.1.20'] });
    hub = await makeHub({ resolveHost: dns.resolve });
    const creds = await setup(hub.app);
    const res = await patch(creds.token, { friendlyHost: 'jukebox.home' });
    expect(res.statusCode).toBe(200);
    expect(res.json().friendlyHost).toBe('jukebox.home');
    expect(dns.calls).toEqual(['jukebox.home']); // immediate re-check on patch
    const r = await lan(creds.token);
    expect(r.friendly).toMatchObject({
      host: 'jukebox.home',
      resolvesTo: ['192.168.1.20'],
      ok: true,
      hint: null,
    });
    expect(r.friendly.checkedAt).toBe(hub.clock.now);
    const qr = hub.app.jukebox.session.toPlayerState(creds.playerId).qr;
    expect(qr.joinUrl).toBe('http://jukebox.home:8080/');
    expect(qr.lanUrl).toBe('http://192.168.1.20:8080/');
  });

  it('not ok with the UDM hint when the name does not resolve', async () => {
    const dns = fakeDns({});
    hub = await makeHub({ resolveHost: dns.resolve });
    const creds = await setup(hub.app);
    await patch(creds.token, { friendlyHost: 'jukebox.home' });
    const r = await lan(creds.token);
    expect(r.friendly.ok).toBe(false);
    expect(r.friendly.resolvesTo).toEqual([]);
    expect(r.friendly.hint).toBe(
      'Add a DNS record on the UDM: jukebox.home → 192.168.1.20 (UniFi Network → Settings → Routing → DNS → Create New DNS Record, type A)',
    );
    expect(hub.app.jukebox.session.toPlayerState(creds.playerId).qr.joinUrl).toBe(r.lanUrl);
  });

  it('not ok when the name resolves to another machine', async () => {
    const dns = fakeDns({ 'jukebox.home': ['192.168.1.99'] });
    hub = await makeHub({ resolveHost: dns.resolve });
    const creds = await setup(hub.app);
    await patch(creds.token, { friendlyHost: 'jukebox.home' });
    const r = await lan(creds.token);
    expect(r.friendly).toMatchObject({ ok: false, resolvesTo: ['192.168.1.99'] });
    expect(r.friendly.hint).toBe('Name resolves to 192.168.1.99, which is not this laptop');
    expect(hub.app.jukebox.session.toPlayerState(creds.playerId).qr.joinUrl).toBe(r.lanUrl);
  });

  it('re-checks on every patch of friendlyHost and clears with null', async () => {
    const dns = fakeDns({ 'a.home': ['192.168.1.20'], 'b.home': ['10.9.9.9'] });
    hub = await makeHub({ resolveHost: dns.resolve });
    const creds = await setup(hub.app);
    await patch(creds.token, { friendlyHost: 'a.home' });
    expect((await lan(creds.token)).friendly.ok).toBe(true);
    await patch(creds.token, { friendlyHost: 'b.home' });
    expect(dns.calls).toEqual(['a.home', 'b.home']);
    expect((await lan(creds.token)).friendly.ok).toBe(false);
    await patch(creds.token, { roomName: 'Other' }); // unrelated patch: no lookup
    expect(dns.calls).toHaveLength(2);
    await patch(creds.token, { friendlyHost: null });
    expect((await lan(creds.token)).friendly.host).toBeNull();
  });

  it('rejects an invalid host over HTTP', async () => {
    hub = await makeHub({ resolveHost: fakeDns({}).resolve });
    const creds = await setup(hub.app);
    expect((await patch(creds.token, { friendlyHost: 'http://x' })).statusCode).toBe(400);
  });
});
