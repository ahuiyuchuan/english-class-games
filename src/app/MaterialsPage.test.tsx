// @vitest-environment jsdom
/**
 * 材料详情跨页校对回归：提交摘要定位隐藏页，修订不会改写原材料或丢失来源。
 * 使用真实表单与本地字段规则，保存回调只记录已确认的教学内容副本。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MaterialCollection } from '../platform/repository';
import { FeedbackProvider } from '../shared/ui';
import { CommonWordsDialog, MaterialsPage } from './MaterialsPage';

afterEach(cleanup);

/** 一条已保存的教学材料，用于精确验证表单修改与保存数据的边界。 */
function materialFixture(): MaterialCollection {
  return {
    id: 'material',
    name: '已保存词表',
    revision: 1,
    original: 'knowledge\t知识',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
    entries: [{ id: 'entry', english: 'knowledge', meaning: '知识', priority: false }],
  };
}

function mountMaterial(
  onMaterials = vi.fn().mockResolvedValue(undefined),
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void,
  material = materialFixture(),
) {
  const onMake = vi.fn();
  const view = render(
    <FeedbackProvider>
      <MaterialsPage
        dictionary={[]}
        commonWords={[]}
        materials={[material]}
        onMaterials={onMaterials}
        onCommonWords={vi.fn()}
        onMake={onMake}
        onSaveCommon={vi.fn()}
        onRegisterLeaveGuard={onRegisterLeaveGuard}
      />
    </FeedbackProvider>,
  );
  return { ...view, material, onMaterials, onMake };
}

it('材料详情关闭或 Esc 先保护修改，继续编辑不丢输入，明确放弃不改已保存材料', async () => {
  const { material, onMaterials } = mountMaterial();
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  const name = screen.getByLabelText('材料名称');
  fireEvent.change(name, { target: { value: '尚未保存的新名称' } });
  fireEvent.keyDown(name, { key: 'Escape' });
  const confirmation = await screen.findByRole('dialog', { name: '放弃材料校对？' });
  expect(within(confirmation).getByRole('button', { name: '继续编辑' })).toHaveFocus();
  await act(async () => {
    fireEvent.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
  });
  expect(name).toHaveValue('尚未保存的新名称');
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(onMaterials).not.toHaveBeenCalled();
  expect(material.name).toBe('已保存词表');
});

it('页面离开守卫只返回许可，拒绝保留输入，允许后也由宿主决定导航', async () => {
  let guard: (() => Promise<boolean>) | null = null;
  const register = vi.fn((value: (() => Promise<boolean>) | null) => {
    guard = value;
  });
  const view = mountMaterial(undefined, register);
  expect(await guard!()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  const name = screen.getByLabelText('材料名称');
  fireEvent.change(name, { target: { value: '离开前输入' } });
  let permission!: Promise<boolean>;
  act(() => {
    permission = guard!();
  });
  fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
  await expect(permission).resolves.toBe(false);
  expect(name).toHaveValue('离开前输入');
  act(() => {
    permission = guard!();
  });
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  await expect(permission).resolves.toBe(true);
  expect(name).toHaveValue('离开前输入');
  view.unmount();
  expect(register).toHaveBeenLastCalledWith(null);
});

it('导入未保存内容受关闭保护，保存期间禁用表单并阻止关闭，失败保留输入', async () => {
  let rejectSave!: (cause: Error) => void;
  const onMaterials = vi.fn().mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  mountMaterial(onMaterials);
  fireEvent.click(screen.getByRole('button', { name: '导入材料' }));
  const input = screen.getByRole('textbox', { name: '教学词表' });
  fireEvent.change(input, { target: { value: 'confidence' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
  expect(input).toHaveValue('confidence');
  fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
  fireEvent.click(screen.getByRole('button', { name: '保存材料集' }));
  expect(onMaterials).toHaveBeenCalledOnce();
  expect(input).toBeDisabled();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: '导入教学材料' })).toBeInTheDocument();
  await act(async () => {
    rejectSave(new Error('磁盘不可写'));
  });
  expect(input).toBeEnabled();
  expect(input).toHaveValue('confidence');
  expect(screen.getByRole('alert')).toHaveTextContent('磁盘不可写');
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('常用词差异表单取消先保护改写，明确放弃后不保存', async () => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <FeedbackProvider>
      <CommonWordsDialog
        entries={materialFixture().entries}
        existing={[]}
        onSave={onSave}
        onClose={onClose}
      />
    </FeedbackProvider>,
  );
  const meaning = screen.getByRole('textbox', { name: '教学释义' });
  fireEvent.change(meaning, { target: { value: '教师尚未确认的修订' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
  });
  expect(meaning).toHaveValue('教师尚未确认的修订');
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(meaning, { key: 'Escape' });
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).not.toHaveBeenCalled();
});

it('导入条目改英文后不沿用已消失的指定覆盖目标，原常用词保留', async () => {
  const existing = { id: 'saved-bank', english: 'bank', meaning: '银行', priority: false };
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <FeedbackProvider>
      <CommonWordsDialog
        entries={[{ id: 'incoming', english: 'bank', meaning: '河岸', priority: false }]}
        existing={[existing]}
        onSave={onSave}
        onClose={vi.fn()}
      />
    </FeedbackProvider>,
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'bank保存方式' }), {
    target: { value: existing.id },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '英文 / 短语' }), {
    target: { value: 'forest' },
  });
  expect(screen.getByRole('combobox', { name: 'forest保存方式' })).toHaveValue('new');
  fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0]).toEqual([
    existing,
    expect.objectContaining({ english: 'forest', meaning: '河岸' }),
  ]);
  expect(existing).toMatchObject({ english: 'bank', meaning: '银行' });
});

it('直接编辑既有常用词时可改正英文，并保留原条目标识', async () => {
  const existing = { id: 'saved-word', english: 'forrest', meaning: '森林', priority: false };
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <FeedbackProvider>
      <CommonWordsDialog
        entries={[existing]}
        existing={[existing]}
        onSave={onSave}
        onClose={vi.fn()}
      />
    </FeedbackProvider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: '英文 / 短语' }), {
    target: { value: 'forest' },
  });
  expect(screen.getByRole('combobox', { name: 'forest保存方式' })).toHaveValue(existing.id);
  fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0]).toEqual([
    expect.objectContaining({ id: existing.id, english: 'forest', meaning: '森林' }),
  ]);
  expect(existing.english).toBe('forrest');
});

it('未修改的材料直接交接独立副本，不重复保存原材料', async () => {
  const { material, onMaterials, onMake } = mountMaterial();
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  fireEvent.click(screen.getByRole('button', { name: '用于智能制作' }));
  await waitFor(() => expect(onMake).toHaveBeenCalledOnce());
  expect(onMaterials).not.toHaveBeenCalled();
  expect(onMake.mock.calls[0][0]).toEqual(material.entries);
  expect(onMake.mock.calls[0][0][0]).not.toBe(material.entries[0]);
});

it('保存并制作先保存名称和未选词修改，成功后只交接所选词且不再询问放弃', async () => {
  let resolveSave!: () => void;
  const onMaterials = vi.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const material = materialFixture();
  material.entries.push({
    id: 'unselected',
    english: 'confidence',
    meaning: '信心',
    priority: false,
  });
  const { onMake } = mountMaterial(onMaterials, undefined, material);
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 confidence' }));
  const name = screen.getByRole('textbox', { name: '材料名称' });
  fireEvent.change(name, { target: { value: '  整份材料新名称  ' } });
  fireEvent.change(screen.getAllByRole('textbox', { name: '教学释义' })[1], {
    target: { value: '未选词也必须保存的修订' },
  });
  expect(screen.getByText(/会先保存材料名称和全部词条修改/)).toBeVisible();
  const make = screen.getByRole('button', { name: '保存并用于智能制作' });
  fireEvent.click(make);
  fireEvent.click(make);
  expect(onMaterials).toHaveBeenCalledOnce();
  expect(onMake).not.toHaveBeenCalled();
  expect(name).toBeDisabled();
  expect(onMaterials.mock.calls[0][0][0]).toMatchObject({
    name: '整份材料新名称',
    revision: 2,
    entries: [material.entries[0], expect.objectContaining({ meaning: '未选词也必须保存的修订' })],
  });
  fireEvent.keyDown(name, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: '材料详情与校对' })).toBeInTheDocument();
  await act(async () => resolveSave());
  expect(onMake).toHaveBeenCalledOnce();
  expect(onMake.mock.calls[0][0]).toEqual([material.entries[0]]);
  expect(onMake.mock.calls[0][0][0]).not.toBe(material.entries[0]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(material.name).toBe('已保存词表');
  expect(material.entries[1].meaning).toBe('信心');
});

it('保存并制作失败保留输入与选择，重试成功才交接且不回滚已保存内容', async () => {
  const onMaterials = vi
    .fn()
    .mockRejectedValueOnce(new Error('磁盘不可写'))
    .mockResolvedValue(undefined);
  const { onMake } = mountMaterial(onMaterials);
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  const name = screen.getByRole('textbox', { name: '材料名称' });
  fireEvent.change(name, { target: { value: '失败后仍保留的材料' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并用于智能制作' }));
  await screen.findByText('磁盘不可写');
  expect(name).toHaveValue('失败后仍保留的材料');
  expect(screen.getByRole('checkbox', { name: '选择 knowledge' })).toBeChecked();
  expect(onMake).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存并用于智能制作' }));
  await waitFor(() => expect(onMake).toHaveBeenCalledOnce());
  expect(onMaterials).toHaveBeenCalledTimes(2);
  expect(onMaterials.mock.calls[1][0][0].name).toBe('失败后仍保留的材料');
});

it('未选词的非法修改同样阻止保存并制作，不只校验所选词', async () => {
  const material = materialFixture();
  material.entries.push({
    id: 'unselected',
    english: 'confidence',
    meaning: '信心',
    priority: false,
  });
  const { onMaterials, onMake } = mountMaterial(undefined, undefined, material);
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 confidence' }));
  fireEvent.change(screen.getAllByRole('textbox', { name: '英文' })[1], { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并用于智能制作' }));
  await screen.findByText('请修正材料中的错误后再保存。');
  expect(onMaterials).not.toHaveBeenCalled();
  expect(onMake).not.toHaveBeenCalled();
  expect(screen.getByRole('checkbox', { name: '选择 knowledge' })).toBeChecked();
});

it('常用词宿主关闭守卫保护字段和保存方式，确认许可不提前清空或保存', async () => {
  let guard: (() => Promise<boolean>) | null = null;
  const register = vi.fn((value: (() => Promise<boolean>) | null) => {
    guard = value;
  });
  const onSave = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <FeedbackProvider>
      <CommonWordsDialog
        entries={materialFixture().entries}
        existing={[]}
        onSave={onSave}
        onClose={onClose}
        onRegisterLeaveGuard={register}
      />
    </FeedbackProvider>,
  );
  expect(await guard!()).toBe(true);
  fireEvent.change(screen.getByRole('combobox', { name: 'knowledge保存方式' }), {
    target: { value: 'skip' },
  });
  let permission!: Promise<boolean>;
  act(() => {
    permission = guard!();
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
  });
  await expect(permission).resolves.toBe(false);
  expect(screen.getByRole('combobox', { name: 'knowledge保存方式' })).toHaveValue('skip');
  act(() => {
    permission = guard!();
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  });
  await expect(permission).resolves.toBe(true);
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  view.unmount();
  expect(register).toHaveBeenLastCalledWith(null);
});

it('保存时定位被筛选隐藏的跨页错误，保留原始输入与来源快照', async () => {
  const material: MaterialCollection = {
    id: 'material',
    name: '高中词表',
    revision: 1,
    original: '教师原始词表',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
    entries: Array.from({ length: 51 }, (_, index) => ({
      id: `entry-${index}`,
      english: `word${index}`,
      meaning: '教学释义',
      priority: false,
      unit: index === 50 ? '单'.repeat(81) : 'Unit 1',
      source: { name: '教师原材料', line: index + 1, original: `原词${index}` },
    })),
  };
  const onMaterials = vi.fn().mockResolvedValue(undefined);
  render(
    <FeedbackProvider>
      <MaterialsPage
        dictionary={[]}
        commonWords={[]}
        materials={[material]}
        onMaterials={onMaterials}
        onCommonWords={vi.fn()}
        onMake={vi.fn()}
        onSaveCommon={vi.fn()}
      />
    </FeedbackProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  // 此页有 50 行完整字段；按唯一可见提示定位，避免标签查询反复遍历每个标签子树。
  const filterInput = screen.getByPlaceholderText('搜索英文、释义或词性');
  expect(filterInput).toHaveAccessibleName('筛选材料词条');
  fireEvent.change(filterInput, { target: { value: 'word0' } });
  fireEvent.click(screen.getByRole('button', { name: '保存校对' }));
  // Radix 对话框挂在 body 的 portal，摘要不属于 render 的默认容器。
  await waitFor(() => expect(document.querySelector('.error-summary')).toHaveFocus());
  expect(onMaterials).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '定位：单元最多 80 字符。' }));
  const unit = await screen.findByDisplayValue('单'.repeat(81));
  await waitFor(() => expect(unit).toHaveFocus());
  expect(filterInput).toHaveValue('');
  fireEvent.change(unit, { target: { value: 'Unit 9' } });
  fireEvent.click(screen.getByRole('button', { name: '保存校对' }));
  await waitFor(() => expect(onMaterials).toHaveBeenCalledOnce());
  expect(onMaterials.mock.calls[0][0][0].entries[50]).toMatchObject({
    unit: 'Unit 9',
    source: material.entries[50].source,
  });
  expect(material.entries[50].unit).toBe('单'.repeat(81));
});

it('无分类且仅一页时隐藏空筛选和翻页，数量、搜索与材料校对仍可用', () => {
  const material = materialFixture();
  render(
    <FeedbackProvider>
      <MaterialsPage
        dictionary={[]}
        commonWords={material.entries}
        materials={[material]}
        onMaterials={vi.fn()}
        onCommonWords={vi.fn()}
        onMake={vi.fn()}
        onSaveCommon={vi.fn()}
      />
    </FeedbackProvider>,
  );
  fireEvent.mouseDown(screen.getByRole('tab', { name: '常用词库 · 1' }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByRole('textbox', { name: '搜索教学材料' })).toBeVisible();
  expect(screen.queryByRole('combobox', { name: '标签筛选' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上一页' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  expect(screen.getByText('共 1 条', { exact: true })).toBeVisible();
  fireEvent.mouseDown(screen.getByRole('tab', { name: '材料集 · 1' }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole('button', { name: '用于制作' }));
  expect(screen.queryByRole('combobox', { name: '材料单元或标签筛选' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一页词条' })).not.toBeInTheDocument();
  expect(screen.getByText('匹配 1 / 1 条', { exact: true })).toBeVisible();
  expect(screen.getByRole('checkbox', { name: '选择 knowledge' })).toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
    target: { value: '教师仍可校对' },
  });
  expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue('教师仍可校对');
});

it('常用词多页筛选为一页后隐藏分页，清除筛选回到第一页且不修改原词条', () => {
  const words = Array.from({ length: 51 }, (_, index) => ({
    id: `common-${index}`,
    english: `word${index}`,
    meaning: `释义${index}`,
    priority: false,
    tags: index === 0 ? ['本课重点'] : [],
  }));
  render(
    <FeedbackProvider>
      <MaterialsPage
        dictionary={[]}
        commonWords={words}
        materials={[]}
        onMaterials={vi.fn()}
        onCommonWords={vi.fn()}
        onMake={vi.fn()}
        onSaveCommon={vi.fn()}
      />
    </FeedbackProvider>,
  );
  fireEvent.mouseDown(screen.getByRole('tab', { name: '常用词库 · 51' }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByRole('cell', { name: 'word50' })).toBeVisible();
  const query = screen.getByRole('textbox', { name: '搜索教学材料' });
  fireEvent.change(query, { target: { value: 'word0' } });
  expect(screen.getByRole('cell', { name: 'word0' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  expect(screen.getByText('共 1 条', { exact: true })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  expect(query).toHaveFocus();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('cell', { name: 'word0' })).toBeVisible();
  expect(screen.queryByRole('cell', { name: 'word50' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: '标签筛选' }), {
    target: { value: '本课重点' },
  });
  expect(screen.queryByRole('button', { name: '上一页' })).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'word0' })).toBeVisible();
  expect(words).toHaveLength(51);
  expect(words[50].meaning).toBe('释义50');
});

it('单页常用词差异确认保留数量和保存方式，不提供无效翻页', () => {
  render(
    <FeedbackProvider>
      <CommonWordsDialog
        entries={materialFixture().entries}
        existing={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    </FeedbackProvider>,
  );
  expect(screen.getByText('共 1 条', { exact: true })).toBeVisible();
  expect(screen.queryByRole('button', { name: '上一页' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'knowledge保存方式' })).toHaveValue('new');
});
