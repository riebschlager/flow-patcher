import { expect, test } from '@playwright/test';

test('opens the example patch with typed ports and no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto('/');
  await expect(page.getByTestId('compile-status')).toHaveText('8 nodes compiled');
  await expect(page.getByTestId('patch-node')).toHaveCount(8);
  await expect(page.locator('.react-flow__edge')).toHaveCount(7);
  await expect(page.locator('[data-node-type="clock"]')).toContainText('Clock');
  await expect(page.locator('.react-flow__handle[data-port-type="audio"]')).toHaveCount(2);

  await page.screenshot({ path: 'test-results/editor.png' });
  expect(errors).toEqual([]);
});
