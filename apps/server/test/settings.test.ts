import { afterEach, describe, expect, it } from 'vitest';
import { makeHub, setup } from './helpers.ts';
import type { TestHub } from './helpers.ts';

let hub: TestHub;
afterEach(async () => hub.close());

describe('settings projection', () => {
  it('hasApiKey is false and apiKeyLast4 null when the stored key cannot be decrypted', async () => {
    let broken = false;
    hub = await makeHub({
      secrets: {
        encrypt: (s) => s,
        decrypt: (s) => {
          if (broken) throw new Error('cannot decrypt');
          return s;
        },
      },
    });
    const creds = await setup(hub.app);
    const res = await hub.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${creds.token}` },
      payload: { youtubeApiKey: 'AIzaTESTKEY0001' },
    });
    expect(res.statusCode).toBe(200);
    expect(hub.app.jukebox.settings()).toMatchObject({ hasApiKey: true, apiKeyLast4: '0001' });
    broken = true;
    expect(hub.app.jukebox.settings()).toMatchObject({ hasApiKey: false, apiKeyLast4: null });
  });
});
