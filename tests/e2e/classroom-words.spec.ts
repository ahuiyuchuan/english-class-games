/** Actual exported classroom edits; real timeline and localStorage, offline file://. @author ahui */
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

for (const [mode, width] of [
  ['学生自主齐读', 720],
  ['文字领读', 911],
  ['配音跟读', 1366],
] as const) {
  test(`${mode}临时文字直接调整、统一保存、声音边界和重开`, async ({ page, context }, info) => {
    await context.setOffline(true);
    await page.setViewportSize({ width, height: width === 1366 ? 768 : 480 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(resolve(`examples/高中单词节拍-${mode}.html`)).href);
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    const english = page.getByLabel('英文／短语', { exact: true });
    const meaning = page.getByLabel('教学释义', { exact: true });
    const complete = page.getByRole('button', { name: '完成设置', exact: true });
    await english.fill('');
    await expect(complete).toBeDisabled();
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await expect(english).toHaveValue('');
    await page.getByRole('button', { name: '还原此词文字', exact: true }).click();
    await expect(english).toHaveValue('knowledge');
    await english.fill('classroom practice');
    await meaning.fill('课堂临时练习');
    if (mode === '配音跟读') {
      await expect(complete).toBeDisabled();
      await expect(
        page.getByRole('button', { name: '本课改为文字领读', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '本课改为文字领读', exact: true }).click();
      await expect(complete).toBeEnabled();
      await page.getByRole('button', { name: '恢复配音跟读', exact: true }).click();
      await expect(complete).toBeDisabled();
      await page.getByRole('button', { name: '本课改为文字领读', exact: true }).click();
    }
    await english.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`words-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const bounds = await complete.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 1366 ? 768 : 480);
    await complete.click();
    await page.reload();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await expect(english).toHaveValue('classroom practice');
    await expect(meaning).toHaveValue('课堂临时练习');
    await complete.click();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('classroom practice');
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await english.fill('updated practice');
    await meaning.fill('课中新安排');
    await complete.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('classroom practice');
    await page.getByRole('button', { name: '重读', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('classroom practice');
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await page.getByRole('button', { name: '上一词', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('updated practice');
    // 词轨通过 data-word 的伪元素绘字，验证实际绘制来源，避免只查不可见 textContent。
    await expect(page.locator('.ecg-word-track-word').first()).toHaveAttribute(
      'data-word',
      'updated practice',
    );
    await page.screenshot({ path: info.outputPath('saved-live-word.png') });
    await page.getByRole('button', { name: '结束课堂', exact: true }).click();
    await page.getByRole('button', { name: '回到开始页', exact: true }).click();
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await page.getByRole('button', { name: '恢复课件原始设置', exact: true }).click();
    await page.getByRole('button', { name: '确认恢复并返回开始页', exact: true }).click();
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await expect(english).toHaveValue('knowledge');
    expect(errors).toEqual([]);
  });
}

for (const progression of ['auto', 'step']) {
  test(`自然${progression}换词在同存文字和轮数后按真实目标进入`, async ({
    page,
    context,
  }, info) => {
    await context.setOffline(true);
    await page.goto(pathToFileURL(resolve('examples/高中单词节拍-学生自主齐读.html')).href);
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await page.getByRole('button', { name: '节奏与推进', exact: true }).click();
    const progressionSelect = page.getByRole('combobox', { name: /推进方式/ });
    await expect(progressionSelect).toBeVisible();
    await progressionSelect.selectOption(progression);
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await page.getByLabel('当前词轮数', { exact: true }).fill('2');
    await page.getByLabel('英文／短语', { exact: true }).fill('new knowledge');
    const words = page.getByRole('listbox', { name: '选择要调整的词' });
    await expect(words).toBeVisible();
    await words.getByRole('option').nth(1).click();
    await page.getByLabel('英文／短语', { exact: true }).fill('next challenge');
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('knowledge');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    if (progression === 'step') {
      await expect(page.getByText('等待教师', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '继续下一词', exact: true }).click();
    }
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('next challenge');
    await page.screenshot({ path: info.outputPath('stable-next-item.png') });
  });
}

test('设置内修改词语会取消已过期的真实声音试听', async ({ page, context }, info) => {
  await context.setOffline(true);
  await page.goto(pathToFileURL(resolve('examples/高中单词节拍-配音跟读.html')).href);
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('button', { name: '声音与音量', exact: true }).click();
  await page.getByRole('button', { name: '测试声音', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止测试', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '练习安排', exact: true }).click();
  await page.getByLabel('英文／短语', { exact: true }).fill('changed word');
  await expect(page.getByRole('button', { name: '停止测试', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完成设置', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '本课改为文字领读', exact: true }).click();
  await page.getByRole('button', { name: '声音与音量', exact: true }).click();
  await expect(page.getByRole('button', { name: '测试声音', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('stale-preview-cancelled.png') });
});
