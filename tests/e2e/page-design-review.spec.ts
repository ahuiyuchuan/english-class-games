/**
 * 逐页设计复核：通过教师真实入口建立材料和课件，留存各断点及弹窗的截图与布局证据。
 * 不注入业务状态，不模拟桌面能力；浏览器不可用的原生操作由独立实机验收负责。
 * @author ahui
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { previewMappedVocabulary } from './helpers/materials';

/** 导航使用当前视口实际可见入口；窄屏等待菜单关闭，避免焦点与遮罩竞争。 */
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '打开主导航' });
  if (await menu.isVisible()) {
    await menu.click();
    const dialog = page.getByRole('dialog', { name: '主导航', exact: true });
    await dialog.getByRole('button', { name, exact: true }).click();
    await expect(dialog).not.toBeVisible();
  } else {
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name, exact: true })
      .click();
  }
}

/** 检查实际可见控件与页面边界，保留报告便于逐页视觉复查，不以截图代替功能断言。 */
async function inspect(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    // 弹窗以实际视口留图，避免 fullPage 扩大截图造成固定遮罩与底部控件的假位置。
    fullPage: !(await page.getByRole('dialog').count()),
    animations: 'disabled',
  });
  const result = await page.evaluate(() => {
    const visible = (element: HTMLElement) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageWidth: document.documentElement.scrollWidth,
      clippedBrand: [...document.querySelectorAll<HTMLElement>('.sidebar .brand-logo')]
        .filter(visible)
        .some((element) => {
          const logo = element.getBoundingClientRect();
          const sidebar = element.closest('.sidebar')!.getBoundingClientRect();
          return logo.left < sidebar.left || logo.right > sidebar.right - 4;
        }),
      headings: [...document.querySelectorAll<HTMLElement>('h1,h2,h3')]
        .filter(visible)
        .map((element) => element.textContent),
      outside: [...document.querySelectorAll<HTMLElement>('button,input,select,textarea')]
        .filter(visible)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          // 横向滚动表格属于明确的局部区域，不把其中尚未滚动到的列误报为整页溢出。
          let parent = element.parentElement;
          while (parent && parent !== document.body) {
            if (
              ['auto', 'scroll'].includes(getComputedStyle(parent).overflowX) &&
              parent.scrollWidth > parent.clientWidth + 1
            )
              return false;
            parent = parent.parentElement;
          }
          return rect.left < -1 || rect.right > innerWidth + 1;
        })
        .map((element) => ({
          name: element.getAttribute('aria-label') || element.textContent?.trim(),
          tag: element.tagName,
        })),
      unnamed: [...document.querySelectorAll<HTMLElement>('button')]
        .filter(visible)
        .filter(
          (element) =>
            !element.textContent?.trim() &&
            !element.getAttribute('aria-label') &&
            !element.getAttribute('aria-labelledby'),
        )
        .map((element) => element.outerHTML),
    };
  });
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(result, null, 2));
  expect.soft(result.clippedBrand, `${name}: 收窄品牌越界`).toBe(false);
  await info.attach(name, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect.soft(result.pageWidth, `${name}: 页面横向溢出`).toBeLessThanOrEqual(result.viewport.width);
  expect.soft(result.outside, `${name}: 控件越界`).toEqual([]);
  expect.soft(result.unnamed, `${name}: 图标按钮缺少名称`).toEqual([]);
}

test('逐页面、设置分区、任务与材料弹窗在宽窄窗口保持统一且可操作', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 1000, height: 640 },
    { width: 720, height: 480 },
  ]) {
    await page.setViewportSize(size);
    for (const name of ['AI 工作台', '游戏库', '教学材料', '我的课件', '资源与设置', '关于']) {
      await navigate(page, name);
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await inspect(page, info, `${size.width}-${name}`);
      if (name === '资源与设置') {
        for (const tab of ['音乐与口号', '数据与备份', '语音与制作默认']) {
          await page.getByRole('tab', { name: tab, exact: true }).click();
          await inspect(page, info, `${size.width}-${tab}`);
        }
      }
    }
    for (const name of ['制作任务', '导出任务']) {
      await page.getByRole('button', { name, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await inspect(page, info, `${size.width}-${name}`);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
    }
    await navigate(page, '教学材料');
    await page.getByRole('tab', { name: /常用词库/ }).click();
    await inspect(page, info, `${size.width}-常用词空态`);
    await page.getByRole('button', { name: '导入材料', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入教学材料', exact: true });
    await inspect(page, info, `${size.width}-导入材料`);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('制作三步、真实材料校对、编辑属性与导出在宽窄窗口可达', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.getByRole('button', { name: '智能制作', exact: true }).first().click();
  await page
    .getByRole('textbox', { name: '教学词表', exact: true })
    .fill('achievement\t成就\nmake a difference\t产生影响\nresponsibility\t责任');
  await previewMappedVocabulary(page);
  for (const width of [1366, 720]) {
    await page.setViewportSize({ width, height: width === 720 ? 480 : 768 });
    await inspect(page, info, `${width}-制作内容校对`);
  }
  await page.getByRole('button', { name: '确认内容，下一步', exact: true }).click();
  await page.getByRole('textbox', { name: '课件名称', exact: true }).fill('逐页交互与设计复核');
  await page.getByLabel('练习模式', { exact: true }).selectOption('teacher');
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('声音、口号与材料设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '开场口号', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '收尾口号', exact: true }).uncheck();
  for (const width of [1366, 720]) {
    await page.setViewportSize({ width, height: width === 720 ? 480 : 768 });
    await inspect(page, info, `${width}-活动编排`);
  }
  await page.getByRole('button', { name: '一键制作', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入编辑', exact: true })).toBeVisible();
  await inspect(page, info, '720-制作成果');
  await page.getByRole('button', { name: '进入编辑', exact: true }).click();
  for (const width of [1920, 1366, 720]) {
    await page.setViewportSize({ width, height: width === 720 ? 480 : 900 });
    await inspect(page, info, `${width}-编辑器`);
  }
  await page.getByRole('button', { name: '导出课堂文件', exact: true }).click();
  await inspect(page, info, '720-导出选版');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '预演 / 上课', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始课堂', exact: true })).toBeVisible();
  for (const width of [1920, 1366, 720]) {
    await page.setViewportSize({ width, height: width === 720 ? 480 : 900 });
    await inspect(page, info, `${width}-课堂开场`);
  }
  await page.getByRole('button', { name: '开始课堂', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await inspect(page, info, '720-课堂暂停');
  // 返回编辑放在顶部，底部七个控制保持一行，不能挤掉教学区域。
  const shortContent = await page
    .locator('.ecg-classroom-stage > .teaching-content')
    .evaluate((node) => ({
      visible: node.clientHeight,
      full: node.scrollHeight,
    }));
  expect(shortContent.full).toBeLessThanOrEqual(shortContent.visible + 1);
  const resumeControl = await page.getByRole('button', { name: '继续', exact: true }).boundingBox();
  const exitControl = await page
    .getByRole('button', { name: '结束课堂', exact: true })
    .boundingBox();
  expect(Math.abs(resumeControl!.y - exitControl!.y)).toBeLessThanOrEqual(4);
  await expect(
    page.locator('.ecg-classroom-header').getByRole('button', { name: '返回编辑', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '课堂设置', exact: true }).click();
  await inspect(page, info, '720-课堂设置');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await expect(page.getByRole('button', { name: '课堂设置', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await page.getByRole('button', { name: '返回课件库', exact: true }).click();
  await inspect(page, info, '720-已有课件');
  await page.getByRole('textbox', { name: '搜索课件', exact: true }).fill('不存在的课件');
  await expect(page.getByRole('heading', { name: '没有匹配的课件' })).toBeVisible();
  await inspect(page, info, '720-课件无结果');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索课件', exact: true })).toBeFocused();
  await expect(
    page.getByRole('heading', { name: '逐页交互与设计复核', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '逐页交互与设计复核更多操作', exact: true }).click();
  await inspect(page, info, '720-课件更多操作');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('材料无结果可恢复，错误与模式状态明确，窄屏导航和未保存保护可用', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 720, height: 480 });
  await page.goto('/');
  await navigate(page, '教学材料');
  await page.getByRole('button', { name: '打开主导航' }).click();
  const menu = page.getByRole('dialog', { name: '主导航', exact: true });
  await expect(menu.getByRole('button', { name: '教学材料', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await inspect(page, info, '720-导航当前页');
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await page.getByRole('button', { name: '导入材料', exact: true }).click();
  const importer = page.getByRole('dialog', { name: '导入教学材料', exact: true });
  await expect(importer.getByRole('button', { name: '词表 / 表格', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await importer.getByRole('button', { name: '阅读选词', exact: true }).click();
  await expect(importer.getByRole('button', { name: '阅读选词', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await importer.getByRole('button', { name: '词表 / 表格', exact: true }).click();
  await importer.getByRole('button', { name: '整理并预览', exact: true }).click();
  await expect(importer.getByRole('alert')).toBeVisible();
  await inspect(page, info, '720-导入错误');
  await importer.getByRole('textbox', { name: '教学词表', exact: true }).fill('achievement\t成就');
  await previewMappedVocabulary(importer);
  await importer.getByRole('button', { name: '保存材料集', exact: true }).click();
  await expect(importer).not.toBeVisible();
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCSS('pointer-events', 'none');
  expect((await toast.boundingBox())!.y).toBeLessThan(32);
  await page.getByRole('textbox', { name: '搜索教学材料', exact: true }).fill('不匹配的内容');
  await expect(page.getByRole('heading', { name: '没有匹配的教学材料' })).toBeVisible();
  await expect(page.getByRole('button', { name: '粘贴 / 导入', exact: true })).toHaveCount(0);
  await inspect(page, info, '720-材料无结果');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索教学材料', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '用于制作', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '材料详情与校对', exact: true });
  await detail.getByRole('textbox', { name: '教学释义', exact: true }).fill('尚未保存的修改');
  await inspect(page, info, '720-材料详情');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog', { name: '放弃材料校对？', exact: true });
  await expect(confirm.getByRole('button', { name: '继续编辑', exact: true })).toBeFocused();
  await inspect(page, info, '720-未保存保护');
  await page.keyboard.press('Enter');
  await expect(detail.getByRole('textbox', { name: '教学释义', exact: true })).toHaveValue(
    '尚未保存的修改',
  );
  await detail.getByRole('button', { name: '所选词存为常用词', exact: true }).click();
  const common = page.getByRole('dialog', { name: '保存常用词 · 检查差异', exact: true });
  await inspect(page, info, '720-常用词差异确认');
  await common.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(common).not.toBeVisible();
  await expect(detail.getByRole('button', { name: '所选词存为常用词', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await confirm.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(detail).not.toBeVisible();
  await page.getByRole('tab', { name: '常用词库 · 1', exact: true }).click();
  await inspect(page, info, '720-已有常用词');
  await page.getByRole('textbox', { name: '搜索教学材料', exact: true }).fill('不存在的词');
  await expect(page.getByRole('heading', { name: '没有匹配的常用词' })).toBeVisible();
  await inspect(page, info, '720-常用词无结果');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索教学材料', exact: true })).toBeFocused();
  await expect(page.getByRole('cell', { name: '尚未保存的修改', exact: true })).toBeVisible();
});
