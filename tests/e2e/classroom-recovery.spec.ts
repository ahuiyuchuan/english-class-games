/**
 * 真实便携课堂的设备故障回归。仅注入一次设备拒绝，保留真实控制器与时钟。
 * 覆盖恢复提示、弹窗告警唯一性、低高度布局和中断时特效清理。
 * @author ahui
 */
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 下一次设备恢复失败后立即恢复原方法，便于验证真实重试不会重开课堂。 */
async function failDeviceOnce(page: Page) {
  await page.evaluate(() => {
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      AudioContext.prototype.resume = resume;
      return Promise.reject(new Error('声音设备暂时不可用，请检查输出设备后重试。'));
    };
  });
}

test('设备错误明确中断，弹窗与舞台恢复一致，重试清除告警', async ({ page, context }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(
    pathToFileURL(
      fileURLToPath(new URL('../../examples/高中单词节拍-文字领读.html', import.meta.url)),
    ).href,
  );
  await failDeviceOnce(page);
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('点击“开始课堂”重试');
  await page.screenshot({ path: info.outputPath('startup-error.png') });
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await failDeviceOnce(page);
  await page.getByRole('button', { name: '下一词', exact: true }).click();
  await expect(page.getByText('播放已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('点击“重试当前阶段”继续');
  const word = await page.getByRole('heading', { level: 1 }).innerText();
  const canvas = page.locator('.ecg-particle-canvas');
  const frame = await canvas.getAttribute('data-frame');
  await page.waitForTimeout(200);
  expect(await canvas.getAttribute('data-frame')).toBe(frame);
  await expect(page.locator('.ecg-completion-burst')).toHaveCount(0);
  for (const width of [1366, 911, 720]) {
    const height = width === 1366 ? 768 : 480;
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: info.outputPath(`runtime-error-${width}.png`) });
    const button = await page.getByRole('button', { name: '重试当前阶段' }).boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.getByRole('button', { name: '课堂设置' }).click();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('关闭设置后');
  await page.getByRole('dialog').getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('settings-error.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '重试当前阶段' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('播放已中断', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(word);
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('recovered.png') });
  expect(errors).toEqual([]);
});
