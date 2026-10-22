/** 教师通过真实列映射入口确认无表头多列词表，不替产品猜测列含义。 @author ahui */
import type { Locator, Page } from '@playwright/test';

/**
 * 首次解析只展示物理列，明确选择每列用途后才请求校对预览。
 * @param scope 当前页面或导入对话框；避免误操作仍挂载的隐藏制作步骤。
 * @param purposes 按物理列顺序明确给出的用途；本测试不使用示例数据内容推断用途。
 */
export async function previewMappedVocabulary(
  scope: Page | Locator,
  purposes: readonly string[] = ['english', 'meaning'],
): Promise<void> {
  await scope.getByRole('button', { name: '整理并预览', exact: true }).click();
  for (const [index, purpose] of purposes.entries())
    await scope
      .getByRole('combobox', { name: `第 ${index + 1} 列用途`, exact: true })
      .selectOption(purpose);
  await scope.getByRole('button', { name: '整理并预览', exact: true }).click();
}
