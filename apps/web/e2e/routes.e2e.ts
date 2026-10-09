import { expect, test } from '@playwright/test';

const routes: Array<[string, string]> = [
  ['/', 'Room Jukebox'],
  ['/spike', 'Spike control'],
  ['/admin', 'Admin'],
  ['/setup', 'Setup'],
  ['/settings', 'Settings'],
  ['/privacy', 'Privacy'],
];

for (const [path, heading] of routes) {
  test(`renders ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  });
}

test('renders /tv with the status column beside the player', async ({ page }) => {
  // vite preview has no hub behind it, so the page keeps looking for one.
  await page.goto('/tv?player=e2e');
  await expect(page.getByText('Looking for hub')).toBeVisible();
  await expect(page.getByText('e2e', { exact: true })).toBeVisible();
});
