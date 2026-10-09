import { PROTOCOL_VERSION } from '@room-jukebox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, VERSION } from '../src/app.ts';

describe('GET /healthz', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ webRoot: '/nonexistent' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with version and protocolVersion', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: VERSION, protocolVersion: PROTOCOL_VERSION });
  });

  it('sets Referrer-Policy on every response, including 404s', async () => {
    const ok = await app.inject({ method: 'GET', url: '/healthz' });
    const missing = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(ok.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
