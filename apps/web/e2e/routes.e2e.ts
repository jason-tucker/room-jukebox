import { expect, test, type Page } from '@playwright/test';

/*
 * Route smoke tests against the built SPA (`vite preview`, no hub behind it). API calls are
 * stubbed per test with page.route; the WebSocket simply never connects.
 */

const guestState = {
  revision: 1,
  changeSeq: 1,
  serverTime: Date.now(),
  protocolVersion: 1,
  roomName: 'Basement',
  playback: { state: 'idle', nowPlaying: null },
  queue: [
    {
      id: 'e1',
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      durationSec: 213,
      requesterName: null,
      source: 'request',
      status: 'queued',
      enqueuedAt: 1,
      mine: true,
    },
  ],
  recentHistory: [],
  search: { enabled: false, remaining: null, low: false },
  limits: { maxPendingPerGuest: 5, cooldownSec: 5, maxDurationSec: 480, allowDuplicates: true },
  flags: { hasApiKey: false, publicMode: false },
};

async function stubGuest(page: Page) {
  const requests: unknown[] = [];
  await page.route('**/api/guest/hello', (r) =>
    r.fulfill({ json: { guestId: 'g1', name: null, noticeAccepted: false } }),
  );
  await page.route('**/api/guest/notice', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/session', (r) => r.fulfill({ json: guestState }));
  await page.route('**/api/videos/resolve**', (r) =>
    r.fulfill({
      json: { videoId: 'OPf0YbXqDm0', title: 'Uptown Funk', durationSec: 270, playable: true },
    }),
  );
  await page.route('**/api/requests', async (r) => {
    requests.push(r.request().postDataJSON());
    await r.fulfill({
      status: 201,
      json: {
        entry: { ...guestState.queue[0], id: 'e2', videoId: 'OPf0YbXqDm0', title: 'Uptown Funk' },
        duplicate: false,
      },
    });
  });
  return requests;
}

test('guest: notice, then paste flow requests a song', async ({ page, context }) => {
  const requests = await stubGuest(page);
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Welcome to the jukebox' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'YouTube Terms of Service' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Basement');
  await expect(page.getByRole('link', { name: 'Find on YouTube' })).toBeVisible();
  await expect(page.getByText('Your request')).toBeVisible();

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('https://youtu.be/OPf0YbXqDm0?si=x'));
  await page.getByRole('button', { name: 'Paste link' }).click();
  await expect(page.getByRole('dialog', { name: 'Request this song?' })).toBeVisible();
  await page.getByRole('button', { name: 'Request it' }).click();
  await expect(page.getByText('Added: Uptown Funk')).toBeVisible();
  expect(requests).toEqual([{ videoId: 'OPf0YbXqDm0', idempotencyKey: expect.any(String) }]);

  // The notice is remembered on this phone.
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Welcome to the jukebox' })).toHaveCount(0);
});

test('guest: manual link field when the clipboard is refused', async ({ page }) => {
  await stubGuest(page);
  await page.addInitScript(() => localStorage.setItem('rj.noticeAccepted', '1'));
  await page.goto('/');
  await page.getByLabel('Or paste the link here').fill('not a link');
  await page.getByRole('button', { name: 'Check link' }).click();
  await expect(
    page.getByText("That doesn't look like a YouTube link", { exact: false }),
  ).toBeVisible();
});

test('guest page fits a 360 px phone without horizontal scroll', async ({ page }) => {
  await stubGuest(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addInitScript(() => localStorage.setItem('rj.noticeAccepted', '1'));
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Find on YouTube' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('admin: login form shows the throttle message', async ({ page }) => {
  await page.route('**/api/admin/session', (r) =>
    r.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'no' } } }),
  );
  await page.route('**/api/admin/login', (r) =>
    r.fulfill({
      status: 429,
      json: { error: { code: 'login-throttled', message: 'slow', retryAfterSec: 30 } },
    }),
  );
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Owner login');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Too many tries', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeDisabled();
});

test('setup redirects to /admin once setup is done', async ({ page }) => {
  await page.route('**/api/setup/status', (r) =>
    r.fulfill({ status: 409, json: { error: { code: 'setup-done', message: 'done' } } }),
  );
  await page.route('**/api/admin/session', (r) =>
    r.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'no' } } }),
  );
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/admin$/);
});

test('setup wizard starts with the notice acceptance', async ({ page }) => {
  await page.route('**/api/setup/status', (r) =>
    r.fulfill({
      json: {
        needsSetup: true,
        lan: {
          addresses: [{ interface: 'Wi-Fi', address: '192.168.1.20', cidr: '192.168.1.0/24' }],
          chosen: '192.168.1.20',
          lanUrl: 'http://192.168.1.20:8080/',
        },
      },
    }),
  );
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  await page.getByLabel('I agree', { exact: false }).check();
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
});

test('privacy falls back to the built-in text', async ({ page }) => {
  await page.route('**/api/privacy.json', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  await expect(page.getByRole('heading', { name: 'Deleting your data' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'https://policies.google.com/privacy' }).first(),
  ).toBeVisible();
});

test('/tv keeps looking for the hub with nothing over the player', async ({ page }) => {
  await page.goto('/tv?player=e2e&token=x');
  await expect(page.getByTestId('tv-pill')).toHaveText('Looking for hub');
  await expect(page.getByTestId('tv-player')).toBeVisible();
  const box = await page.getByTestId('tv-player').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(480);
});

test('the M0 spike pages stay reachable', async ({ page }) => {
  await page.goto('/spike');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Spike control');
  await page.goto('/tv-spike?player=e2e');
  await expect(page.getByText('Looking for hub')).toBeVisible();
});
