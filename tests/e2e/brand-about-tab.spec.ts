/** 回归真实键盘输入、可离开性和关于页布局；不把填充 Tab 字符当作按键测试。 @author ahui */
import { expect, test } from '@playwright/test';

test('导入弹窗中 Ctrl+Enter 只移动焦点，Tab 不误触发关闭或提交', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '教学材料', exact: true }).click();
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  const input = dialog.getByRole('textbox', { name: '教学词表', exact: true });
  await input.fill('apple');
  await input.press('End');
  await input.press('Tab');
  await expect(input).toHaveValue('apple\t');
  await input.press('Control+Enter');
  await expect(dialog.getByRole('button', { name: '整理并预览', exact: true })).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('第 2 列用途', { exact: true })).toHaveCount(0);
});

test('词表 Tab 插入、撤销、选区替换和双向离开，阅读模式保持导航', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  const input = page.getByRole('textbox', { name: '教学词表', exact: true });
  await input.fill('apple');
  await input.press('End');
  await input.press('Tab');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('apple\t');
  await input.press('Control+z');
  await expect(input).toHaveValue('apple');
  await input.press('Tab');
  await input.pressSequentially('fruit');
  await input.press('Home');
  await input.press('Shift+End');
  await input.press('Tab');
  await expect(input).toHaveValue('\t');
  await input.press('Shift+Tab');
  await expect(input).not.toBeFocused();
  await input.focus();
  await input.press('Control+Enter');
  await expect(page.getByRole('button', { name: '整理并预览', exact: true })).toBeFocused();
  await expect(input).not.toBeFocused();
  await input.fill('apple');
  await input.press('End');
  await input.press('Tab');
  await input.pressSequentially('fruit');
  await page.getByRole('button', { name: '整理并预览', exact: true }).click();
  await expect(page.getByText('第 2 列用途', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '阅读选词', exact: true }).click();
  const reading = page.getByRole('textbox', { name: '高中阅读文本', exact: true });
  await reading.fill('A short reading.');
  await reading.press('Tab');
  await expect(reading).not.toBeFocused();
  await expect(reading).toHaveValue('A short reading.');
});

test('关于页许可、完整正文和源码下载离线可达', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '关于', exact: true }).click();
  await expect(page.getByText('V1.0.0', { exact: true })).toBeVisible();
  const summary = page.locator('.software-license > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: '下载播放器对应源码' })).toBeVisible();
  await page.getByText('GNU GPL v3 完整许可', { exact: true }).click();
  await expect(page.locator('.about-notices').first()).toContainText('Version 3, 29 June 2007');
  await page.getByText('GNU GPL v3 完整许可', { exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载播放器对应源码' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('portable-source.zip');
  await download.saveAs(testInfo.outputPath('downloaded-source.zip'));
  await page.screenshot({ path: testInfo.outputPath('about-license-1920.png'), fullPage: true });
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 720, height: 480 },
  ]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await expect(page.getByRole('button', { name: 'GitHub 仓库', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('关于页手动更新只在点击后请求，正确处理缺少发行、失败、重试与离页取消', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  let requests = 0;
  let status = 404;
  let hold = false;
  let release: (() => void) | undefined;
  await page.route(
    'https://api.github.com/repos/ahuiyuchuan/english-class-games/releases/latest',
    async (route) => {
      requests++;
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false }),
      });
    },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '关于', exact: true }).click();
  expect(requests).toBe(0);
  const update = page.getByRole('button', { name: '检查更新', exact: true });
  await update.click();
  await expect(
    page.getByText('GitHub 暂无可读取的公开正式发行信息，请到发行版本页面查看。'),
  ).toBeVisible();
  status = 403;
  await update.click();
  await expect(page.getByRole('alert')).toContainText('限制请求');
  status = 200;
  await update.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('未发现更高版本');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('about-github-1920.png'), fullPage: true });
  for (const [name, suffix] of [
    ['GitHub 仓库', ''],
    ['问题反馈', '/issues'],
    ['发行版本', '/releases'],
    ['下载本版本完整源码', '/releases/download/v1.0.0/English-Class-Games-v1.0.0-Source.zip'],
  ]) {
    await page.route(`https://github.com/ahuiyuchuan/english-class-games${suffix}`, (route) =>
      route.fulfill({ body: 'Official project destination' }),
    );
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name, exact: true }).click();
    const opened = await popup;
    await opened.waitForLoadState();
    expect(opened.url()).toBe(`https://github.com/ahuiyuchuan/english-class-games${suffix}`);
    expect(await opened.evaluate(() => window.opener)).toBe(null);
    await opened.close();
  }
  hold = true;
  await update.click();
  await expect(page.getByRole('button', { name: '正在检查更新…', exact: true })).toBeDisabled();
  await expect.poll(() => requests).toBe(4);
  await page.getByRole('button', { name: 'AI 工作台', exact: true }).click();
  release?.();
  await page.getByRole('button', { name: '关于', exact: true }).click();
  await expect(update).toBeEnabled();
  await expect(
    page.getByText('GitHub 正式版为 V1.0.0，当前为 V1.0.0，未发现更高版本。', { exact: true }),
  ).toHaveCount(0);
});
