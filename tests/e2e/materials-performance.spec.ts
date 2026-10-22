/**
 * 材料整理的真实页面性能回归。通过点击和下一次可交互帧计时，包含解析、
 * 全量候选匹配与首屏布局；分页后半页另行核对，不能以后台任务受理代替完成。
 * 当前设备测量不替代设计规定的四核 / 8 GB 基准机验收。
 * @author ahui
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DictionaryEntry } from '../../src/platform/materials/types';

const dictionary = JSON.parse(
  readFileSync(new URL('../../resources/dictionary/high-school.json', import.meta.url), 'utf8'),
) as DictionaryEntry[];
const functionWords = JSON.parse(
  readFileSync(new URL('../../resources/dictionary/function-words.json', import.meta.url), 'utf8'),
) as { words: string[] };

interface Sample {
  mode: 'vocabulary' | 'reading';
  iteration: number;
  clickToSelectableFrameMs: number;
  visibleRows: number;
}

/**
 * 对一次真实点击安装只读观察，时间起点不包含 Playwright 的定位与滚动等待。
 * @param page 当前隔离的测试页面，不修改产品逻辑或时钟。
 * @param button 正式整理按钮，点击后须完成 50 行可操作的分页结果。
 * @returns 实际浏览器时钟的点击至可操作帧时间，单位毫秒。
 */
async function measurePreview(page: Page, button: Locator): Promise<number> {
  await button.evaluate((element) => {
    const state = window as typeof window & { materialTiming?: { elapsed?: number } };
    state.materialTiming = {};
    element.addEventListener(
      'click',
      () => {
        const started = performance.now();
        const observe = () => {
          const rows = [...document.querySelectorAll('.import-panel .review-row')];
          const ready =
            rows.length === 50 &&
            rows.every((row) => {
              const choice = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
              const candidates = row.querySelector<HTMLSelectElement>('select');
              return (
                choice &&
                !choice.matches(':disabled') &&
                candidates &&
                !candidates.matches(':disabled') &&
                candidates.options.length > 1 &&
                row.getBoundingClientRect().height > 0
              );
            });
          if (ready) state.materialTiming!.elapsed = performance.now() - started;
          else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      },
      { once: true, capture: true },
    );
  });
  await button.click();
  await page.waitForFunction(() => {
    const state = window as typeof window & { materialTiming?: { elapsed?: number } };
    return typeof state.materialTiming?.elapsed === 'number';
  });
  return page.evaluate(() => {
    const state = window as typeof window & { materialTiming?: { elapsed?: number } };
    return state.materialTiming!.elapsed!;
  });
}

test('100词与20000字符阅读各5次从点击至候选可选择均不超过2秒', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const folded = new Set(functionWords.words);
  const pool = [...new Set(dictionary.map((entry) => entry.english))].filter(
    (word) => /^[a-z]+$/u.test(word) && !folded.has(word),
  );
  const words = Array.from(
    { length: 100 },
    (_, index) => pool[Math.floor((index * pool.length) / 100)],
  );
  const vocabulary = words.join('\n');
  const paragraph = `${words.join(', ')}.\n`;
  let reading = '';
  while (reading.length + paragraph.length <= 20_000) reading += paragraph;
  for (const word of words) {
    const piece = `${word}, `;
    if (reading.length + piece.length > 20_000) break;
    reading += piece;
  }
  reading = reading.padEnd(20_000, ' ');
  expect(new Set(words).size).toBe(100);
  expect([...reading]).toHaveLength(20_000);

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  const preview = page.getByRole('button', { name: '整理并预览', exact: true });
  const samples: Sample[] = [];
  for (const mode of ['vocabulary', 'reading'] as const) {
    if (mode === 'reading') {
      await page.getByRole('button', { name: '查看或修改原文与列设置' }).click();
      await page.getByRole('button', { name: '阅读选词', exact: true }).click();
      // Switching after a completed review explicitly discards that review;
      // confirming this protection is outside the measured parse interval.
      await page
        .getByRole('dialog', { name: '切换材料类型？', exact: true })
        .getByRole('button', { name: '确认切换', exact: true })
        .click();
    }
    const input = page.getByRole('textbox', {
      name: mode === 'reading' ? '高中阅读文本' : '教学词表',
      exact: true,
    });
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      // Review keeps the original source behind an explicit disclosure; reopening
      // it is outside the measured parsing interval and must preserve the text.
      const source = page.getByRole('button', { name: '查看或修改原文与列设置' });
      if (!(await input.isVisible()) && (await source.isVisible())) await source.click();
      await input.fill('');
      await input.fill(mode === 'reading' ? reading : vocabulary);
      await expect(page.locator('.import-panel .review-row')).toHaveCount(0);
      const elapsed = await measurePreview(page, preview);
      samples.push({ mode, iteration, clickToSelectableFrameMs: elapsed, visibleRows: 50 });
      expect(elapsed).toBeLessThanOrEqual(2_000);
      if (mode === 'reading')
        await expect(
          page.getByRole('heading', { name: '阅读候选 · 0 项已选', exact: true }),
        ).toBeVisible();
      else
        await expect(
          page.getByRole('heading', { name: '校对 100 条教学内容', exact: true }),
        ).toBeVisible();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.locator('.import-panel .review-row')).toHaveCount(50);
      // 翻页也必须保留真实的词库候选，不能只为首屏准备空壳控件。
      expect(
        await page
          .locator('.import-panel .review-row select')
          .evaluateAll((elements) =>
            elements.every((element) => (element as HTMLSelectElement).options.length > 1),
          ),
      ).toBe(true);
    }
  }
  const report = {
    measuredAt: new Date().toISOString(),
    browser: await page.evaluate(() => navigator.userAgent),
    viewport: page.viewportSize(),
    method:
      '真实点击捕获至下一次50行候选可操作且布局完成的requestAnimationFrame；已加载真实词库；非冷启动',
    inputSha256: {
      vocabulary: createHash('sha256').update(vocabulary).digest('hex'),
      reading: createHash('sha256').update(reading).digest('hex'),
    },
    samples,
    pageErrors: errors,
  };
  await writeFile(
    testInfo.outputPath('materials-ui-performance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await testInfo.attach('真实页面材料整理性能', {
    path: testInfo.outputPath('materials-ui-performance.json'),
    contentType: 'application/json',
  });
  expect(errors).toEqual([]);
});
