import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'playwright/test';

test('focused pass for State of Enterprise AI slide captures card consistency diagnostics', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);

  const outDir = path.resolve(process.cwd(), 'output', 'playwright', 'state-enterprise-pass');
  fs.mkdirSync(outDir, { recursive: true });

  const consoleLogs: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      /\[GENERATOR\]|\[QWEN QA\]|\[QWEN3-VL SPATIAL\]|\[VISUAL ARCHITECT\]|\[MMFC VISUAL GATE\]|\[ORCHESTRATOR\]|\[AUTO-REPAIR\]|\[CIRCUIT BREAKER\]|\[COMPOSITION ARCHITECT\]|\[ROUTER\]|\[CONTENT PLANNER\]/i.test(
        text
      )
    ) {
      consoleLogs.push(`[${msg.type()}] ${text}`);
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /agentic deck builder/i })).toBeVisible();

  const topicPrompt = [
    'Create exactly 1 slide in professional style.',
    'Use this exact slide title with no changes: "The State of Enterprise AI in 2025".',
    'Keep all bullets concise (max 60 characters each).',
    'Include these points:',
    '- AI adoption reaches critical mass at 78% globally.',
    '- Adoption surged from 50% to 78% in recent years.',
    '- CEOs expect fundamental shifts in value capture.',
    'Prefer standard-vertical layout with strong text clarity and balanced card visuals.'
  ].join('\n');

  await page.getByPlaceholder(/create a pitch deck/i).fill(topicPrompt);
  await page.getByRole('button', { name: /launch agent swarm/i }).click();

  await expect(page.getByRole('button', { name: /export pptx/i })).toBeVisible({ timeout: 20 * 60 * 1000 });
  await page.waitForTimeout(1500);
  await expect(page.getByText(/Slide:\s*The State of Enterprise AI in 2025/i)).toBeVisible({ timeout: 40_000 });

  const qaHeader = page.locator('h4').filter({ hasText: /Quality Assurance Notes|Generation Recovered/i }).first();
  let qaNotes: string[] = [];
  if (await qaHeader.count()) {
    const qaPanel = qaHeader.locator('xpath=ancestor::div[1]');
    qaNotes = (await qaPanel.locator('li').allInnerTexts()).map((n) => n.trim()).filter(Boolean);
  }

  const fullPagePath = path.join(outDir, 'state-enterprise-fullpage.png');
  const previewPath = path.join(outDir, 'state-enterprise-preview.png');
  const cardRowPreviewPath = path.join(outDir, 'state-enterprise-card-row-preview.png');
  await page.screenshot({ path: fullPagePath, fullPage: true });

  const previewPanel = page.locator('div').filter({ has: page.getByText('Visual Preview', { exact: true }) }).first();
  if (await previewPanel.count()) {
    await previewPanel.screenshot({ path: previewPath });
  }

  const cardRowSlide = page.getByText(/Strategic Evolution of Value Capture/i).first();
  if (await cardRowSlide.count()) {
    await cardRowSlide.click();
    await page.waitForTimeout(1200);
    if (await previewPanel.count()) {
      await previewPanel.screenshot({ path: cardRowPreviewPath });
    }
  }

  const highlights = consoleLogs.filter((line) =>
    /State of Enterprise AI|metric-cards|Precondition failed|Recovered metric-cards|QWEN QA|CIRCUIT BREAKER|card-row|standard-vertical|icon|font|color/i.test(
      line
    )
  );

  const report = {
    generatedAt: new Date().toISOString(),
    topicPrompt,
    qaNotes,
    consoleHighlights: highlights.slice(-140),
    artifacts: {
      fullPagePath,
      previewPath: fs.existsSync(previewPath) ? previewPath : null,
      cardRowPreviewPath: fs.existsSync(cardRowPreviewPath) ? cardRowPreviewPath : null
    }
  };

  fs.writeFileSync(path.join(outDir, 'state-enterprise-pass-report.json'), JSON.stringify(report, null, 2), 'utf-8');

  expect(highlights.length).toBeGreaterThan(0);
});
