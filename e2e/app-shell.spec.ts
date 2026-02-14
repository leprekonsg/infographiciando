import { expect, test } from 'playwright/test';

test('app shell and view toggle flow works', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('InfographIQ.')).toBeVisible();

  const agenticButton = page.getByRole('button', { name: /agentic builder/i });
  const quickButton = page.getByRole('button', { name: /quick generate/i });

  await expect(agenticButton).toBeVisible();
  await expect(quickButton).toBeVisible();

  await expect(page.getByRole('heading', { name: /agentic deck builder/i })).toBeVisible();

  await quickButton.click();

  await expect(page.getByText('Project Source')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Write$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import$/ })).toBeVisible();
  await expect(page.getByPlaceholder(/markdown source code/i)).toBeVisible();

  await agenticButton.click();

  await expect(page.getByRole('heading', { name: /agentic deck builder/i })).toBeVisible();
  await expect(page.getByPlaceholder(/create a pitch deck/i)).toBeVisible();
});
