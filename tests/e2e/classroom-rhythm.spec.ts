/** 正式导出 HTML 的齐读临时设置回归；不注入教学状态或伪造时钟。 @author ahui */
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('末词四拍两次可调整并统一保存，当前词不被打断，刷新与重玩使用新安排', async ({
  page,
  context,
}, info) => {
  await context.setOffline(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(resolve('examples/高中单词节拍-学生自主齐读.html')).href);
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await page.getByRole('button', { name: '下一词', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  for (let count = 0; count < 5; count++)
    await page.getByRole('button', { name: '下一词', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('take part in');
  await expect(page.locator('.ecg-beat-block')).toHaveCount(2);
  await expect(page.locator('.ecg-chorus-guide')).toContainText(/每次\s*2\s*拍/);
  await page.screenshot({ path: info.outputPath('last-word-four-beats-two-readings.png') });
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await expect(
    page.getByRole('listbox', { name: '选择要调整的词' }).getByRole('option').last(),
  ).toHaveAttribute('aria-selected', 'true');
  const beats = page.getByLabel('每轮总拍数', { exact: true });
  await beats.fill('3');
  await expect(page.getByRole('button', { name: '完成设置', exact: true })).toBeDisabled();
  await expect(page.getByText(/暂不能计算新编排时长/)).toBeVisible();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await expect(beats).toHaveValue('3');
  await page.getByRole('button', { name: '恢复当前词拍数', exact: true }).click();
  await page.getByRole('combobox', { name: '每次朗读占用拍数', exact: true }).selectOption('1');
  await page.screenshot({ path: info.outputPath('last-word-settings-four-readings.png') });
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await page.getByRole('button', { name: '重读', exact: true }).click();
  await expect(page.locator('.ecg-beat-block')).toHaveCount(2);
  await page.getByRole('button', { name: '结束课堂', exact: true }).click();
  await page.getByRole('button', { name: '回到开始页', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await page.getByRole('button', { name: '下一词', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  for (let count = 0; count < 5; count++)
    await page.getByRole('button', { name: '下一词', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('take part in');
  await expect(page.locator('.ecg-beat-block')).toHaveCount(4);
  await page.screenshot({ path: info.outputPath('last-word-saved-four-readings.png') });
  expect(errors).toEqual([]);
});

for (const width of [1920, 720, 911]) {
  test(`${width}齐读1/8/32边界、批量保护、统一完成与固定操作可达`, async ({
    page,
    context,
  }, info) => {
    await context.setOffline(true);
    const height = width === 1920 ? 1080 : 480;
    await page.setViewportSize({ width, height });
    await page.goto(pathToFileURL(resolve('examples/高中单词节拍-学生自主齐读.html')).href);
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    const beats = page.getByLabel('每轮总拍数', { exact: true });
    for (const raw of ['', '0', '33', '1.5']) {
      await beats.fill(raw);
      await expect(page.getByRole('button', { name: '完成设置', exact: true })).toBeDisabled();
    }
    for (const raw of ['1', '8', '32']) {
      await beats.fill(raw);
      await expect(page.getByRole('button', { name: '完成设置', exact: true })).toBeEnabled();
      await expect(page.locator('.ecg-rounds-example')).toContainText(`每轮 ${raw} 拍`);
    }
    await expect(page.getByLabel('统一总拍数', { exact: true })).toBeVisible();
    await expect(page.getByLabel('统一每次占拍', { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /统一.*拍/ })).toHaveCount(0);
    await page.getByLabel('统一总拍数', { exact: true }).fill('8');
    // 当前词已明确手动指定32，批量必须保留，不能越过既有保护。
    await expect(beats).toHaveValue('32');
    await expect(page.locator('.ecg-rhythm-range')).toContainText('保留 1 个手动或锁定字段');
    // 拍数输入就是直接操作入口，截图保留其可视区，同时确认固定完成按钮不被正文滚动带走。
    await page.getByLabel('统一总拍数', { exact: true }).scrollIntoViewIfNeeded();
    // 1920×1080验收三栏管理布局；小窗只检查范围输入与固定完成操作可达，
    // 不要求不同职责区域在响应式布局中保持相同纵坐标。
    await expect(page.getByLabel('统一总拍数', { exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`settings-${width}.png`) });
    const complete = page.getByRole('button', { name: '完成设置', exact: true });
    const bounds = await complete.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    await complete.click();
    await page.reload();
    await page.getByRole('button', { name: '课堂设置', exact: true }).click();
    await expect(beats).toHaveValue('32');
    await page.getByRole('button', { name: '节奏与推进', exact: true }).click();
    await page.getByLabel('词间间隔', { exact: true }).fill('5');
    await expect(complete).toBeDisabled();
    for (const gap of ['4', '0']) {
      await page.getByLabel('词间间隔', { exact: true }).fill(gap);
      await expect(complete).toBeEnabled();
    }
    await complete.click();
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await page.getByRole('button', { name: '下一词', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.locator('.ecg-beat-block')).toHaveCount(4);
    await expect(page.locator('.ecg-beat-trail')).toHaveAttribute('aria-label', /32\s*拍/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  });
}

test('齐读范围常显真实混合值，直接编辑与独立还原不泄漏预览', async ({ page, context }, info) => {
  await context.setOffline(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(resolve('examples/高中单词节拍-学生自主齐读.html')).href);
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  const words = page.getByRole('listbox', { name: '选择要调整的词' });
  const scope = page.getByRole('combobox', { name: '统一调整范围' });
  const total = page.getByLabel('统一总拍数', { exact: true });
  const perRead = page.getByLabel('统一每次占拍', { exact: true });
  await expect(total).toHaveValue('4');
  await expect(perRead).toHaveValue('');
  await expect(page.getByRole('button', { name: '还原统一总拍数' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '还原统一每次占拍' })).toBeDisabled();
  await scope.selectOption('priority');
  await scope.selectOption('all');
  await expect(perRead).toHaveValue('');
  await expect(page.getByRole('button', { name: '放弃未完成输入' })).toHaveCount(0);
  const lastWord = words.getByRole('option').last();
  const lastWordId = await lastWord.getAttribute('data-entry-id');
  await lastWord.click();
  await expect(page.getByLabel('每轮总拍数', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
  await total.fill('8');
  await page.getByRole('button', { name: '还原统一总拍数' }).click();
  // 先明确还原范围目标，再逐词改为四次；逐词编辑会采用此前合法的范围预览，
  // 因此不能在逐词编辑后再把已落草稿的范围变化当作未应用目标撤回。
  await page.getByRole('combobox', { name: '每次朗读占用拍数' }).selectOption('1');
  await expect(page.getByLabel('每轮总拍数', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
  await perRead.selectOption('2');
  // 正式示例的每次占拍是教师手动安排，统一输入不能越过该保护。
  await expect(page.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
  await expect(page.locator('.ecg-rhythm-range')).toContainText(/保留\s+\d+\s+个手动或锁定字段/);
  await page.getByRole('button', { name: '还原统一每次占拍' }).click();
  await total.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('direct-rhythm-independent-reset.png') });
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await words.locator(`[data-entry-id="${lastWordId}"]`).click();
  await expect(page.getByLabel('每轮总拍数', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
  expect(errors).toEqual([]);
});
