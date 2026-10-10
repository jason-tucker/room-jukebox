import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { M1_PROTOCOL_VERSION } from '@room-jukebox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, VERSION } from '../src/app.ts';

describe('GET /healthz', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const dataDir = mkdtempSync(join(tmpdir(), 'rj-health-'));

  beforeAll(async () => {
    app = await buildApp({ webRoot: '/nonexistent', dataDir, nightlyBackup: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns 200 with version, protocolVersion and needsSetup', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      version: VERSION,
      protocolVersion: M1_PROTOCOL_VERSION,
      needsSetup: true,
    });
  });

  it('sets Referrer-Policy on every response, including 404s', async () => {
    const ok = await app.inject({ method: 'GET', url: '/healthz' });
    const missing = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(ok.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not-found');
    expect(missing.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
