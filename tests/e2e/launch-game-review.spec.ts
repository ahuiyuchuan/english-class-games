/**
 * 首发游戏完整课堂回归：正式 HTML、真实时钟及真实输入，不注入业务状态。
 * BASELINE=1 仅用于改动前截图与测量，不将基线中的缺陷断言为通过。
 * @author ahui
 */
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

test.use({ video: 'on', viewport: { width: 1366, height: 768 } });

test('单词节拍自然完成、重播、提前结束、静态缩放与键盘接续', async ({ page, context }, info) => {
  test.setTimeout(150_000);
  const baseline = process.env.BASELINE === '1';
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url())) requests.push(request.url());
  });
  await context.setOffline(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(
    pathToFileURL(
      fileURLToPath(new URL('../../examples/高中单词节拍-文字领读.html', import.meta.url)),
    ).href,
  );
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });
  await shot('01-lobby');
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await shot('02-preparation');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('knowledge');
  await shot('03-playing');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const canvas = page.locator('.ecg-particle-canvas');
  const before = await canvas.evaluate((node: HTMLCanvasElement) => ({
    width: node.width,
    height: node.height,
    frame: node.dataset.frame,
  }));
  await page.setViewportSize({ width: 720, height: 480 });
  await shot('04-paused-small');
  if (!baseline)
    await expect
      .poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width))
      .not.toBe(before.width);
  const resized = await canvas.evaluate((node: HTMLCanvasElement) => ({
    width: node.width,
    height: node.height,
    frame: node.dataset.frame,
  }));
  await page.waitForTimeout(200);
  expect(await canvas.getAttribute('data-frame')).toBe(resized.frame);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本次练习记录' })).toBeVisible({
    timeout: 75_000,
  });
  if (!baseline) {
    const spark = page.locator('.ecg-completion-burst i').last();
    await expect(spark).toBeAttached();
    const first = await spark.evaluate((node) => getComputedStyle(node).transform);
    // 等待真实绘帧而非固定160ms：碎片有起步延迟，并行负载也可能推迟首次绘制。
    // 仍要求有限生命周期内观察到位移，后续继续验证整个粒子层自动移除。
    await expect
      .poll(() => spark.evaluate((node) => getComputedStyle(node).transform), {
        timeout: 800,
        intervals: [16, 32, 50],
      })
      .not.toBe(first);
  }
  await shot('05-finished');
  const completedFocus = await page.evaluate(() => document.activeElement?.tagName);
  if (!baseline) {
    await expect(page.getByRole('heading', { name: '本次练习记录' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '重新播放' })).toBeFocused();
  }
  await expect(page.getByLabel(/已完成 6 \/ 6 条/)).toBeVisible();
  if (!baseline) {
    await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 911, height: 480 },
      { width: 720, height: 480 },
    ]) {
      await page.setViewportSize(size);
      await shot(`finished-${size.width}`);
      const button = await page.getByRole('button', { name: '重新播放' }).boundingBox();
      expect(button!.y + button!.height).toBeLessThanOrEqual(size.height);
    }
  }
  // 窄屏按既有规范隐藏辅助 HUD；统计归零在宽屏读取，不把收起信息误判为丢失。
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: '重新播放', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByText('已完成 0 / 6 词')).toBeVisible();
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('button', { name: '结束本次课堂', exact: true }).click();
  await shot('06-ended');
  if (!baseline) {
    await expect(page.getByRole('heading', { name: '本次练习记录' })).toBeFocused();
    await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
  }
  await expect(page.getByText('已提前结束')).toBeVisible();
  await page.getByRole('button', { name: '回到开始页' }).click();
  if (!baseline)
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  await writeFile(
    info.outputPath('evidence.json'),
    JSON.stringify({ baseline, before, resized, completedFocus, errors, requests }, null, 2),
    'utf8',
  );
});

test('减少动态保留真实完成反馈，快速重进与特效中断不补播', async ({ page, context }, info) => {
  await context.setOffline(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(
    pathToFileURL(
      fileURLToPath(new URL('../../examples/高中单词节拍-文字领读.html', import.meta.url)),
    ).href,
  );
  await page.getByRole('button', { name: '开始课堂', exact: true }).dblclick();
  // 直接切词遵循真实导航，每次一条，不伪造自然完成的计数。
  for (let index = 0; index < 6; index++)
    await page.getByRole('button', { name: '下一词', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本次练习记录' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByLabel(/已完成 1 \/ 6 条/)).toBeVisible();
  await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
  await page.getByRole('button', { name: '重新播放' }).click();
  for (let index = 0; index < 6; index++)
    await page.getByRole('button', { name: '下一词', exact: true }).click();
  await expect(page.locator('.ecg-completion-burst')).toBeAttached({ timeout: 20_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
  await page.getByRole('button', { name: '重新播放' }).click();
  await expect(page.getByText('已完成 0 / 6 词')).toBeVisible();
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await page.getByRole('button', { name: '结束本次课堂' }).click();
  await page.screenshot({ path: info.outputPath('interrupted-result.png') });
});
