import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'playwright/test';

test('focused pass for AI Landscape slide captures overlap diagnostics', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);

  const outDir = path.resolve(process.cwd(), 'output', 'playwright', 'ai-landscape-pass');
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
    'Use this exact slide title with no changes: "The AI Landscape: From Adoption to Scaling".',
    'Keep all bullets concise (max 55 characters each).',
    'For this slide include these points:',
    '- AI adoption is universal but scaling remains elusive.',
    '- Only 38% of organizations scale AI beyond pilot phases.',
    '- High costs and low ROI stall production deployment.',
    'For that specific slide, prefer asymmetric visual balance and asymmetric-grid composition.'
  ].join('\n');

  await page.getByPlaceholder(/create a pitch deck/i).fill(topicPrompt);
  await page.getByRole('button', { name: /launch agent swarm/i }).click();

  await expect(page.getByRole('button', { name: /export pptx/i })).toBeVisible({ timeout: 20 * 60 * 1000 });

  await page.waitForTimeout(1500);
  await expect(page.getByText(/Slide:\s*The AI Landscape:\s*From Adoption to Scaling/i)).toBeVisible({ timeout: 30_000 });

  const qaHeader = page.locator('h4').filter({ hasText: /Quality Assurance Notes|Generation Recovered/i }).first();
  let qaNotes: string[] = [];
  if (await qaHeader.count()) {
    const qaPanel = qaHeader.locator('xpath=ancestor::div[1]');
    qaNotes = (await qaPanel.locator('li').allInnerTexts()).map((n) => n.trim()).filter(Boolean);
  }

  const previewPanel = page.locator('div').filter({ has: page.getByText('Visual Preview', { exact: true }) }).first();
  const fullPagePath = path.join(outDir, 'ai-landscape-fullpage.png');
  const previewPath = path.join(outDir, 'ai-landscape-preview.png');
  await page.screenshot({ path: fullPagePath, fullPage: true });
  if (await previewPanel.count()) {
    await previewPanel.screenshot({ path: previewPath });
  }

  const highlights = consoleLogs.filter((line) =>
    /AI Landscape|QWEN QA|QWEN3-VL spatial escalation|requires repair|flagged review|CIRCUIT BREAKER|asymmetric-grid|top-band|collision|overlap/i.test(
      line
    )
  );

  const overlapPattern = /(text[_\s-]?overlap|top[-\s]?band|top[-\s]?left|collision|requires repair)/i;
  const overlapSignals = [
    ...qaNotes.filter((line) => /overlap|collision|top-left|top-band|requires repair/i.test(line)),
    ...highlights.filter((line) => /overlap|collision|top-left|top-band|requires repair/i.test(line))
  ].filter((line) => overlapPattern.test(line) && !/semantic overlap/i.test(line));

  const report = {
    generatedAt: new Date().toISOString(),
    topicPrompt,
    qaNotes,
    overlapSignals,
    consoleHighlights: highlights.slice(-120),
    artifacts: {
      fullPagePath,
      previewPath: fs.existsSync(previewPath) ? previewPath : null
    }
  };

  fs.writeFileSync(path.join(outDir, 'ai-landscape-pass-report.json'), JSON.stringify(report, null, 2), 'utf-8');

  expect(highlights.length).toBeGreaterThan(0);
});
