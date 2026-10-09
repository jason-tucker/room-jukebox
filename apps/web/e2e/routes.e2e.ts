import { expect, test } from '@playwright/test';

const routes: Array<[string, string]> = [
  ['/', 'Room Jukebox'],
  ['/tv', 'TV'],
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
