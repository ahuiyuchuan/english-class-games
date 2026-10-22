/**
 * 从高中阅读原文到可携带成品的跨页面回归。所有数据经教师页面写入，
 * 仓库接口只读核对真实落盘快照；不预塞课件、不模拟配音或虚构声音复用。
 * @author ahui
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { MaterialCollection } from '../../src/platform/repository';
import type { TeachingEntry } from '../../src/platform/types';
import type { WordBeatLesson } from '../../src/games/word-beat/model';

const readingText =
  'Students explore amazing astronomy with an astronomer; they enjoy athletics, badminton and basketball. ' +
  'A biography describes bravery and the birthplace near a cathedral, where a carpenter can take part in a challenge by the bank.';
const selectedWords = [
  'amazing',
  'astronomy',
  'astronomer',
  'athletics',
  'badminton',
  'basketball',
  'biography',
  'bravery',
  'birthplace',
  'cathedral',
  'carpenter',
  'take part in',
  'challenge',
  'bank',
];

test.use({ actionTimeout: 10_000 });

/** 用键盘执行页面主动作，同时验证控件可聚焦；不据此宣称全部触控或无障碍验收已完成。 */
async function pressAction(control: Locator): Promise<void> {
  // 保存完成后才可聚焦；禁用按钮不会在稍后启用时自动获得焦点。
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Enter');
}

/** 宽布局通过可见主导航进入目标页；全部持久化仍走应用本身。 */
async function navigate(page: Page, name: string): Promise<void> {
  await pressAction(
    page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name, exact: true }),
  );
}

function lessonCard(page: Page, name: string): Locator {
  return page.locator('.lesson-card').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

/** 明确勾选候选并接受一个义项；空白默认值和键盘选词都在真实 DOM 中核对。 */
async function chooseReadingWords(scope: Locator, words: readonly string[]): Promise<void> {
  for (const english of words) {
    const selection = scope.getByRole('checkbox', { name: `选择${english}`, exact: true });
    await expect(selection).not.toBeChecked();
    const meanings = scope.getByRole('combobox', { name: `${english}候选义项`, exact: true });
    await expect(meanings).toHaveValue('');
    await selection.focus();
    await selection.press('Space');
    await meanings.selectOption('0');
    await expect(selection).toBeChecked();
  }
}

test('高中阅读经来源校对、常用词、建议与独立换课后导出真实离线课堂', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI 工作台', exact: true })).toBeVisible();
  await navigate(page, '教学材料');
  await pressAction(page.getByRole('button', { name: '导入材料', exact: true }));
  const importer = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  await pressAction(importer.getByRole('button', { name: '阅读选词', exact: true }));
  await importer.getByRole('textbox', { name: '高中阅读文本', exact: true }).fill(readingText);
  await pressAction(importer.getByRole('button', { name: '整理并预览', exact: true }));
  await expect(
    importer.getByRole('heading', { name: '阅读候选 · 0 项已选', exact: true }),
  ).toBeVisible();
  const bankMeanings = importer.getByRole('combobox', { name: 'bank候选义项', exact: true });
  await expect(bankMeanings).toContainText('银行');
  await expect(bankMeanings).toContainText('堤，岸');
  await chooseReadingWords(importer, selectedWords);
  await expect(importer.getByRole('textbox', { name: 'bank教学释义', exact: true })).toHaveValue(
    '银行',
  );
  const bankRow = importer.getByRole('row').filter({
    has: page.getByRole('combobox', { name: 'bank候选义项', exact: true }),
  });
  await bankRow.locator('summary').filter({ hasText: '查看原文' }).click();
  await expect(bankRow).toContainText('by the bank.');
  await pressAction(importer.getByRole('button', { name: '保存材料集', exact: true }));
  await expect(importer).not.toBeVisible();

  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  const details = page.getByRole('dialog', { name: '材料详情与校对', exact: true });
  await expect(details.getByRole('checkbox', { name: '选择 bank', exact: true })).toBeChecked();
  await pressAction(details.getByRole('button', { name: '所选词存为常用词', exact: true }));
  const common = page.getByRole('dialog', { name: '保存常用词 · 检查差异', exact: true });
  await expect(common.getByText('新增', { exact: true })).toHaveCount(14);
  await pressAction(common.getByRole('button', { name: '确认保存', exact: true }));
  await expect(common).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).not.toBeVisible();
  await pressAction(page.getByRole('tab', { name: '常用词库 · 14', exact: true }));
  const savedBank = page.getByRole('row').filter({
    has: page.getByRole('button', { name: '删除常用词bank', exact: true }),
  });
  await expect(savedBank.getByText('bank', { exact: true })).toBeVisible();
  await expect(savedBank.getByRole('cell', { name: '银行', exact: true })).toBeVisible();
  await pressAction(page.getByRole('tab', { name: '材料集 · 1', exact: true }));
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  await pressAction(details.getByRole('button', { name: '用于智能制作', exact: true }));

  const originalName = '高中阅读智能备课贯穿验收';
  await page.getByRole('textbox', { name: '课件名称', exact: true }).fill(originalName);
  await page.getByRole('combobox', { name: '练习模式', exact: true }).selectOption('teacher');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page
    .getByRole('spinbutton', { name: '目标时长（分钟，仅作建议依据）', exact: true })
    .fill('1');
  await page.getByText('声音、口号与材料设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '开场口号', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '收尾口号', exact: true }).uncheck();
  await pressAction(page.getByRole('button', { name: '一键制作', exact: true }));
  await expect(page.getByText('27 项已确认补全', { exact: true })).toBeVisible();
  await pressAction(page.getByRole('button', { name: '进入编辑', exact: true }));
  await expect(page.getByRole('heading', { name: '教学词表 · 14/100', exact: true })).toBeVisible();
  // 初始一轮不应凭空产生缩时建议；教师先明确选择多轮方案，再检查真实差异。
  await page.getByRole('combobox', { name: '练习预设', exact: true }).selectOption('focus');
  await page
    .getByRole('dialog', { name: '切换练习预设', exact: true })
    .getByRole('button', { name: '应用这些变化', exact: true })
    .click();
  await pressAction(page.getByRole('button', { name: '检查时间建议', exact: true }));
  await expect(
    page.getByRole('heading', { name: '调整练习以接近目标时长', exact: true }),
  ).toBeVisible();
  await page.getByRole('spinbutton', { name: '练习轮数', exact: true }).fill('4');
  await page.getByRole('checkbox', { name: '锁定轮数', exact: true }).check();
  await page.getByRole('textbox', { name: '教学释义', exact: true }).fill('令人惊叹的；本课修订');
  await page.getByText('查看来源与原文', { exact: true }).click();
  await expect(page.getByText(/原候选：amazing · 令人惊异的/u)).toBeVisible();
  await expect(page.getByText('教师修订', { exact: true }).first()).toBeVisible();

  // 先生成差异，修改不相干释义仍有效，再改其依赖锁定使旧差异失效。
  // 开场仅用于检查改编差异，随后明确关闭；从未伪造或请求缺失的系统声音。
  await page.getByText('声音、口号及导出设置', { exact: true }).click();
  const opening = page.locator('.property-group').filter({
    has: page.getByRole('textbox', { name: '开场口号文本', exact: true }),
  });
  await opening.getByRole('checkbox', { name: '开场口号', exact: true }).check();
  const sloganBefore = await opening
    .getByRole('textbox', { name: '开场口号文本', exact: true })
    .inputValue();
  await page.getByRole('button', { name: '换一版', exact: true }).click();
  const remixRange = page.getByRole('dialog', { name: '智能改编范围', exact: true });
  await pressAction(remixRange.getByRole('button', { name: '生成差异预览', exact: true }));
  const remix = page.locator('.suggestion').filter({
    has: page.getByRole('heading', { name: '换一版', exact: true }),
  });
  await expect(remix).toContainText('→');
  await expect(remix.getByRole('button', { name: '应用全部', exact: true })).toBeEnabled();
  await expect(opening.getByRole('textbox', { name: '开场口号文本', exact: true })).toHaveValue(
    sloganBefore,
  );
  await page
    .getByRole('textbox', { name: '教学释义', exact: true })
    .fill('令人惊叹的；教师再次校订');
  await expect(remix.getByRole('button', { name: '应用全部', exact: true })).toBeEnabled();
  await opening.getByRole('checkbox', { name: '锁定', exact: true }).check();
  await expect(remix.getByRole('button', { name: '需重新检查', exact: true })).toBeDisabled();
  await opening.getByRole('checkbox', { name: '开场口号', exact: true }).uncheck();
  await expect(page.getByRole('spinbutton', { name: '练习轮数', exact: true })).toHaveValue('4');
  await pressAction(page.getByRole('button', { name: '返回课件库', exact: true }));

  const copyName = '高中阅读词汇跟读'.repeat(10);
  await lessonCard(page, originalName)
    .getByRole('button', { name: `${originalName}更多操作`, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: originalName, exact: true })
    .getByRole('button', { name: '复制并改编', exact: true })
    .click();
  const copy = page.getByRole('dialog', { name: '复制并改编', exact: true });
  await copy.getByRole('textbox', { name: '副本名称', exact: true }).fill(copyName);
  await copy.getByRole('radio', { name: '替换材料', exact: true }).check();
  await pressAction(copy.getByRole('button', { name: '创建独立副本', exact: true }));
  const replacement = page.getByRole('dialog', { name: '替换教学材料', exact: true });
  await pressAction(replacement.getByRole('button', { name: '阅读选词', exact: true }));
  await replacement
    .getByRole('textbox', { name: '高中阅读文本', exact: true })
    .fill('Students take part in a challenge.');
  await pressAction(replacement.getByRole('button', { name: '整理并预览', exact: true }));
  await chooseReadingWords(replacement, ['take part in', 'challenge']);
  await expect(
    replacement
      .locator('[aria-label="教学内容来源与确认"]')
      .getByText('常用词', { exact: true })
      .filter({ visible: true }),
  ).toHaveCount(2);
  await pressAction(replacement.getByRole('button', { name: '确认内容', exact: true }));
  const replaceConfirmation = page.getByRole('dialog', { name: '确认替换材料', exact: true });
  await expect(replaceConfirmation).toContainText('14 条旧词');
  await expect(replaceConfirmation).toContainText('新 2 条');
  await pressAction(replaceConfirmation.getByRole('button', { name: '确认', exact: true }));
  await expect(page.getByRole('heading', { name: '教学词表 · 2/100', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: '练习轮数', exact: true })).toHaveValue('1');
  await expect(page.getByRole('checkbox', { name: '锁定轮数', exact: true })).not.toBeChecked();
  await pressAction(page.getByRole('button', { name: '导出课堂文件', exact: true }));
  const exporter = page.getByRole('dialog', { name: '导出课堂文件', exact: true });
  const confirmExport = exporter.getByRole('button', { name: '检查并导出', exact: true });
  // 保存和选版读取结束后再用键盘确认，不能尝试聚焦仍禁用的提交按钮。
  await expect(confirmExport).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await pressAction(confirmExport);
  const download = await downloadPromise;
  const artifact = testInfo.outputPath('高中阅读完整流程成品.html');
  await download.saveAs(artifact);
  const html = await readFile(artifact, 'utf8');
  const payload = JSON.parse(
    /<script id="ecg-data" type="application\/json">([^]*?)<\/script>/u.exec(html)![1],
  ) as {
    lesson: WordBeatLesson;
    assets: Record<string, unknown>;
  };
  expect(payload.lesson.name).toBe(copyName);
  expect(
    payload.lesson.gameData.segments.flatMap((segment) =>
      segment.entries.map((entry) => entry.english),
    ),
  ).toEqual(['take part in', 'challenge']);
  expect(payload.assets).toEqual({});
  expect(payload.lesson.gameData.soundMode).toBe('teacher');

  // 此处只读查看教师经页面写入的真实库，核对完整原文、常用词和原课保护，不创建任何夹具记录。
  const saved = (await page.evaluate(async () => {
    const path = '/src/platform/repository.ts';
    const repository = await import(path);
    return {
      materials: await repository.readAppData('materials', []),
      commonWords: await repository.readAppData('commonWords', []),
      lessons: await repository.listLessons(),
    };
  })) as {
    materials: MaterialCollection[];
    commonWords: TeachingEntry[];
    lessons: WordBeatLesson[];
  };
  expect(saved.materials[0].original).toBe(readingText);
  expect(saved.materials[0].entries.map((entry) => entry.english)).toEqual(selectedWords);
  expect(saved.commonWords).toHaveLength(14);
  const original = saved.lessons.find((lesson) => lesson.name === originalName)!;
  const originalEntries = original.gameData.segments.flatMap((segment) => segment.entries);
  expect(originalEntries).toHaveLength(14);
  expect(originalEntries[0]).toMatchObject({
    meaning: '令人惊叹的；教师再次校订',
    rounds: { value: 4, source: 'manual', locked: true },
  });
  expect(originalEntries.find((entry) => entry.english === 'bank')?.meaning).toBe('银行');
  expect(payload.lesson.id).not.toBe(original.id);
  expect(payload.lesson.gameData.segments[0].entries[0].meaningSource).toMatchObject({
    candidateSource: 'common',
    reviewStatus: 'reviewed-sense',
  });

  await context.setOffline(true);
  const portable = await context.newPage();
  const externalRequests: string[] = [];
  portable.on('request', (request) => {
    if (/^https?:/u.test(request.url())) externalRequests.push(request.url());
  });
  portable.on('pageerror', (error) => errors.push(error.message));
  await portable.goto(pathToFileURL(artifact).href);
  await portable.setViewportSize({ width: 911, height: 480 });
  await pressAction(portable.getByRole('button', { name: '开始课堂', exact: true }));
  const controls = portable.locator('footer');
  await pressAction(controls.getByRole('button', { name: '下一词', exact: true }).last());
  await pressAction(controls.getByRole('button', { name: '暂停', exact: true }));
  await expect(portable.getByRole('heading', { name: 'take part in', exact: true })).toBeVisible();
  // 方向键仅作用于课堂画面，不能劫持已有按钮和输入控件；先离开暂停按钮焦点。
  await portable.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await portable.keyboard.press('ArrowRight');
  await expect(portable.getByRole('heading', { name: 'challenge', exact: true })).toBeVisible();
  await expect(portable.getByText('已暂停', { exact: true })).toBeVisible();
  expect(await portable.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await portable.screenshot({ path: testInfo.outputPath('完整流程课堂-911x480.png') });
  await portable.reload();
  await expect(portable.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
  expect(await readFile(artifact, 'utf8')).toBe(html);
  await writeFile(
    testInfo.outputPath('reading-workflow-evidence.json'),
    `${JSON.stringify(
      {
        originalLessonId: original.id,
        copiedLessonId: payload.lesson.id,
        readingText,
        originalWordCount: originalEntries.length,
        commonWordCount: saved.commonWords.length,
        copiedWords: payload.lesson.gameData.segments.flatMap((segment) =>
          segment.entries.map((entry) => entry.english),
        ),
        soundMode: payload.lesson.gameData.soundMode,
        requiredAudioAssets: Object.keys(payload.assets).length,
        sha256: createHash('sha256').update(html).digest('hex'),
        browserVersion: context.browser()?.version(),
        externalRequests,
        pageErrors: errors,
        evidenceBoundary:
          '真实应用跨页面与下载文件的离线控制；应用Vite服务本例存在，无HTTP服务和真实配音由独立验收负责。',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});
