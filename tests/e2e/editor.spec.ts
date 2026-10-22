/**
 * 独立浏览器会话中的真实备课与编辑验收。材料、制作、保存和复制均通过页面完成，
 * 不向 IndexedDB 预塞成品，不模拟系统配音成功；文字领读用于验证无音色时的正式流程。
 * @author ahui
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { previewMappedVocabulary } from './helpers/materials';

const vocabulary = 'achievement\t成就\nconcentrate\t集中注意力\nresponsibility\t责任';
const pageErrors = new WeakMap<Page, string[]>();

/** 每例由 Playwright 提供新的浏览器上下文，避免课件或默认值在案例之间串用。 */
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

/** 通过同一个导航入口适配常规侧栏与缩小窗口后的抽屉，不点击不可见的旧节点。 */
async function navigate(page: Page, name: string): Promise<void> {
  const compactMenu = page.getByRole('button', { name: '打开主导航', exact: true });
  if (await compactMenu.isVisible()) {
    await compactMenu.click();
    await page
      .getByRole('dialog', { name: '主导航', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  } else {
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  }
}

/** 从教师词表创建可上课的真实文字领读课件；关闭口号避免依赖浏览器没有的系统配音。 */
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
  await expect(page.getByRole('button', { name: '返回课件库', exact: true })).toBeVisible();
}

/** 词条按钮同时包含英文、释义和轮数；使用可访问名称选择，避免把静态预览当成编辑对象。 */
function entry(page: Page, english: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^(?:重点 · )?${english}(?:\\s|$)`, 'u') });
}

function lessonCard(page: Page, name: string): Locator {
  return page.locator('.lesson-card').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

async function returnToLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: '返回课件库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的课件', exact: true })).toBeVisible();
}

test('制作会话跨页面保留校对选择、课件名、预设及本次参数', async ({ page }) => {
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  await page.getByRole('textbox', { name: '教学词表', exact: true }).fill(vocabulary);
  await previewMappedVocabulary(page);
  await page.getByRole('checkbox', { name: '选择第2行', exact: true }).uncheck();
  await navigate(page, '教学材料');
  await expect(page.getByRole('heading', { name: '教学材料', exact: true })).toBeVisible();
  await navigate(page, 'AI 工作台');
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  await page.getByRole('button', { name: '查看或修改原文与列设置' }).click();
  await expect(page.getByRole('textbox', { name: '教学词表', exact: true })).toHaveValue(
    vocabulary,
  );
  await expect(page.getByRole('checkbox', { name: '选择第2行', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '确认内容，下一步', exact: true }).click();
  await page.getByRole('textbox', { name: '课件名称', exact: true }).fill('保留中的高二词汇课');
  await page.getByRole('radio', { name: /重点强化/u }).click();
  await page
    .getByRole('dialog', { name: '确认切换练习预设', exact: true })
    .getByRole('button', { name: '应用预设', exact: true })
    .click();
  await page
    .getByRole('spinbutton', { name: '目标时长（分钟，仅作建议依据）', exact: true })
    .fill('7');
  await page.getByRole('combobox', { name: '练习模式', exact: true }).selectOption('teacher');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await navigate(page, '游戏库');
  await page.getByRole('button', { name: '制作课件', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(
    '保留中的高二词汇课',
  );
  await expect(page.getByRole('radio', { name: /重点强化/u })).toBeChecked();
  await expect(
    page.getByRole('spinbutton', { name: '目标时长（分钟，仅作建议依据）', exact: true }),
  ).toHaveValue('7');
  await expect(page.getByRole('combobox', { name: '练习模式', exact: true })).toHaveValue(
    'teacher',
  );
  await expect(page.getByText('2 条词汇', { exact: true })).toBeVisible();
});

test('错误数字随草稿保存重开，不能借上次合法数值开始课堂', async ({ page }) => {
  const name = '错误输入保留验收';
  await makeTeacherLesson(page, name);
  await page.getByRole('spinbutton', { name: '节奏 BPM', exact: true }).fill('999');
  await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toHaveCount(0);
  await expect(page.getByText('请输入 50～180 的整数。', { exact: true }).first()).toBeVisible();
  await returnToLibrary(page);
  await lessonCard(page, name).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '节奏 BPM', exact: true })).toHaveValue('999');
  await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: '节奏 BPM', exact: true }).fill('100');
  await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
});

/** 建议理由与定位操作分离；窄屏从建议抽屉进入属性时不能丢失焦点或悄悄应用方案。 */
test('真实时间建议可明确定位差异字段，宽窄屏均不自动应用', async ({ page }, info) => {
  const words = Array.from({ length: 20 }, (_, index) => `word${index}\t教学词${index}`).join('\n');
  await makeTeacherLesson(page, '时间建议定位复查', words);
  await page.getByRole('combobox', { name: '练习预设', exact: true }).selectOption('focus');
  await page
    .getByRole('dialog', { name: '切换练习预设', exact: true })
    .getByRole('button', { name: '应用这些变化', exact: true })
    .click();
  await page.getByText('声音、口号及导出设置', { exact: true }).click();
  await page.getByRole('spinbutton', { name: '目标时长（分钟）', exact: true }).fill('1');
  await page.getByRole('button', { name: '检查时间建议', exact: true }).click();
  const card = page.locator('.suggestion').filter({
    has: page.getByRole('heading', { name: '调整练习以接近目标时长', exact: true }),
  });
  await expect(card.getByRole('button', { name: /调整练习以接近目标时长/u })).toHaveCount(0);
  await card.getByRole('button', { name: '定位词条', exact: true }).click();
  const rounds = page.getByRole('spinbutton', { name: '练习轮数', exact: true });
  await expect(rounds).toBeFocused();
  const before = await rounds.inputValue();
  await page.setViewportSize({ width: 720, height: 480 });
  await page.getByRole('button', { name: /^建议（/u }).click();
  await card.getByRole('button', { name: '定位词条', exact: true }).click();
  const properties = page.getByRole('dialog', { name: '词条属性', exact: true });
  const target = properties.getByRole('spinbutton', { name: '练习轮数', exact: true });
  await expect(target).toBeFocused();
  await expect(target).toHaveValue(before);
  await page.screenshot({ path: info.outputPath('explicit-suggestion-location-720.png') });
});

test('批改只改选中行，可整次撤销；预设差异保护手动及锁定参数', async ({ page }) => {
  await makeTeacherLesson(page, '批改及预设保护');
  await page.getByRole('spinbutton', { name: '练习轮数', exact: true }).fill('4');
  await page.getByRole('checkbox', { name: '锁定轮数', exact: true }).check();
  await entry(page, 'concentrate').click();
  await page.getByRole('checkbox', { name: '锁定轮数', exact: true }).check();
  await page.getByRole('checkbox', { name: '勾选achievement', exact: true }).check();
  await page.getByRole('button', { name: '批量修改', exact: true }).click();
  const batch = page.getByRole('dialog', { name: '批量修改 1 条词汇', exact: true });
  const rounds = batch.getByRole('spinbutton', { name: '练习轮数', exact: true });
  await expect(rounds).toBeDisabled();
  // 共同值仅用于展示；教师须明确授权本次修改的字段，未勾选项继续保留。
  await batch.getByRole('checkbox', { name: '修改练习轮数', exact: true }).check();
  await rounds.fill('5');
  await batch.getByRole('button', { name: '整批应用', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('5 轮');
  await expect(entry(page, 'concentrate')).toContainText('1 轮');
  await expect(entry(page, 'responsibility')).toContainText('1 轮');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('4 轮');
  await expect(entry(page, 'concentrate')).toContainText('1 轮');
  await page.getByRole('combobox', { name: '练习预设', exact: true }).selectOption('focus');
  const preview = page.getByRole('dialog', { name: '切换练习预设', exact: true });
  await expect(preview).toContainText('教师手动值与锁定项保留');
  await preview.getByRole('button', { name: '应用这些变化', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('4 轮');
  await expect(entry(page, 'concentrate')).toContainText('1 轮');
  await expect(entry(page, 'responsibility')).toContainText('3 轮');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(entry(page, 'responsibility')).toContainText('1 轮');
});

test('复制改编不追改原课件，更多操作重命名保存后重开一致', async ({ page }) => {
  const name = '原课件独立性';
  await makeTeacherLesson(page, name);
  await page.getByRole('textbox', { name: '教学释义', exact: true }).fill('原课保留的教学释义');
  await returnToLibrary(page);
  await lessonCard(page, name)
    .getByRole('button', { name: `${name}更多操作`, exact: true })
    .click();
  await page
    .getByRole('dialog', { name, exact: true })
    .getByRole('button', { name: '复制并改编', exact: true })
    .click();
  const copy = page.getByRole('dialog', { name: '复制并改编', exact: true });
  await copy.getByRole('textbox', { name: '副本名称', exact: true }).fill(`${name}（副本）`);
  await copy.getByRole('radio', { name: '沿用原内容', exact: true }).check();
  await copy.getByRole('button', { name: '创建独立副本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(
    `${name}（副本）`,
  );
  await page.getByRole('textbox', { name: '教学释义', exact: true }).fill('仅副本采用的新释义');
  await returnToLibrary(page);
  await lessonCard(page, name).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '教学释义', exact: true })).toHaveValue(
    '原课保留的教学释义',
  );
  await returnToLibrary(page);
  await lessonCard(page, name)
    .getByRole('button', { name: `${name}更多操作`, exact: true })
    .click();
  const menu = page.getByRole('dialog', { name, exact: true });
  await menu.getByRole('textbox', { name: '课件名称', exact: true }).fill('高二词汇第一课');
  await menu.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(lessonCard(page, '高二词汇第一课')).toBeVisible();
  await expect(lessonCard(page, `${name}（副本）`)).toBeVisible();
  await page.reload();
  await navigate(page, '我的课件');
  await lessonCard(page, '高二词汇第一课')
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(
    '高二词汇第一课',
  );
  await expect(page.getByRole('textbox', { name: '教学释义', exact: true })).toHaveValue(
    '原课保留的教学释义',
  );
});

test('复制确认前取消不建课件，创建后取消材料替换保留原内容副本', async ({ page }) => {
  const name = '复制取消边界原课';
  const cancelledName = '确认前取消不应保存';
  const keptName = '取消替换保留的独立副本';
  await makeTeacherLesson(page, name);
  await page.getByRole('textbox', { name: '教学释义', exact: true }).fill('复制前保留的教学释义');
  await returnToLibrary(page);

  const openCopy = async () => {
    await lessonCard(page, name)
      .getByRole('button', { name: `${name}更多操作`, exact: true })
      .click();
    await page
      .getByRole('dialog', { name, exact: true })
      .getByRole('button', { name: '复制并改编', exact: true })
      .click();
  };
  await openCopy();
  const copy = page.getByRole('dialog', { name: '复制并改编', exact: true });
  await copy.getByRole('textbox', { name: '副本名称', exact: true }).fill(cancelledName);
  await copy.getByRole('radio', { name: '替换材料', exact: true }).check();
  await copy.getByRole('button', { name: '取消', exact: true }).click();
  const discard = page.getByRole('dialog', { name: '未保存的修改', exact: true });
  await expect(discard.getByRole('button', { name: '继续编辑', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(copy.getByRole('textbox', { name: '副本名称', exact: true })).toHaveValue(
    cancelledName,
  );
  await copy.getByRole('button', { name: '取消', exact: true }).click();
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(copy).not.toBeVisible();
  await expect(page.locator('.lesson-card')).toHaveCount(1);
  await expect(lessonCard(page, cancelledName)).toHaveCount(0);

  await openCopy();
  await copy.getByRole('textbox', { name: '副本名称', exact: true }).fill(keptName);
  await copy.getByRole('radio', { name: '替换材料', exact: true }).check();
  await copy.getByRole('button', { name: '创建独立副本', exact: true }).click();
  const replacement = page.getByRole('dialog', { name: '替换教学材料', exact: true });
  await expect(replacement).toBeVisible();
  await replacement
    .getByRole('textbox', { name: '教学词表', exact: true })
    .fill('cooperation\t尚未确认的新材料');
  await replacement.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(replacement).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '课件名称', exact: true })).toHaveValue(keptName);
  await expect(entry(page, 'achievement')).toContainText('复制前保留的教学释义');
  await expect(entry(page, 'concentrate')).toBeVisible();
  await expect(entry(page, 'responsibility')).toBeVisible();
  await expect(entry(page, 'cooperation')).toHaveCount(0);
  await returnToLibrary(page);
  await expect(page.locator('.lesson-card')).toHaveCount(2);
  await expect(lessonCard(page, name)).toBeVisible();
  await expect(lessonCard(page, keptName)).toBeVisible();
  await page.reload();
  await navigate(page, '我的课件');
  await expect(page.locator('.lesson-card')).toHaveCount(2);
  await lessonCard(page, keptName).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('复制前保留的教学释义');
  await expect(entry(page, 'cooperation')).toHaveCount(0);
});

test('逐词模式中间词等待教师，末词练习完成直接收尾', async ({ page }) => {
  await makeTeacherLesson(page, '逐词末词收尾', 'achievement\t成就\nconcentrate\t集中注意力');
  await page.getByRole('spinbutton', { name: '节奏 BPM', exact: true }).fill('180');
  await page.getByRole('checkbox', { name: '基础节拍', exact: true }).uncheck();
  await page.getByText('声音、口号及导出设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '逐词等待教师', exact: true }).check();
  await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.getByText('等待教师', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'achievement', exact: true })).toBeVisible();
  await page.locator('footer').getByRole('button', { name: '继续下一词', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'concentrate', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible();
  await expect(page.getByText('等待教师', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/已完成 2 \/ 2 条/u)).toBeVisible();
});

for (const mode of ['centered', 'blocks'] as const) {
  test(`应用课堂${mode}模式自然播放2+2拍，跟读接第三拍且新轮新词回第一拍`, async ({
    page,
  }, testInfo) => {
    const words = ['achievement', 'concentrate'];
    await makeTeacherLesson(page, '应用四拍连续性', 'achievement\t成就\nconcentrate\t集中注意力');
    await page.getByRole('spinbutton', { name: '节奏 BPM', exact: true }).fill('100');
    await page.getByRole('combobox', { name: '展示模式', exact: true }).selectOption(mode);
    await page.getByRole('checkbox', { name: '基础节拍', exact: true }).uncheck();
    for (const word of words) {
      await entry(page, word).click();
      await page.getByRole('spinbutton', { name: '练习轮数', exact: true }).fill('2');
      await page.getByRole('spinbutton', { name: '教师示范拍数', exact: true }).fill('2');
      await page
        .getByRole('combobox', { name: '跟读拍数来源', exact: true })
        .selectOption('manual');
      await page.getByRole('spinbutton', { name: '固定跟读拍数', exact: true }).fill('2');
    }
    await page.getByText('声音、口号及导出设置', { exact: true }).click();
    await page.getByRole('checkbox', { name: '逐词等待教师', exact: true }).uncheck();
    await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();

    // 只观察应用真实提交的 DOM 和绘制尺寸，不替换时间、控制器或课件数据。
    // 逐次保留拍位，防止只验最后一帧而漏过示范→跟读之间的提前归零。
    const collector = await page.evaluateHandle(() => {
      const samples: {
        word: string;
        round: number;
        phase: string;
        beat: number;
        reached: boolean[];
        visible: boolean;
      }[] = [];
      const observer = new MutationObserver(() => {
        const stage = document.querySelector<HTMLElement>('.ecg-classroom-stage');
        const phase = stage?.dataset.phase;
        if (!stage || (phase !== 'model' && phase !== 'follow')) return;
        const active = stage.querySelector<HTMLElement>('.ecg-pulse-active');
        const detail = stage.querySelector('.ecg-classroom-detail')?.textContent ?? '';
        const bounds = active?.getBoundingClientRect();
        const sample = {
          word: stage.querySelector('.teaching-content__word')?.textContent ?? '',
          round: Number(/第\s*(\d+)\s*\//u.exec(detail)?.[1]),
          phase,
          beat: Number(active?.querySelector('.ecg-beat-number')?.textContent),
          reached: [...stage.querySelectorAll<HTMLElement>('.ecg-beat-block')].map(
            (pad) => pad.dataset.reached === 'true',
          ),
          visible: Boolean(
            bounds &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            active &&
            getComputedStyle(active).visibility === 'visible' &&
            Number(getComputedStyle(active).opacity) > 0,
          ),
        };
        const previous = samples.at(-1);
        if (
          !previous ||
          previous.word !== sample.word ||
          previous.round !== sample.round ||
          previous.phase !== sample.phase ||
          previous.beat !== sample.beat
        )
          samples.push(sample);
      });
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
      return { samples, observer };
    });
    await page.getByRole('button', { name: '开始课堂', exact: true }).click();
    await expect(page.getByRole('heading', { name: '本次练习记录', exact: true })).toBeVisible({
      timeout: 25_000,
    });
    const samples = await collector.evaluate(({ samples, observer }) => {
      observer.disconnect();
      return samples;
    });
    await collector.dispose();
    await testInfo.attach('application-natural-four-beat-sequence.json', {
      body: Buffer.from(JSON.stringify({ mode, samples }, null, 2)),
      contentType: 'application/json',
    });
    expect(samples.map(({ word, round, phase, beat }) => ({ word, round, phase, beat }))).toEqual(
      words.flatMap((word) =>
        [1, 2].flatMap((round) =>
          [1, 2, 3, 4].map((beat) => ({
            word,
            round,
            phase: beat <= 2 ? 'model' : 'follow',
            beat,
          })),
        ),
      ),
    );
    for (const sample of samples) {
      expect(sample.visible).toBe(true);
      expect(sample.reached).toEqual([1, 2, 3, 4].map((beat) => beat <= sample.beat));
    }
    await expect(page.getByLabel(/已完成 2 \/ 2 条/u)).toBeVisible();
    await expect(page.getByText('等待教师', { exact: true })).toHaveCount(0);
    // 桌面预演通过 Portal 覆盖编辑器；低高度下也要完整保留记录与返回编辑动作。
    for (const viewport of [
      { width: 911, height: 480 },
      { width: 1920, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const layout = await page.locator('.ecg-classroom-completed').evaluate((completed) => {
        const box = completed.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          clientWidth: completed.clientWidth,
          scrollWidth: completed.scrollWidth,
          clientHeight: completed.clientHeight,
          scrollHeight: completed.scrollHeight,
        };
      });
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(viewport.width);
      expect(layout.top).toBeGreaterThanOrEqual(0);
      expect(layout.bottom).toBeLessThanOrEqual(viewport.height);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
      expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
      const completed = page.locator('.ecg-classroom-completed');
      for (const name of ['重新播放', '返回编辑']) {
        const button = completed.getByRole('button', { name, exact: true });
        await expect(button).toBeInViewport({ ratio: 1 });
        await button.click({ trial: true });
      }
    }
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await expect(page.getByRole('button', { name: '预演 / 上课', exact: true })).toBeVisible();
  });
}

test('911×480编辑布局可打开属性、切换词表预览，导出与返回控件可达', async ({ page }, testInfo) => {
  await makeTeacherLesson(page, '缩放后的可用编辑器');
  await page.setViewportSize({ width: 911, height: 480 });
  await page.getByRole('button', { name: '当前词属性', exact: true }).click();
  const properties = page.getByRole('dialog', { name: '词条属性', exact: true });
  await properties
    .getByRole('textbox', { name: '教学释义', exact: true })
    .fill('缩放后仍可完整编辑');
  await properties.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '课堂预览', exact: true }).click();
  await expect(page.getByText('缩放后仍可完整编辑', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '词表', exact: true }).click();
  await expect(entry(page, 'achievement')).toContainText('缩放后仍可完整编辑');
  const output = page.getByRole('button', { name: '导出课堂文件', exact: true });
  await output.scrollIntoViewIfNeeded();
  await expect(output).toBeVisible();
  const box = await output.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(911);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('editor-911x480.png'), fullPage: true });
  await returnToLibrary(page);
});

/** 远距离观看需要中文成为主体；样式与实际容器尺寸一起检查，不能只断言类名。 */
test('课堂中文与英文统一悬浮字形，大小窗口清晰且控制按钮不溢出', async ({ page }) => {
  await makeTeacherLesson(page, '课堂大屏中文验收');
  await page.setViewportSize({ width: 1920, height: 953 });
  await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await expect(page.locator('.teaching-content__meaning')).toHaveText('成就');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const meaning = page.locator('.teaching-content__meaning');
  await expect(meaning).toHaveCSS('font-size', '64px');
  await expect(meaning).toHaveCSS('font-weight', '700');
  await expect(meaning).toHaveCSS('color', 'rgb(243, 246, 255)');
  await expect(meaning).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(meaning).toHaveCSS('border-bottom-width', '0px');
  expect(await meaning.evaluate((el) => getComputedStyle(el).textShadow)).toBe(
    await page.locator('.teaching-content__word').evaluate((el) => getComputedStyle(el).textShadow),
  );
  const play = page.getByRole('button', { name: '继续', exact: true });
  await expect(play).toHaveCSS('border-top-left-radius', '10px');
  await expect(play).toHaveCSS('border-top-right-radius', '4px');
  await expect(play).toHaveCSS('color', 'rgb(232, 251, 255)');
  // 主操作在悬停或聚焦时保持实底与文字对比，不能成为只有装饰描边的空壳。
  for (const state of ['default', 'hover', 'focus']) {
    if (state === 'hover') await play.hover();
    if (state === 'focus') {
      await page.mouse.move(0, 0);
      await play.focus();
    }
    await expect(play).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 911, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('.teaching-content')).toHaveAttribute('data-overflow', 'false');
    for (const name of ['上一词', '继续', '下一词', '重读', '课堂设置', '全屏', '返回编辑']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await expect(meaning).toBeInViewport({ ratio: 1 });
    expect(
      await meaning.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1)).toBe(
      false,
    );
  }
});
