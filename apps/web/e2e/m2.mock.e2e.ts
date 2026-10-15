import { expect, test } from '@playwright/test';

/*
 * M2 flows against the mock build (VITE_MOCK=1): the in-browser hub plus the fake desktop bridge
 * from src/dev/mock.ts. Every page load starts a fresh mock hub.
 */

const PLAYER_TV = '/tv?mode=player&hub=http://192.168.1.20:8080&player=den-laptop&token=x';

test('player TV: join popup counts down, Stay separate flips it, then it closes', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.goto(PLAYER_TV);
  const countdown = page.getByTestId('join-countdown');
  await expect(countdown).toHaveText(/^Joining Basement in (10|9|8)…$/);
  await expect(page.getByTestId('tv-pill')).toHaveText(/Online|Press Start Music/);
  await expect(page.getByTestId('tv-link-caption')).toHaveText('This TV is linked to Basement');
  // Never over the player.
  const player = await page.getByTestId('tv-player').boundingBox();
  const popup = await page.getByTestId('join-popup').boundingBox();
  expect((popup?.x ?? 0) >= (player?.x ?? 0) + (player?.width ?? 0)).toBe(true);

  await page.getByRole('button', { name: 'Stay separate' }).click();
  await expect(countdown).toHaveText(/^Staying separate in \d+…$/);
  await expect(page.getByRole('button', { name: 'Join Basement' })).toBeVisible();
  await expect(page.getByTestId('tv-link-caption')).toHaveText('This TV plays its own queue');
  // The room now has its own group, so its QR points at /r/<group>.
  await expect(page.getByTestId('tv-join')).toHaveText(/\/r\/g-den$/);
  await expect(page.getByTestId('join-popup')).toHaveCount(0, { timeout: 12_000 });
});

test('player TV: a hub that fails verification is not followed', async ({ page }) => {
  await page.goto(`${PLAYER_TV}&mockbadhub=1`);
  await expect(page.getByTestId('tv-pill')).toHaveText('Hub failed verification');
  await expect(page.getByTestId('tv-auth-problem')).toBeVisible();
  await expect(page.getByTestId('join-popup')).toHaveCount(0);
});

test('setup: joins the hub it hears by default', async ({ page }) => {
  await page.goto('/setup?mocksetup=1');
  await page.getByLabel('I agree', { exact: false }).check();
  await expect(page.getByRole('radio', { name: /Join Basement/ })).toBeChecked();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Owner password').fill('wrong');
  await page.getByLabel('This laptop’s room name').fill('Den');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(/Wrong owner password/);
  await page.getByLabel('Owner password').fill('jukebox1');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Done, joining…' })).toBeVisible();
});

test('admin Rooms: link a split room and re-add its waiting songs', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/admin');
  await page.getByLabel('Password').fill('jukebox1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('button', { name: 'Rooms' }).click();
  await expect(page.getByTestId('room-row')).toHaveCount(3);
  await expect(page.getByTestId('replica-status')).toBeVisible();
  await page.getByRole('button', { name: 'Link: Garage' }).click();
  const orphans = page.getByTestId('orphaned');
  await expect(orphans.getByRole('listitem')).toHaveCount(2);
  await orphans.getByRole('button', { name: 'Add these to the main queue' }).click();
  await expect(page.getByText('Added 2 songs to the main queue')).toBeVisible();
  await expect(orphans).toHaveCount(0);
});

test('guest page bound to a split room', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rj.noticeAccepted', '1'));
  await page.goto('/r/g-garage');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Garage');
});
