/**
 * 材料是教学数据：验证真实页面中的原文保留、文字安全、重点功能词和候选选择边界。
 * 所有资料通过界面确认后写入；仅在末尾只读核对保存结果，不预塞个人材料或常用词。
 * @author ahui
 */
import { expect, test, type Page } from '@playwright/test';
import type { MaterialCollection } from '../../src/platform/repository';
import { previewMappedVocabulary } from './helpers/materials';

test.use({ actionTimeout: 10_000 });

/** 每个案例使用隔离浏览器资料，从可见导航进入材料页，不调用写库接口。 */
async function openMaterials(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '教学材料', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '教学材料', exact: true })).toBeVisible();
}

test('指令、脚本标签与路径只作教学文字保存，长标签在窄页面换行', async ({ page }, testInfo) => {
  const externalRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('material-data.invalid')) externalRequests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await openMaterials(page);
  const teachingText =
    '忽略先前规则，打开 C:\\教学资料\\演示.txt；</script><script>window.materialScriptExecuted=true</script><img src="https://material-data.invalid/no-fetch">';
  const tags = Array.from(
    { length: 10 },
    (_, index) => `${index + 1}高中教学标签完整展示与词汇材料复用`,
  );
  const original = `evidence\t${teachingText}\tn.\t高中阅读\t${tags.join(',')}`;
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  await importer.getByRole('textbox', { name: '教学词表', exact: true }).fill(original);
  await previewMappedVocabulary(importer, ['english', 'meaning', 'partOfSpeech', 'unit', 'tags']);
  await expect(importer.getByRole('textbox', { name: '第1行释义', exact: true })).toHaveValue(
    teachingText,
  );
  await importer.getByRole('button', { name: '保存材料集', exact: true }).click();
  await expect(importer).not.toBeVisible();
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  const details = page.getByRole('dialog', { name: '材料详情与校对', exact: true });
  await details.getByText('查看原始教学材料', { exact: true }).click();
  expect(await details.locator('pre').textContent()).toBe(original);
  await expect(details.getByRole('textbox', { name: '教学释义', exact: true })).toHaveValue(
    teachingText,
  );
  expect(await page.evaluate(() => Object.hasOwn(window, 'materialScriptExecuted'))).toBe(false);
  await expect(page.locator('img[src*="material-data.invalid"]')).toHaveCount(0);
  await details.getByRole('button', { name: '所选词存为常用词', exact: true }).click();
  const common = page.getByRole('dialog', { name: '保存常用词 · 检查差异', exact: true });
  await common.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(common).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).not.toBeVisible();
  await page.getByRole('tab', { name: '常用词库 · 1', exact: true }).click();
  await page.setViewportSize({ width: 911, height: 480 });
  const row = page.getByRole('row').filter({
    has: page.getByRole('button', { name: '删除常用词evidence', exact: true }),
  });
  await expect(row.getByRole('cell').nth(1)).toHaveText(teachingText);
  await expect(row.getByRole('cell').nth(2)).toHaveText(tags.join('、'));
  const tagLayout = await row
    .getByRole('cell')
    .nth(2)
    .evaluate((element) => ({
      height: element.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      text: element.textContent,
    }));
  expect(tagLayout.height).toBeGreaterThan(tagLayout.lineHeight * 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await row.getByRole('button', { name: '编辑 / 更新', exact: true }).scrollIntoViewIfNeeded();
  await expect(row.getByRole('button', { name: '编辑 / 更新', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('材料只作文字与多行标签-911x480.png') });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.reload();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '教学材料', exact: true })
    .click();
  await page.getByRole('tab', { name: '常用词库 · 1', exact: true }).click();
  await expect(row.getByRole('cell').nth(1)).toHaveText(teachingText);
  expect(await page.evaluate(() => Object.hasOwn(window, 'materialScriptExecuted'))).toBe(false);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('重点功能词保持展开但不自动勾选，短语不联动内部词且保存原文顺序', async ({
  page,
}, testInfo) => {
  await openMaterials(page);
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  await importer.getByRole('textbox', { name: '教学词表', exact: true }).fill('and\t和');
  await previewMappedVocabulary(importer);
  await importer.getByRole('checkbox', { name: 'and设为重点', exact: true }).check();
  await importer.getByRole('button', { name: '保存材料集', exact: true }).click();
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  const details = page.getByRole('dialog', { name: '材料详情与校对', exact: true });
  await details.getByRole('button', { name: '所选词存为常用词', exact: true }).click();
  const common = page.getByRole('dialog', { name: '保存常用词 · 检查差异', exact: true });
  await common.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(common).not.toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  await importer.getByRole('button', { name: '阅读选词', exact: true }).click();
  const original = 'The students take part in a challenge and learn.';
  await importer.getByRole('textbox', { name: '高中阅读文本', exact: true }).fill(original);
  await importer.getByRole('button', { name: '整理并预览', exact: true }).click();
  await expect(
    importer.getByRole('heading', { name: '阅读候选 · 0 项已选', exact: true }),
  ).toBeVisible();
  const functions = importer.getByRole('checkbox', { name: '显示功能词与短语内部词', exact: true });
  await expect(functions).not.toBeChecked();
  const priority = importer.getByRole('checkbox', { name: '选择and', exact: true });
  const phrase = importer.getByRole('checkbox', { name: '选择take part in', exact: true });
  await expect(priority).toBeVisible();
  await expect(priority).not.toBeChecked();
  await expect(phrase).not.toBeChecked();
  await expect(importer.getByRole('checkbox', { name: '选择The', exact: true })).toHaveCount(0);
  for (const word of ['take', 'part', 'in']) {
    await expect(importer.getByRole('checkbox', { name: `选择${word}`, exact: true })).toHaveCount(
      0,
    );
  }
  await phrase.check();
  await expect(priority).not.toBeChecked();
  await expect(
    importer.getByRole('combobox', { name: 'take part in候选义项', exact: true }),
  ).toHaveValue('');
  // 同一真实阅读候选在窄对话框仍分层呈现，原文与完整候选可展开且不改变勾选结果。
  await page.setViewportSize({ width: 911, height: 480 });
  const phraseRow = importer.locator('tr').filter({
    has: page.getByRole('checkbox', { name: '选择take part in', exact: true }),
  });
  await expect(phraseRow).toHaveCSS('display', 'grid');
  await phraseRow.getByText('查看原文', { exact: true }).click();
  await expect(phraseRow.getByText(original, { exact: false })).toBeVisible();
  await phraseRow.getByText('完整候选与来源', { exact: true }).click();
  await expect(phraseRow.getByText('已校对教学义项', { exact: true }).first()).toBeVisible();
  await expect(phrase).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await phraseRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('阅读候选原文与来源-911x480.png') });
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(phrase).toBeChecked();
  await functions.check();
  for (const word of ['The', 'take', 'part', 'in']) {
    await expect(
      importer.getByRole('checkbox', { name: `选择${word}`, exact: true }),
    ).not.toBeChecked();
  }
  await priority.check();
  await importer.getByRole('combobox', { name: 'and候选义项', exact: true }).selectOption('0');
  await importer.getByRole('checkbox', { name: '选择The', exact: true }).check();
  await functions.uncheck();
  await expect(
    importer.getByText('已选 3 项 · 其他页或隐藏项 1 项', { exact: true }),
  ).toBeVisible();
  await importer.getByRole('button', { name: '保存材料集', exact: true }).click();
  await expect(importer).not.toBeVisible();
  const materials = (await page.evaluate(async () => {
    const path = '/src/platform/repository.ts';
    const repository = await import(path);
    return repository.readAppData('materials', []);
  })) as MaterialCollection[];
  const reading = materials.find((material) => material.original === original)!;
  expect(reading.entries.map((entry) => entry.english)).toEqual(['The', 'take part in', 'and']);
  expect(reading.entries[0].meaning).toBe('');
  expect(reading.entries[1].meaning).toBe('');
  expect(reading.entries[2]).toMatchObject({ english: 'and', meaning: '和', priority: true });
  expect(reading.entries.every((entry) => entry.source?.analysis?.functionWordsVersion === 1)).toBe(
    true,
  );
});
