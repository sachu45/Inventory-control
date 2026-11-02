import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForAppShell, writeE2eSession } from './helpers';

const authDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.auth');
const authFile = path.join(authDir, 'admin.json');

setup('authenticate as admin', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#email').fill(process.env.PLAYWRIGHT_ADMIN_EMAIL ?? 'admin@retailims.com');
  await page.locator('#password').fill(process.env.PLAYWRIGHT_ADMIN_PASSWORD ?? 'Admin@123');

  const cookieAcceptBtn = page.getByRole('button', { name: 'Accept all' });
  if ((await cookieAcceptBtn.count()) > 0 && (await cookieAcceptBtn.isVisible())) {
    await cookieAcceptBtn.click();
  }

  const [response] = await Promise.all([
    page.waitForResponse('**/api/v1/auth/login'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  expect(response.ok()).toBeTruthy();
  const json = await response.json();
  const authData = json.data as { accessToken: string; user: Record<string, unknown> };
  expect(authData.accessToken).toEqual(expect.any(String));
  expect(authData.user.id).toEqual(expect.any(String));

  writeE2eSession({ accessToken: authData.accessToken, user: authData.user });

  await page.waitForURL(/\/(dashboard|products)/, { timeout: 30_000 });
  await waitForAppShell(page);
  await page.context().storageState({ path: authFile });
});
