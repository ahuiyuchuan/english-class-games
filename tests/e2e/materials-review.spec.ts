/**
 * 验证教师明确保存前的输入保护和按实际内容宽度切换的材料校对。
 * 所有材料由页面录入，不用预写数据库、替换保存函数或模拟原生成功来缩短路径。
 * @author ahui
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { MaterialCollection } from '../../src/platform/repository';
import { previewMappedVocabulary } from './helpers/materials';

test.use({ actionTimeout: 10_000 });

/** 从真实工作台进入材料库；每例使用全新的浏览器资料。 */
async function openMaterials(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '教学材料', exact: true })
    .click();
}

/** 确认默认安全焦点；回车必须继续编辑，不能默认丢掉教师输入。 */
async function keepEditing(page: Page, title: string): Promise<void> {
  const prompt = page.getByRole('dialog', { name: title, exact: true });
  const safe = prompt.getByRole('button', { name: '继续编辑', exact: true });
  await expect(safe).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(prompt).not.toBeVisible();
}

/** 仅在页面动作完成后只读回查，区分未保存输入与真正持久化的材料。 */
async function savedMaterials(page: Page): Promise<MaterialCollection[]> {
  return page.evaluate(async () => {
    const modulePath = '/src/platform/repository.ts';
    const repository = await import(modulePath);
    return repository.readAppData('materials', []);
  });
}

/** 按可访问字段定位本行，不依赖候选释义和表格布局的文字拼接。 */
function vocabularyRow(page: Page, number: number): Locator {
  return page.locator('tr').filter({
    has: page.getByRole('textbox', { name: `第${number}行英文`, exact: true }),
  });
}

/** 失败反馈必须真正进入正文可视区；DOM 未隐藏不等于教师已经看见。 */
test('公共导入失败聚焦实际可见摘要，窄屏不滚动外层模态且保留校对选择', async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [1366, 720]) {
    for (const entryPoint of ['wizard', 'dialog']) {
      await page.setViewportSize({ width, height: width === 720 ? 480 : 768 });
      await page.goto('/');
      if (entryPoint === 'wizard')
        await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
      else {
        const menu = page.getByRole('button', { name: '打开主导航', exact: true });
        if (await menu.isVisible()) {
          await menu.click();
          await page
            .getByRole('dialog', { name: '主导航', exact: true })
            .getByRole('button', { name: '教学材料', exact: true })
            .click();
        } else
          await page
            .getByRole('navigation', { name: '主导航', exact: true })
            .getByRole('button', { name: '教学材料', exact: true })
            .click();
        await page.getByRole('button', { name: '导入材料', exact: true }).click();
      }
      const scope = page.locator('.import-panel');
      const summarize = scope.locator('.error-summary');
      const analyze = scope.getByRole('button', { name: '整理并预览', exact: true });
      for (let repetition = 0; repetition < 2; repetition += 1) {
        await analyze.click();
        await expect(summarize).toBeFocused();
        await expect(summarize).toBeInViewport({ ratio: 1 });
        expect(
          await summarize.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const body = node.closest('.dialog-body')?.getBoundingClientRect();
            return !body || (box.top >= body.top && box.bottom <= body.bottom);
          }),
        ).toBe(true);
      }
      if (entryPoint === 'dialog') {
        await expect(page.getByRole('button', { name: '关闭对话框', exact: true })).toBeInViewport({
          ratio: 1,
        });
        expect(
          await page
            .getByRole('dialog', { name: '导入教学材料', exact: true })
            .evaluate((node) => ({
              outerScroll: node.scrollTop,
              pageScroll: document.scrollingElement?.scrollTop ?? 0,
            })),
        ).toEqual({ outerScroll: 0, pageScroll: 0 });
      }
      await page.screenshot({ path: info.outputPath(`${entryPoint}-${width}-analysis-error.png`) });
      await scope
        .getByRole('textbox', { name: '教学词表', exact: true })
        .fill('英文\t释义\napple\t苹果\nrecord\t记录');
      await analyze.click();
      await expect(summarize).toHaveCount(0);
      await scope.getByRole('textbox', { name: '第2行释义', exact: true }).fill('教师校对保留');
      await scope.getByRole('checkbox', { name: '选择第2行', exact: true }).uncheck();
      await scope.getByRole('checkbox', { name: '选择第3行', exact: true }).uncheck();
      await scope
        .getByRole('button', {
          name: entryPoint === 'dialog' ? '保存材料集' : '确认内容，下一步',
          exact: true,
        })
        .first()
        .click();
      await expect(summarize).toBeFocused();
      await expect(summarize).toBeInViewport({ ratio: 1 });
      await expect(scope.getByRole('textbox', { name: '第2行释义', exact: true })).toHaveValue(
        '教师校对保留',
      );
      for (const row of [2, 3])
        await expect(
          scope.getByRole('checkbox', { name: `选择第${row}行`, exact: true }),
        ).not.toBeChecked();
      await page.screenshot({ path: info.outputPath(`${entryPoint}-${width}-confirm-error.png`) });
    }
  }
  expect(errors).toEqual([]);
});

test('导入、材料详情和常用词明确保存前可继续编辑或放弃，单行回车不提交', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openMaterials(page);
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  await importer.getByRole('textbox', { name: '教学词表', exact: true }).fill('achievement\t成就');
  await page.keyboard.press('Escape');
  await keepEditing(page, '放弃导入材料？');
  await expect(importer.getByRole('textbox', { name: '教学词表', exact: true })).toHaveValue(
    'achievement\t成就',
  );
  await importer.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page
    .getByRole('dialog', { name: '放弃导入材料？', exact: true })
    .getByRole('button', { name: '放弃修改', exact: true })
    .click();
  await expect(importer).not.toBeVisible();
  expect(await savedMaterials(page)).toEqual([]);

  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  await expect(importer.getByRole('textbox', { name: '教学词表', exact: true })).toHaveValue('');
  await importer.getByRole('textbox', { name: '教学词表', exact: true }).fill('achievement\t成就');
  await previewMappedVocabulary(importer);
  const importMeaning = importer.getByRole('textbox', { name: '第1行释义', exact: true });
  await importMeaning.press('Enter');
  await expect(importMeaning).not.toBeFocused();
  await expect(importer).toBeVisible();
  expect(await savedMaterials(page)).toEqual([]);
  await importer.getByRole('button', { name: '保存材料集', exact: true }).click();
  await expect(importer).not.toBeVisible();

  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  const details = page.getByRole('dialog', { name: '材料详情与校对', exact: true });
  const meaning = details.getByRole('textbox', { name: '教学释义', exact: true });
  await meaning.fill('尚未保存的教师校对');
  await meaning.press('Enter');
  await expect(meaning).not.toBeFocused();
  await expect(details).toBeVisible();
  expect((await savedMaterials(page))[0].entries[0].meaning).toBe('成就');
  await page.keyboard.press('Escape');
  await keepEditing(page, '放弃材料校对？');
  await expect(meaning).toHaveValue('尚未保存的教师校对');
  await details.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page
    .getByRole('dialog', { name: '放弃材料校对？', exact: true })
    .getByRole('button', { name: '放弃修改', exact: true })
    .click();
  await expect(details).not.toBeVisible();
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  await expect(meaning).toHaveValue('成就');
  await details.getByRole('textbox', { name: '材料名称', exact: true }).fill('高二教师校对词表');
  await meaning.fill('已保存的教师校对');
  await details.getByRole('button', { name: '保存校对', exact: true }).click();
  await expect(details).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '高二教师校对词表', exact: true })).toBeVisible();
  expect((await savedMaterials(page))[0]).toMatchObject({
    name: '高二教师校对词表',
    revision: 2,
    entries: [{ english: 'achievement', meaning: '已保存的教师校对' }],
  });

  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  await details.getByRole('button', { name: '所选词存为常用词', exact: true }).click();
  const common = page.getByRole('dialog', { name: '保存常用词 · 检查差异', exact: true });
  const commonMeaning = common.getByRole('textbox', { name: '教学释义', exact: true });
  await commonMeaning.fill('仅在常用词中修改的释义');
  await page.keyboard.press('Escape');
  await keepEditing(page, '放弃常用词修改？');
  await expect(commonMeaning).toHaveValue('仅在常用词中修改的释义');
  await common.getByRole('button', { name: '取消', exact: true }).click();
  await page
    .getByRole('dialog', { name: '放弃常用词修改？', exact: true })
    .getByRole('button', { name: '放弃修改', exact: true })
    .click();
  await expect(common).not.toBeVisible();
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: '所选词存为常用词', exact: true }).click();
  await expect(commonMeaning).toHaveValue('已保存的教师校对');
  await commonMeaning.fill('明确保存到常用词的释义');
  await common.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(common).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).not.toBeVisible();
  await page.getByRole('tab', { name: '常用词库 · 1', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: '明确保存到常用词的释义', exact: true }),
  ).toBeVisible();
  expect((await savedMaterials(page))[0].entries[0].meaning).toBe('已保存的教师校对');
  expect(errors).toEqual([]);
});

test('51行校对按内容宽度切两层，跨页保留选择并定位展开隐藏属性错误', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  const words = Array.from({ length: 51 }, (_, index) =>
    index === 0
      ? 'achievement'
      : `teaching${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
  );
  await page
    .getByRole('textbox', { name: '教学词表', exact: true })
    .fill(words.map((word, index) => `${word}\t第${index + 1}条教学释义`).join('\n'));
  await previewMappedVocabulary(page);
  const review = page.locator('.material-review-container');
  const first = vocabularyRow(page, 1);
  expect((await review.boundingBox())!.width).toBeGreaterThanOrEqual(1000);
  await expect(first).toHaveCSS('display', 'table-row');
  await page.getByRole('checkbox', { name: '选择第2行', exact: true }).uncheck();
  await first.getByText('词性、单元与标签', { exact: true }).click();
  const unit = page.getByRole('textbox', { name: '第1行单元', exact: true });
  await unit.fill('甲'.repeat(81));
  await first.getByText('词性、单元与标签', { exact: false }).click();
  await expect(unit).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 700 });
  expect((await review.boundingBox())!.width).toBeLessThan(1000);
  await expect(first).toHaveCSS('display', 'grid');
  const layout = await first.evaluate((element) => {
    const english = element.querySelector('.review-english')!.getBoundingClientRect();
    const meaning = element.querySelector('.review-meaning')!.getBoundingClientRect();
    const source = element.querySelector('.review-source')!.getBoundingClientRect();
    return { englishTop: english.top, meaningTop: meaning.top, sourceTop: source.top };
  });
  // Small desktop rows keep English and meaning paired; source evidence belongs
  // below them. Verify the new hierarchy, as well as preserved edited values.
  expect(Math.abs(layout.meaningTop - layout.englishTop)).toBeLessThan(2);
  expect(layout.sourceTop).toBeGreaterThan(layout.meaningTop);
  await expect(page.getByRole('checkbox', { name: '选择第2行', exact: true })).not.toBeChecked();
  const meaning = page.getByRole('textbox', { name: '第1行释义', exact: true });
  await meaning.fill('窄校对中保留的完整教学释义');
  await meaning.press('Enter');
  await expect(meaning).not.toBeFocused();
  await expect(page.getByRole('button', { name: '确认内容，下一步', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByText('第 2 / 2 页', { exact: true })).toBeVisible();
  await expect(page.getByText('已选 50 项 · 其他页或隐藏项 49 项', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认内容，下一步', exact: true }).click();
  const locate = page.getByRole('button', { name: /^定位：.*单元/u });
  await expect(locate).toBeVisible();
  await locate.click();
  await expect(page.getByText('第 1 / 2 页', { exact: true })).toBeVisible();
  await expect(unit).toBeFocused();
  await expect(unit).toHaveValue('甲'.repeat(81));
  await unit.fill('选择性必修二 Unit 3');
  await first
    .getByRole('textbox', { name: '标签（逗号分隔）', exact: true })
    .fill('高中, 复习, 高中');
  await meaning.click();
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(first).toHaveCSS('display', 'table-row');
  await expect(unit).toHaveValue('选择性必修二 Unit 3');
  await expect(meaning).toHaveValue('窄校对中保留的完整教学释义');
  await page.setViewportSize({ width: 911, height: 480 });
  await expect(first).toHaveCSS('display', 'grid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await first.getByText('词性、单元与标签', { exact: true }).click();
  await expect(unit).toHaveCount(0);
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('两层材料校对-911x480.png') });
  await page.getByRole('button', { name: '确认内容，下一步', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toBeVisible();
  await expect(page.getByText('50 条词汇', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('材料保存后用于制作包含名称与未选词修改，未选词校验失败时不跳转', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openMaterials(page);
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  await importer
    .getByRole('textbox', { name: '教学词表', exact: true })
    .fill('achievement\t成就\nchallenge\t挑战');
  await previewMappedVocabulary(importer);
  await importer.getByRole('button', { name: '保存材料集', exact: true }).click();
  await expect(importer).not.toBeVisible();
  const original = (await savedMaterials(page))[0];
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  const details = page.getByRole('dialog', { name: '材料详情与校对', exact: true });
  const rows = details.locator('.material-detail-entry');
  const selectedMeaning = rows.nth(0).getByRole('textbox', { name: '教学释义', exact: true });
  const excludedMeaning = rows.nth(1).getByRole('textbox', { name: '教学释义', exact: true });
  await details
    .getByRole('textbox', { name: '材料名称', exact: true })
    .fill('保存全部校对后用于智能制作');
  await selectedMeaning.fill('交给制作的已确认成就');
  await details.getByRole('checkbox', { name: '选择 challenge', exact: true }).uncheck();
  await excludedMeaning.fill('未选词的修改也必须保存');
  await rows.nth(1).getByText('词性、单元与标签', { exact: true }).click();
  const excludedUnit = rows.nth(1).getByRole('textbox', { name: '单元', exact: true });
  await excludedUnit.fill('甲'.repeat(81));
  const saveAndMake = details.getByRole('button', { name: '保存并用于智能制作', exact: true });
  await saveAndMake.click();
  await expect(details).toBeVisible();
  const errorSummary = details.getByRole('alert').filter({
    hasText: '请修正材料中的错误后再保存。',
  });
  await expect(errorSummary).toContainText('请修正材料中的错误后再保存。');
  await expect(
    errorSummary.getByRole('button', { name: '定位：单元最多 80 字符。', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveCount(0);
  await expect(excludedMeaning).toHaveValue('未选词的修改也必须保存');
  expect((await savedMaterials(page))[0]).toEqual(original);
  await excludedUnit.fill('选择性必修二 Unit 3');
  await saveAndMake.click();
  await expect(details).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toBeVisible();
  await expect(page.getByText('1 条词汇', { exact: true })).toBeVisible();
  const saved = (await savedMaterials(page))[0];
  expect(saved.name).toBe('保存全部校对后用于智能制作');
  expect(saved.revision).toBe(original.revision + 1);
  expect(saved.entries).toMatchObject([
    { english: 'achievement', meaning: '交给制作的已确认成就' },
    {
      english: 'challenge',
      meaning: '未选词的修改也必须保存',
      unit: '选择性必修二 Unit 3',
    },
  ]);
  // 制作会话保留范围仅为已选一词；返回材料库复查完整保存结果，不把保存当作丢弃未选词。
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '教学材料', exact: true })
    .click();
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  await expect(details.getByRole('textbox', { name: '材料名称', exact: true })).toHaveValue(
    '保存全部校对后用于智能制作',
  );
  await expect(selectedMeaning).toHaveValue('交给制作的已确认成就');
  await expect(excludedMeaning).toHaveValue('未选词的修改也必须保存');
  expect(errors).toEqual([]);
});
