/** 实际跨页面备课、保存与下载验收，不用静态 mock 成功替代课堂成品。 @author ahui */
import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { previewMappedVocabulary } from './helpers/materials';

test('词表校对 → 文字领读 → 编辑保存 → 下载实际 HTML → 离线打开', async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI 工作台', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  await page
    .getByRole('textbox', { name: '教学词表', exact: true })
    .fill('achievement\t成就\nmake a difference\t产生影响');
  await previewMappedVocabulary(page);
  await expect(page.getByRole('heading', { name: '校对 2 条教学内容' })).toBeVisible();
  await page.getByRole('button', { name: '确认内容，下一步', exact: true }).click();
  await page.getByRole('textbox', { name: '课件名称', exact: true }).fill('高中课堂离线验收');
  await page.getByLabel('练习模式', { exact: true }).selectOption('teacher');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('声音、口号与材料设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '开场口号', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '收尾口号', exact: true }).uncheck();
  await page.getByRole('button', { name: '一键制作', exact: true }).click();
  await page.getByRole('button', { name: '进入编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(
    '高中课堂离线验收',
  );
  await page.getByRole('textbox', { name: '词条英文', exact: true }).fill('achievement');
  await page.getByRole('textbox', { name: '教学释义', exact: true }).fill('成就；成绩');
  await expect(page.getByText('成就；成绩', { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('editor-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '导出课堂文件', exact: true }).click();
  const exporter = page.getByRole('dialog', { name: '导出课堂文件', exact: true });
  // 打开选版界面不等于开始导出；确认当前版本后才等待实际下载事件。
  const confirmExport = exporter.getByRole('button', { name: '检查并导出', exact: true });
  await expect(confirmExport).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await confirmExport.click();
  const download = await downloadPromise;
  const artifact = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(artifact);
  const portable = await context.newPage();
  portable.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  await portable.goto(pathToFileURL(artifact).href);
  await expect(portable.getByText('高中课堂离线验收', { exact: true }).first()).toBeVisible();
  await expect(portable.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
  await portable.screenshot({ path: testInfo.outputPath('portable-start.png') });
  expect(errors).toEqual([]);
});

test('备课导航在小视口可用，主动作不超出可用宽度', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 911, height: 480 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开主导航' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '游戏库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '游戏库', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '单词节拍', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '制作课件', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('game-library-compact.png'), fullPage: true });
});
