import { test, expect } from '@playwright/test';
import { gotoAuthed } from './helpers';

/**
 * Mobile: simple navigation, module links and short-screen access.
 */
test.describe('mobile sidebar (Phase 8)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await gotoAuthed(page, '/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard', exact: true })).toBeVisible();
  });

  test('opens simple navigation and routes through Buying to Purchase Orders', async ({ page }) => {
    await page.getByRole('button', { name: 'Open navigation' }).click();

    const sidebar = page.locator('aside.sidebar');
    await expect(sidebar).toBeVisible();
    for (const label of ['Home', 'Products', 'Stock', 'Buying', 'Selling', 'People', 'Reports', 'More tools']) {
      await expect(sidebar.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await sidebar.getByRole('button', { name: 'Buying', exact: true }).click();
    await expect(page).toHaveURL(/\/tools\?section=buying/);
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('main').getByRole('link', { name: /Purchase orders Order items from a supplier/i }).click();
    await expect(page).toHaveURL(/\/purchase-orders/);
    await expect(page.getByRole('heading', { level: 1, name: 'Purchase Orders', exact: true })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  test('navigation remains usable on short mobile screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 540 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav).toBeVisible();

    const metrics = await nav.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThanOrEqual(metrics.clientHeight);
    const moreTools = nav.getByRole('button', { name: 'More tools', exact: true });
    await moreTools.scrollIntoViewIfNeeded();
    await moreTools.click();
    await expect(page).toHaveURL(/\/tools$/);
    await expect(page.getByRole('heading', { level: 1, name: 'What would you like to do?' })).toBeVisible();
  });
});
