import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/crypto.ts';
import { checkHouseholdSource, inCidr, normaliseIp } from '../src/auth/gate.ts';
import { signGuestCookie, verifyGuestCookie } from '../src/auth/guest-cookie.ts';
import { connectPlayer, connectWs, LOOPBACK, makeHub, setup } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const SUBNETS = ['192.168.1.20/24'];
const gate = (ip: string, headers: Record<string, string> = {}) =>
  checkHouseholdSource({ ip: normaliseIp(ip), headers, subnets: SUBNETS }).allowed;

describe('household source gate (unit)', () => {
  it('allows loopback, own subnet and the tailnet', () => {
    expect(gate('127.0.0.1')).toBe(true);
    expect(gate('127.4.5.6')).toBe(true);
    expect(gate('::1')).toBe(true);
    expect(gate('192.168.1.77')).toBe(true);
    expect(gate('100.64.0.1')).toBe(true);
    expect(gate('100.127.255.254')).toBe(true);
  });

  it('denies the Bot VPS peer, other subnets, link-local and ULA', () => {
    expect(gate('100.82.187.53')).toBe(false);
    expect(gate('192.168.5.10')).toBe(false);
    expect(gate('8.8.8.8')).toBe(false);
    expect(gate('169.254.1.1')).toBe(false);
    expect(gate('fe80::1')).toBe(false);
    expect(gate('fd00::1')).toBe(false);
    expect(gate('2001:db8::1')).toBe(false);
    expect(gate('')).toBe(false);
  });

  it('normalises ::ffff: addresses', () => {
    expect(normaliseIp('::ffff:192.168.1.30')).toBe('192.168.1.30');
    expect(normaliseIp('::FFFF:127.0.0.1')).toBe('127.0.0.1');
    expect(gate('::ffff:192.168.1.30')).toBe(true);
    expect(gate('::ffff:100.82.187.53')).toBe(false);
    expect(normaliseIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('denies every proxy header, even from loopback', () => {
    for (const h of ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'forwarded', 'via']) {
      expect(gate('127.0.0.1', { [h]: '1.2.3.4' })).toBe(false);
    }
  });

  it('inCidr handles masks', () => {
    expect(inCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(inCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });
});

describe('password and guest cookie', () => {
  it('hashes with scrypt N=16384 r=8 p=1 and a random salt', async () => {
    const a = await hashPassword('hunter22');
    const b = await hashPassword('hunter22');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('hunter22', a)).toBe(true);
    expect(await verifyPassword('hunter23', a)).toBe(false);
    expect(await verifyPassword('hunter22', 'garbage')).toBe(false);
  });

  it('signs guest cookies and rejects tampering', () => {
    const c = signGuestCookie('secret', { guestId: 'g1', iat: 5 });
    expect(verifyGuestCookie('secret', c)).toEqual({ guestId: 'g1', iat: 5 });
    expect(verifyGuestCookie('other', c)).toBeNull();
    const forged = signGuestCookie('secret', { guestId: 'g2', iat: 5 }).split('.')[0];
    expect(verifyGuestCookie('secret', `${forged}.${c.split('.')[1]}`)).toBeNull();
    expect(verifyGuestCookie('secret', undefined)).toBeNull();
  });
});

describe('auth gates (integration)', () => {
  let hub: TestHub;
  let token: string;
  beforeEach(async () => {
    hub = await makeHub();
    token = (await setup(hub.app)).token;
  });
  afterEach(async () => hub.close());

  const adminGet = (opts: { ip?: string; headers?: Record<string, string> } = {}) =>
    hub.app.inject({
      method: 'GET',
      url: '/api/admin/session',
      remoteAddress: opts.ip ?? LOOPBACK,
      headers: { authorization: `Bearer ${token}`, ...opts.headers },
    });

  it('loopback bearer works; no token is 401', async () => {
    expect((await adminGet()).statusCode).toBe(200);
    const res = await hub.app.inject({ method: 'GET', url: '/api/admin/session' });
    expect(res.statusCode).toBe(401);
  });

  it('admin with a proxy header or from the Bot VPS is 403 forbidden-source', async () => {
    for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'cf-ray', 'forwarded', 'via']) {
      const res = await adminGet({ headers: { [h]: '203.0.113.9' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden-source');
    }
    expect((await adminGet({ ip: '100.82.187.53' })).statusCode).toBe(403);
    expect((await adminGet({ ip: '::ffff:100.82.187.53' })).statusCode).toBe(403);
    expect((await adminGet({ ip: '192.168.9.9' })).statusCode).toBe(403);
    expect((await adminGet({ ip: 'fe80::2' })).statusCode).toBe(403);
  });

  it('::ffff: sources on the LAN are normalised and allowed', async () => {
    expect((await adminGet({ ip: '::ffff:192.168.1.30' })).statusCode).toBe(200);
    expect((await adminGet({ ip: '100.100.1.1' })).statusCode).toBe(200);
  });

  it('cookie login from a phone; cross-site cookie writes are refused', async () => {
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: '192.168.1.40',
      payload: { password: 'correct horse' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ ok: true });
    const c = login.cookies.find((x) => x.name === 'rj_admin');
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    const cookie = `rj_admin=${c?.value}`;
    const ok = await hub.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      remoteAddress: '192.168.1.40',
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    const crossSite = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/transport',
      remoteAddress: '192.168.1.40',
      headers: { cookie, origin: 'http://evil.example', host: '192.168.1.20:8080' },
      payload: { action: 'pause', idempotencyKey: 'k1' },
    });
    expect(crossSite.statusCode).toBe(403);
    const sameSite = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/transport',
      remoteAddress: '192.168.1.40',
      headers: { cookie, origin: 'http://192.168.1.20:8080', host: '192.168.1.20:8080' },
      payload: { action: 'pause', idempotencyKey: 'k2' },
    });
    expect(sameSite.statusCode).toBe(200);
  });

  it('desktop login returns a bearer token accepted on admin routes and logout', async () => {
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      headers: { 'x-client': 'desktop' },
      payload: { password: 'correct horse' },
    });
    const t = login.json().token as string;
    expect(t).toBeTruthy();
    expect(login.cookies).toHaveLength(0);
    const auth = { authorization: `Bearer ${t}` };
    expect((await hub.app.inject({ url: '/api/admin/searches', headers: auth })).statusCode).toBe(
      200,
    );
    expect(
      (await hub.app.inject({ method: 'POST', url: '/api/admin/logout', headers: auth }))
        .statusCode,
    ).toBe(200);
    expect((await hub.app.inject({ url: '/api/admin/searches', headers: auth })).statusCode).toBe(
      401,
    );
  });

  it('the 6th bad login is throttled with retryAfterSec', async () => {
    const attempt = () =>
      hub.app.inject({
        method: 'POST',
        url: '/api/admin/login',
        remoteAddress: '192.168.1.41',
        payload: { password: 'wrong password' },
      });
    for (let i = 0; i < 5; i++) {
      const r = await attempt();
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('bad-password');
    }
    const sixth = await attempt();
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('login-throttled');
    expect(sixth.json().error.retryAfterSec).toBeGreaterThan(0);
    // another source is not throttled by this one
    const other = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: '192.168.1.42',
      payload: { password: 'correct horse' },
    });
    expect(other.statusCode).toBe(200);
    hub.clock.advance(1100);
    expect((await attempt()).statusCode).toBe(401);
  });

  it('setup is 403 off-loopback and 409 once set up', async () => {
    const body = { password: 'abcdefgh', roomName: 'X', noticeAccepted: true };
    const lan = await hub.app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: '192.168.1.40',
      payload: body,
    });
    expect(lan.statusCode).toBe(403);
    const proxied = await hub.app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      payload: body,
    });
    expect(proxied.statusCode).toBe(403);
    const again = await hub.app.inject({ method: 'POST', url: '/api/setup', payload: body });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already-set-up');
    const status = await hub.app.inject({ url: '/api/setup/status' });
    expect(status.json()).toMatchObject({
      needsSetup: false,
      lan: { chosen: '192.168.1.20', lanUrl: 'http://192.168.1.20:8080/' },
    });
    expect(
      (await hub.app.inject({ url: '/api/setup/status', remoteAddress: '192.168.1.40' }))
        .statusCode,
    ).toBe(403);
  });

  it('the setup desktop token is long-lived; a password change invalidates every session', async () => {
    hub.clock.advance(13 * 60 * 60 * 1000);
    expect((await adminGet()).statusCode).toBe(200);
    const phone = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      headers: { 'x-client': 'desktop' },
      payload: { password: 'correct horse' },
    });
    const phoneToken = phone.json().token as string;
    hub.clock.advance(12 * 60 * 60 * 1000 + 1);
    expect(
      (
        await hub.app.inject({
          url: '/api/admin/session',
          headers: { authorization: `Bearer ${phoneToken}` },
        })
      ).statusCode,
    ).toBe(401);

    const change = await hub.app.inject({
      method: 'POST',
      url: '/api/admin/password',
      headers: { authorization: `Bearer ${token}`, 'x-client': 'desktop' },
      payload: { current: 'correct horse', next: 'battery staple' },
    });
    expect(change.statusCode).toBe(200);
    const fresh = change.json().token as string;
    expect((await adminGet()).statusCode).toBe(401);
    expect(
      (
        await hub.app.inject({
          url: '/api/admin/session',
          headers: { authorization: `Bearer ${fresh}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('healthz reports needsSetup', async () => {
    const res = await hub.app.inject({ url: '/healthz' });
    expect(res.json()).toMatchObject({ ok: true, protocolVersion: 2, needsSetup: false });
  });

  it('player and admin sockets need the gate and a token', async () => {
    const players = hub.app.jukebox.session.players();
    expect(players).toHaveLength(1);
    await expect(connectWs(hub.app, '/ws?role=player&token=nope')).rejects.toThrow(/401/);
    await expect(connectWs(hub.app, '/ws?role=admin')).rejects.toThrow(/401/);
    await expect(
      connectWs(hub.app, `/ws?role=admin&token=${token}`, { ip: '100.82.187.53' }),
    ).rejects.toThrow(/403/);
    await expect(
      connectWs(hub.app, `/ws?role=admin&token=${token}`, {
        headers: { 'x-forwarded-for': '1.1.1.1' },
      }),
    ).rejects.toThrow(/403/);
    const admin = await connectWs(hub.app, `/ws?role=admin&token=${token}`);
    const st = await admin.next('state');
    expect('settings' in st.state).toBe(true);
    admin.ws.terminate();
  });
});

describe('before setup', () => {
  it('healthz says needsSetup and login is refused', async () => {
    const hub = await makeHub();
    try {
      expect((await hub.app.inject({ url: '/healthz' })).json().needsSetup).toBe(true);
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { password: 'whatever1' },
      });
      expect(login.statusCode).toBe(409);
      expect((await hub.app.inject({ url: '/api/setup/status' })).json().needsSetup).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it('calls onSetupComplete with token, playerToken and playerId', async () => {
    const seen: unknown[] = [];
    const hub = await makeHub({ hooks: { onSetupComplete: (info) => void seen.push(info) } });
    try {
      const r = await setup(hub.app);
      expect(seen).toEqual([{ token: r.token, playerToken: r.playerToken, playerId: r.playerId }]);
      const c = await connectPlayer(hub.app, r.playerId, r.playerToken);
      const st = await c.next('state');
      expect(st.state).toMatchObject({ me: { playerId: r.playerId, role: 'leader' } });
      c.ws.terminate();
      // a re-issued token replaces the old one
      const fresh = hub.app.jukebox.issueLocalPlayerToken();
      expect(fresh.playerId).toBe(r.playerId);
      await expect(connectWs(hub.app, `/ws?role=player&token=${r.playerToken}`)).rejects.toThrow(
        /401/,
      );
    } finally {
      await hub.close();
    }
  });
});
