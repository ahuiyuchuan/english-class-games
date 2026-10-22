/** 真实导出成品课前设置；断网运行，不注入教学状态或替代音频时钟。 @author ahui */
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

for (const mode of ['文字领读', '学生自主齐读', '配音跟读']) {
  test(`${mode}课前设置、开始、暂停与重玩`, async ({ page, context }, info) => {
    await context.setOffline(true);
    await page.setViewportSize({ width: 720, height: 480 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(resolve(`examples/高中单词节拍-${mode}.html`)).href);
    const settings = page.getByRole('button', { name: '课堂设置', exact: true });
    await settings.click();
    await page.getByRole('combobox', { name: /推进方式/ }).selectOption('step');
    await page.getByRole('combobox', { name: /展示模式/ }).selectOption('centered');
    await page.getByLabel('显示前后词预告', { exact: true }).uncheck();
    await page.getByLabel('继续前准备两拍', { exact: true }).check();
    await page.locator('.ecg-settings-body').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath('prestart-settings.png') });
    await page.keyboard.press('Escape');
    await expect(settings).toBeFocused();
    await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeDisabled();
    await settings.click();
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    const bounds = await settings.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(480);
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await expect(page.locator('.ecg-word-track')).toBeHidden();
    await expect(page.locator('.ecg-classroom')).toHaveClass(/ecg-classroom--centered/);
    await settings.click();
    await expect(page.locator('.ecg-classroom')).toHaveAttribute('data-state', 'paused');
    await expect(page.getByLabel('继续前准备两拍', { exact: true })).toBeDisabled();
    await expect(page.getByText('仅课前调整；需要修改请回到开始页。')).toBeVisible();
    await page.screenshot({ path: info.outputPath('running-preparation-explanation.png') });
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.locator('.ecg-classroom-stage')).toHaveAttribute(
      'data-phase',
      'resume-preparation',
    );
    await settings.click();
    await page.getByRole('button', { name: '结束本次课堂', exact: true }).click();
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await expect(page.locator('.ecg-classroom')).toHaveClass(/ecg-classroom--centered/);
    await settings.click();
    await expect(page.getByRole('combobox', { name: /推进方式/ })).toHaveValue('step');
    await page.getByRole('button', { name: '结束本次课堂', exact: true }).click();
    await page.getByRole('button', { name: '回到开始页', exact: true }).click();
    await settings.click();
    await expect(page.getByLabel('显示前后词预告', { exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  });
}
