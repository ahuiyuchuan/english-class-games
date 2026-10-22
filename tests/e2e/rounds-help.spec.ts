/** 对正式离线成品验证轮数、应急调整和帮助层；不替换课堂时钟。 @author ahui */
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

for (const [mode, width] of [
  ['配音跟读', 1366],
  ['文字领读', 911],
  ['学生自主齐读', 720],
] as const) {
  test(`${mode}离线轮数、草稿、说明和课中边界`, async ({ page, context }, info) => {
    await context.setOffline(true);
    await page.setViewportSize({ width, height: width === 1366 ? 768 : 480 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(resolve(`examples/高中单词节拍-${mode}.html`)).href);
    const settings = page.getByRole('button', { name: '课堂设置', exact: true });
    await settings.click();
    const help = page.getByRole('button', { name: '每词练习轮数说明', exact: true });
    await help.hover();
    await expect(page.getByRole('tooltip')).toContainText('每个词完整练习几轮');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await help.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    const rounds = page.getByLabel('当前词轮数', { exact: true });
    for (const invalid of ['', '0', '9', '1.5']) {
      await rounds.fill(invalid);
      await expect(rounds).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('button', { name: '完成设置', exact: true })).toBeDisabled();
    }
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeDisabled();
    await settings.click();
    await expect(rounds).toHaveValue('1.5');
    await page.getByRole('button', { name: '恢复当前词轮数', exact: true }).click();
    await page.getByLabel('统一轮数', { exact: true }).fill('1');
    await expect(page.getByRole('button', { name: '应用到范围内词语', exact: true })).toHaveCount(
      0,
    );
    await rounds.fill('8');
    await expect(page.locator('.ecg-rounds-summary')).toContainText('1～8');
    await page.locator('.ecg-settings-body').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath(`rounds-${width}.png`) });
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await expect(page.locator('.ecg-classroom-detail')).toContainText('/ 8 轮');
    await settings.click();
    await rounds.fill('1');
    await expect(page.getByText(/课中修改从下一词或重玩生效/)).toBeVisible();
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await expect(page.locator('.ecg-classroom')).toHaveAttribute('data-state', 'paused');
    await page.getByRole('button', { name: '重读', exact: true }).click();
    await expect(page.locator('.ecg-classroom-detail')).toContainText('/ 8 轮');
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await expect(page.locator('.ecg-classroom-detail')).toContainText('/ 1 轮');
    await page.getByRole('button', { name: '上一词', exact: true }).click();
    await expect(page.locator('.ecg-classroom-detail')).toContainText('/ 1 轮');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await settings.click();
    await page.getByRole('button', { name: '结束本次课堂', exact: true }).click();
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await expect(page.locator('.ecg-classroom-detail')).toContainText('/ 1 轮');
    await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible({
      timeout: 40000,
    });
    await page.getByRole('button', { name: '回到开始页', exact: true }).click();
    await settings.click();
    await expect(rounds).toHaveValue('1');
    expect(errors).toEqual([]);
  });
}
