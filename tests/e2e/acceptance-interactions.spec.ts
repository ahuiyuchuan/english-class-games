/**
 * 补齐规则单测以外的真实编辑交互证据。全部课件由页面录入、制作和保存，
 * 只在保存后读取资料库核对来源与历史；不预塞成品，也不模拟配音成功。
 * @author ahui
 */
import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { WordBeatLesson } from '../../src/games/word-beat/model';
import { previewMappedVocabulary } from './helpers/materials';

const vocabulary = 'achievement\t成就\nconcentrate\t集中注意力\nresponsibility\t责任';
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI 工作台', exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

/** 无音色时的正式文字领读制作路径；口号关闭后没有声音需求。 */
async function makeTeacherLesson(page: Page, name: string, text = vocabulary): Promise<void> {
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  await page.getByRole('textbox', { name: '教学词表', exact: true }).fill(text);
  await previewMappedVocabulary(page);
  await page.getByRole('button', { name: '确认内容，下一步', exact: true }).click();
  await page.getByRole('textbox', { name: '课件名称', exact: true }).fill(name);
  await page.getByRole('combobox', { name: '练习模式', exact: true }).selectOption('teacher');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('声音、口号与材料设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '开场口号', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '收尾口号', exact: true }).uncheck();
  await page.getByRole('button', { name: '一键制作', exact: true }).click();
  await page.getByRole('button', { name: '进入编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(name);
}

/** 英文可能含连字符和正则符号，转义后只匹配可操作的词条行。 */
function entry(page: Page, english: string): Locator {
  const escaped = english.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return page.getByRole('button', {
    name: new RegExp(`^(?:重点 · )?${escaped}(?:\\s|$)`, 'u'),
  });
}

function suggestion(page: Page, title: string): Locator {
  return page.locator('.suggestion').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}

/** 返回库会等待编辑器 flush；重载后再从库进入，验证实际持久化而非内存状态。 */
async function saveReloadReopen(page: Page, name: string): Promise<WordBeatLesson> {
  await page.getByRole('button', { name: '返回课件库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的课件', exact: true })).toBeVisible();
  const saved = await page.evaluate(async (lessonName) => {
    const path = '/src/platform/repository.ts';
    const repository = await import(path);
    const lessons = await repository.listLessons();
    return lessons.find((lesson: { name: string }) => lesson.name === lessonName);
  }, name);
  expect(saved).toBeDefined();
  await page.reload();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '我的课件', exact: true })
    .click();
  await page
    .locator('.lesson-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(name);
  return saved as WordBeatLesson;
}

/** 将实际落盘内容与浏览器版本写入每例证据，不把截图当作来源字段的证明。 */
async function recordEvidence(
  page: Page,
  testInfo: TestInfo,
  evidence: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    testInfo.outputPath('interaction-evidence.json'),
    `${JSON.stringify({ browser: page.context().browser()?.version(), ...evidence }, null, 2)}\n`,
    'utf8',
  );
  await page.screenshot({ path: testInfo.outputPath('interaction.png'), fullPage: true });
}

/** 每次显式设置全部范围选项，避免上次取消的界面选项影响当前验收意图。 */
async function remixRange(
  page: Page,
  options: { manualSlogans?: boolean; shuffle?: boolean; restore?: boolean; manual?: boolean } = {},
): Promise<Locator> {
  await page.getByRole('button', { name: '换一版', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '智能改编范围', exact: true });
  await dialog
    .getByRole('checkbox', { name: '允许替换手改口号', exact: true })
    .setChecked(options.manualSlogans ?? false);
  await dialog
    .getByRole('checkbox', { name: '同时调整段内未锁定词序', exact: true })
    .setChecked(options.shuffle ?? false);
  await dialog
    .getByRole('checkbox', { name: '恢复由预设管理的参数', exact: true })
    .setChecked(options.restore ?? false);
  await dialog
    .getByRole('checkbox', { name: '明确允许恢复未锁定的教师手动参数', exact: true })
    .setChecked(options.manual ?? false);
  return dialog;
}

test('AI-03 / UI-08：类型修正与字段校验经保存重开，窄屏问题定位打开属性并聚焦', async ({
  page,
}, testInfo) => {
  const name = '连字符短语与错误定位';
  await makeTeacherLesson(
    page,
    name,
    'well-known\t著名的\nsharpen critical thinking\t培养批判性思维\nresponsibility\t责任',
  );
  await expect(page.getByRole('combobox', { name: '词条类型', exact: true })).toHaveValue('word');
  await expect(page.getByRole('spinbutton', { name: '教师示范拍数', exact: true })).toHaveValue(
    '2',
  );
  await page.getByRole('combobox', { name: '词条类型', exact: true }).selectOption('phrase');
  await expect(page.getByRole('spinbutton', { name: '教师示范拍数', exact: true })).toHaveValue(
    '3',
  );
  await expect(page.getByText('来源：教师手动', { exact: true })).toBeVisible();

  await entry(page, 'sharpen critical thinking').click();
  await expect(page.getByRole('combobox', { name: '词条类型', exact: true })).toHaveValue('phrase');
  await expect(page.getByRole('spinbutton', { name: '教师示范拍数', exact: true })).toHaveValue(
    '3',
  );
  await page.getByRole('combobox', { name: '词条类型', exact: true }).selectOption('word');
  await expect(page.getByRole('spinbutton', { name: '教师示范拍数', exact: true })).toHaveValue(
    '2',
  );

  await entry(page, 'responsibility').click();
  await page.getByRole('spinbutton', { name: '教师示范拍数', exact: true }).fill('7');
  await page.getByRole('checkbox', { name: '锁定教师示范拍数', exact: true }).check();
  await page.getByRole('combobox', { name: '词条类型', exact: true }).selectOption('phrase');
  await expect(page.getByRole('spinbutton', { name: '教师示范拍数', exact: true })).toHaveValue(
    '7',
  );
  await page.getByRole('textbox', { name: '词性', exact: true }).fill('n.');
  await page.getByRole('textbox', { name: '单元', exact: true }).fill('高二单元'.repeat(21));
  await page.setViewportSize({ width: 911, height: 480 });
  await expect(page.getByRole('dialog', { name: '词条属性', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '课堂预览', exact: true }).click();
  await page.getByRole('button', { name: /^检查（/u }).click();
  const issue = page.locator('.issue-button').filter({ hasText: /单元/u });
  await expect(issue).toHaveCount(1);
  await issue.click();
  const properties = page.getByRole('dialog', { name: '词条属性', exact: true });
  await expect(properties).toBeVisible();
  const unit = properties.getByRole('textbox', { name: '单元', exact: true });
  await expect(unit).toBeFocused();
  await expect(unit).toHaveValue('高二单元'.repeat(21));
  await unit.fill('高中必修二 Unit 3');
  await properties.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(issue).toHaveCount(0);
  await page.setViewportSize({ width: 1600, height: 900 });

  const saved = await saveReloadReopen(page, name);
  const entries = saved.gameData.segments.flatMap((segment) => segment.entries);
  expect(entries.map((item) => [item.english, item.entryType, item.entryTypeSource])).toEqual([
    ['well-known', 'phrase', 'manual'],
    ['sharpen critical thinking', 'word', 'manual'],
    ['responsibility', 'phrase', 'manual'],
  ]);
  expect(entries.map((item) => item.modelBeats.value)).toEqual([3, 2, 7]);
  expect(entries[2].modelBeats).toMatchObject({ value: 7, source: 'manual', locked: true });
  expect(entries[2]).toMatchObject({ partOfSpeech: 'n.', unit: '高中必修二 Unit 3' });
  await entry(page, 'responsibility').click();
  await expect(page.getByRole('textbox', { name: '单元', exact: true })).toHaveValue(
    '高中必修二 Unit 3',
  );
  await recordEvidence(page, testInfo, { saved });
});

// 每个目标保留完整前序切换，并独立验证一次冷重开；避免三次冷加载共用45秒。
// 不从存储预塞课件、不增加超时或重试，手动值和锁定值仍由真实页面逐项设置。
const presetTransitions = [
  { preset: 'focus', bpm: '90', rounds: '4' },
  { preset: 'quick', bpm: '110', rounds: '2' },
  { preset: 'regular', bpm: '100', rounds: '3' },
];
for (const [index, target] of presetTransitions.entries()) {
  test(`AI-05 / AI-08：连续切换至${target.preset}后保存重开，手动与锁定参数受保护`, async ({
    page,
  }, testInfo) => {
    const name = `三预设来源及锁定保护-${target.preset}`;
    await makeTeacherLesson(page, name);
    await page.getByRole('spinbutton', { name: '练习轮数', exact: true }).fill('4');
    await page.getByRole('combobox', { name: '跟读拍数来源', exact: true }).selectOption('manual');
    await page.getByRole('spinbutton', { name: '固定跟读拍数', exact: true }).fill('6');
    await page.getByRole('spinbutton', { name: '教师示范拍数', exact: true }).fill('5');
    await entry(page, 'concentrate').click();
    await page.getByRole('checkbox', { name: '锁定轮数', exact: true }).check();
    await page.getByRole('checkbox', { name: '锁定跟读设置', exact: true }).check();
    await page.getByRole('checkbox', { name: '锁定教师示范拍数', exact: true }).check();
    await entry(page, 'responsibility').click();
    await page.getByRole('checkbox', { name: '重点词', exact: true }).check();

    const transitions = presetTransitions.slice(0, index + 1);
    for (const item of transitions) {
      await page.getByRole('combobox', { name: '练习预设', exact: true }).selectOption(item.preset);
      const diff = page.getByRole('dialog', { name: '切换练习预设', exact: true });
      await expect(diff).toContainText('教师手动值与锁定项保留');
      await diff.getByRole('button', { name: '应用这些变化', exact: true }).click();
      await expect(page.getByRole('spinbutton', { name: '节奏 BPM', exact: true })).toHaveValue(
        item.bpm,
      );
      await expect(entry(page, 'achievement')).toContainText('4 轮');
      await expect(entry(page, 'concentrate')).toContainText('1 轮');
      await expect(entry(page, 'responsibility')).toContainText(`${item.rounds} 轮`);
    }
    const saved = await saveReloadReopen(page, name);
    const [manual, locked, managed] = saved.gameData.segments.flatMap((segment) => segment.entries);
    expect(manual.rounds).toMatchObject({ value: 4, source: 'manual', locked: false });
    expect(manual.follow).toMatchObject({ mode: 'manual', beats: 6, locked: false });
    expect(manual.modelBeats).toMatchObject({ value: 5, source: 'manual', locked: false });
    expect(locked.rounds).toMatchObject({ value: 1, source: 'preset', locked: true });
    expect(locked.follow).toMatchObject({ mode: 'preset', preset: 'regular', locked: true });
    expect(locked.modelBeats).toMatchObject({ value: 2, source: 'preset', locked: true });
    expect(managed.rounds).toMatchObject({
      value: Number(target.rounds),
      source: 'preset',
      locked: false,
    });
    expect(managed.follow).toMatchObject({ mode: 'preset', preset: target.preset, locked: false });
    expect(saved.gameData.preset).toBe(target.preset);
    await recordEvidence(page, testInfo, { transitions, saved });
  });
}

test('AI-10：时长不足不填充，无可变项的改编只反馈且不伪造建议', async ({ page }, testInfo) => {
  const name = '无可变项真实反馈';
  await makeTeacherLesson(page, name);
  await page.getByRole('button', { name: '检查时间建议', exact: true }).click();
  await expect(
    page.getByText('检查完成，当前没有可应用的时间调整建议。', { exact: true }),
  ).toBeVisible();
  const range = await remixRange(page);
  await range.getByRole('button', { name: '生成差异预览', exact: true }).click();
  await expect(page.getByText('当前没有可变项或实际差异。', { exact: true })).toBeVisible();
  await expect(suggestion(page, '换一版')).toHaveCount(0);
  await expect(suggestion(page, '调整练习以接近目标时长')).toHaveCount(0);
  const saved = await saveReloadReopen(page, name);
  expect(
    saved.gameData.segments.flatMap((segment) => segment.entries).map((item) => item.rounds.value),
  ).toEqual([1, 1, 1]);
  expect(saved.gameData.segments.flatMap((segment) => segment.entries)).toHaveLength(3);
  expect(saved.gameData.suggestionHistory ?? []).toEqual([]);
  await recordEvidence(page, testInfo, { saved });
});

test('AI-12：改编范围可取消，预览不写值，明确授权后应用且一次撤销全部变化', async ({
  page,
}, testInfo) => {
  const name = '改编范围应用撤销';
  await makeTeacherLesson(page, name);
  await page.getByRole('spinbutton', { name: '练习轮数', exact: true }).fill('5');
  await entry(page, 'concentrate').click();
  await page.getByRole('spinbutton', { name: '练习轮数', exact: true }).fill('4');
  await page.getByRole('checkbox', { name: '锁定轮数', exact: true }).check();
  await page.getByText('声音、口号及导出设置', { exact: true }).click();
  const opening = page
    .locator('.property-group')
    .filter({ has: page.getByRole('textbox', { name: '开场口号文本', exact: true }) });
  const closing = page
    .locator('.property-group')
    .filter({ has: page.getByRole('textbox', { name: '收尾口号文本', exact: true }) });
  // 只检查编辑差异，不调用准备、播放或导出；没有把尚未制作的声音标为成功。
  await opening.getByRole('checkbox', { name: '开场口号', exact: true }).check();
  await opening
    .getByRole('textbox', { name: '开场口号文本', exact: true })
    .fill('教师自定开场，请保留。');
  await closing.getByRole('checkbox', { name: '收尾口号', exact: true }).check();
  await closing
    .getByRole('textbox', { name: '收尾口号文本', exact: true })
    .fill('教师锁定收尾，请保留。');
  await closing.getByRole('checkbox', { name: '锁定', exact: true }).check();

  let range = await remixRange(page, { manualSlogans: true, restore: true, manual: true });
  await range.getByRole('button', { name: '取消', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('5 轮');
  await expect(opening.getByRole('textbox', { name: '开场口号文本', exact: true })).toHaveValue(
    '教师自定开场，请保留。',
  );
  await expect(suggestion(page, '换一版')).toHaveCount(0);
  range = await remixRange(page);
  await range.getByRole('button', { name: '生成差异预览', exact: true }).click();
  await expect(page.getByText('当前没有可变项或实际差异。', { exact: true })).toBeVisible();
  range = await remixRange(page, { manualSlogans: true, restore: true, manual: true });
  await range.getByRole('button', { name: '生成差异预览', exact: true }).click();
  const diff = suggestion(page, '换一版');
  await expect(diff.getByRole('button', { name: '应用全部', exact: true })).toBeEnabled();
  await expect(diff).toContainText('恢复允许修改的练习轮数');
  await expect(entry(page, 'achievement')).toContainText('5 轮');
  await expect(opening.getByRole('textbox', { name: '开场口号文本', exact: true })).toHaveValue(
    '教师自定开场，请保留。',
  );
  await diff.getByRole('button', { name: '应用全部', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('2 轮');
  await expect(entry(page, 'concentrate')).toContainText('4 轮');
  const changedOpening = await opening
    .getByRole('textbox', { name: '开场口号文本', exact: true })
    .inputValue();
  expect(changedOpening).not.toBe('教师自定开场，请保留。');
  await expect(closing.getByRole('textbox', { name: '收尾口号文本', exact: true })).toHaveValue(
    '教师锁定收尾，请保留。',
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('5 轮');
  await expect(entry(page, 'concentrate')).toContainText('4 轮');
  await expect(opening.getByRole('textbox', { name: '开场口号文本', exact: true })).toHaveValue(
    '教师自定开场，请保留。',
  );
  await diff.getByRole('button', { name: '应用全部', exact: true }).click();
  const saved = await saveReloadReopen(page, name);
  const [restored, locked] = saved.gameData.segments.flatMap((segment) => segment.entries);
  expect(restored.rounds).toMatchObject({ value: 2, source: 'preset', locked: false });
  expect(locked.rounds).toMatchObject({ value: 4, source: 'manual', locked: true });
  expect(saved.gameData.slogans.opening).toMatchObject({
    text: changedOpening,
    textSource: 'template',
  });
  expect(saved.gameData.slogans.closing).toMatchObject({
    text: '教师锁定收尾，请保留。',
    textSource: 'manual',
    locked: true,
  });
  expect(
    saved.gameData.suggestionHistory?.filter(
      (item) => item.kind === 'remix' && item.state === 'applied',
    ),
  ).toHaveLength(1);
  await recordEvidence(page, testInfo, { saved });
});

test('AI-16：忽略仅保留当前依赖决定，保存重开后改相关输入可重新建议并应用', async ({
  page,
}, testInfo) => {
  const name = '忽略后重新建议';
  const words = [
    'achievement',
    'challenge',
    'cooperation',
    'responsibility',
    'knowledge',
    'concentrate',
    'opportunity',
    'education',
    'environment',
    'development',
    'confidence',
    'experience',
  ];
  await makeTeacherLesson(
    page,
    name,
    words.map((word, index) => `${word}\t教学义项${index + 1}`).join('\n'),
  );
  // 新词默认一轮已在目标内；明确采用重点强化，构造有真实可缩减安排的测试。
  await page.getByRole('combobox', { name: '练习预设', exact: true }).selectOption('focus');
  await page
    .getByRole('dialog', { name: '切换练习预设', exact: true })
    .getByRole('button', { name: '应用这些变化', exact: true })
    .click();
  await page.getByText('声音、口号及导出设置', { exact: true }).click();
  await page.getByRole('spinbutton', { name: '目标时长（分钟）', exact: true }).fill('1');
  await page.getByRole('button', { name: '检查时间建议', exact: true }).click();
  const allTime = suggestion(page, '调整练习以接近目标时长');
  let available = allTime.filter({
    has: page.getByRole('button', { name: '应用全部', exact: true }),
  });
  await expect(available).toHaveCount(1);
  await page.getByRole('textbox', { name: '教学释义', exact: true }).fill('无关词义修订保留建议');
  await expect(available.getByRole('button', { name: '应用全部', exact: true })).toBeEnabled();
  await available.getByRole('button', { name: '忽略', exact: true }).click();
  await expect(allTime.getByRole('button', { name: '已忽略', exact: true })).toBeDisabled();
  const ignored = await saveReloadReopen(page, name);
  expect(
    ignored.gameData.suggestionHistory?.filter(
      (item) => item.kind === 'time' && item.state === 'ignored',
    ),
  ).toHaveLength(1);
  await page.getByRole('button', { name: '检查时间建议', exact: true }).click();
  await expect(allTime.getByRole('button', { name: '已忽略', exact: true })).toBeDisabled();
  await expect(allTime.getByRole('button', { name: '应用全部', exact: true })).toHaveCount(0);

  await page.getByRole('spinbutton', { name: '节奏 BPM', exact: true }).fill('80');
  await expect(allTime.getByRole('button', { name: '需重新检查', exact: true })).toBeDisabled();
  // 相关输入变化只改变旧建议状态，不在后台偷偷生成或应用新差异。
  await expect(allTime.getByRole('button', { name: '应用全部', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查时间建议', exact: true }).click();
  available = allTime.filter({ has: page.getByRole('button', { name: '应用全部', exact: true }) });
  await expect(available).toHaveCount(1);
  await available.getByRole('button', { name: '应用全部', exact: true }).click();
  const applied = await saveReloadReopen(page, name);
  const entries = applied.gameData.segments.flatMap((segment) => segment.entries);
  expect(entries.some((item) => item.rounds.value === 1 && item.rounds.source === 'manual')).toBe(
    true,
  );
  expect(entries).toHaveLength(12);
  expect(entries[0].meaning).toBe('无关词义修订保留建议');
  expect(applied.gameData.bpm).toMatchObject({ value: 80, source: 'manual' });
  expect(
    applied.gameData.suggestionHistory?.filter(
      (item) => item.kind === 'time' && item.state === 'applied',
    ),
  ).toHaveLength(1);
  await recordEvidence(page, testInfo, { ignored, applied });
});
