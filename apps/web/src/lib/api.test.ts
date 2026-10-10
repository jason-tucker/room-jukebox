import { HelloReplySchema } from '@room-jukebox/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call } from './api.ts';
import { failureText } from './messages.ts';

function mockFetch(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

describe('api.call', () => {
  afterEach(() => {
    delete window.jukebox;
  });

  it('returns typed data and sends cookies', async () => {
    const f = mockFetch(200, { guestId: 'g', name: null, noticeAccepted: false });
    const r = await call('POST', '/api/guest/hello', { body: {}, schema: HelloReplySchema });
    expect(r).toEqual({
      ok: true,
      status: 200,
      data: { guestId: 'g', name: null, noticeAccepted: false },
    });
    expect(f.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: '{}',
    });
  });

  it('maps the ApiError envelope', async () => {
    mockFetch(429, { error: { code: 'cooldown', message: 'slow down', retryAfterSec: 4 } });
    const r = await call('POST', '/api/requests', { body: {} });
    expect(r).toEqual({
      ok: false,
      error: { status: 429, code: 'cooldown', message: 'slow down', retryAfterSec: 4 },
    });
    if (!r.ok) expect(failureText(r.error)).toBe('Wait 4 seconds before your next request.');
  });

  it('reports network failures and malformed replies', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const r1 = await call('GET', '/api/session');
    expect(r1.ok || r1.error.code).toBe('network');
    mockFetch(200, { nope: true });
    const r2 = await call('POST', '/api/guest/hello', { schema: HelloReplySchema });
    expect(r2.ok || r2.error.code).toBe('bad-reply');
  });

  it('adds the desktop bearer on admin routes only', async () => {
    window.jukebox = { adminToken: () => Promise.resolve('secret-token') };
    const f = mockFetch(200, {});
    await call('GET', '/api/admin/players');
    await call('GET', '/api/session');
    const h0 = f.mock.calls[0]![1]!.headers as Record<string, string>;
    const h1 = f.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(h0.authorization).toBe('Bearer secret-token');
    expect(h1.authorization).toBeUndefined();
  });
});
