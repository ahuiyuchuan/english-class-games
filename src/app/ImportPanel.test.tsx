// @vitest-environment jsdom
/**
 * 导入校对的真实组件回归：控制原生读取的完成顺序，检查来源隔离、跨页选择与教师接受范围。
 * 原生文件格式及字节预算由 Rust 集成测试负责，此处不模拟其已通过的结论。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictionaryEntry } from '../platform/materials/types';
import type { MaterialFile, SelectedFile } from '../platform/native';
import type { TeachingEntry } from '../platform/types';
import { ImportPanel } from './ImportPanel';

const environment = vi.hoisted(() => ({ desktop: true }));
const native = vi.hoisted(() => ({ selectFile: vi.fn(), readMaterial: vi.fn() }));
vi.mock('../platform/repository', () => ({
  get desktopAvailable() {
    return environment.desktop;
  },
}));
vi.mock('../platform/native', () => native);

beforeEach(() => {
  environment.desktop = true;
  native.selectFile.mockReset().mockResolvedValue(null);
  native.readMaterial.mockReset();
});
afterEach(cleanup);

/** 手动完成异步读取，用于稳定重现后发先至、重新粘贴和取消选择的边界。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dictionaryEntry(
  english: string,
  meaning = '教学义项',
  patch: Partial<DictionaryEntry> = {},
): DictionaryEntry {
  return {
    english,
    meaning,
    partOfSpeech: 'n.',
    forms: [],
    tags: ['gk'],
    source: '受控高中词库',
    sourceVersion: 'test-1',
    reviewStatus: 'reviewed-sense',
    ...patch,
  };
}

function mount(dictionary: DictionaryEntry[] = [], maxEntries = 2000) {
  const confirm =
    vi.fn<(entries: TeachingEntry[], source: { name: string; original: string }) => void>();
  const result = render(
    <ImportPanel
      dictionary={dictionary}
      commonWords={[]}
      onConfirm={confirm}
      maxEntries={maxEntries}
    />,
  );
  return { confirm, ...result };
}

function pasteVocabulary(value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '教学词表' }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
  const columns = screen.queryAllByLabelText(/第 \d+ 列用途/u);
  if (columns.some((column) => !(column as HTMLSelectElement).value)) {
    confirmColumns(['english', 'meaning', 'partOfSpeech', 'unit', 'tags', 'priority']);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
  }
}

/** 测试也必须模拟教师逐列确认；不能依赖产品根据列数自动猜测。 */
function confirmColumns(purposes: string[]) {
  screen.queryAllByLabelText(/第 \d+ 列用途/u).forEach((column, index) => {
    fireEvent.change(column, { target: { value: purposes[index] ?? 'ignore' } });
  });
}

describe('导入来源隔离与映射', () => {
  it('整理及确认失败统一聚焦摘要，相同错误重复触发仍定位且不改教师校对', async () => {
    const { container, confirm } = mount();
    const analyze = screen.getByRole('button', { name: '整理并预览' });
    fireEvent.click(analyze);
    await waitFor(() => expect(container.querySelector('.error-summary')).toHaveFocus());
    analyze.focus();
    fireEvent.click(analyze);
    await waitFor(() => expect(container.querySelector('.error-summary')).toHaveFocus());
    pasteVocabulary('apple\t教师已确认的苹果');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择第1行' }));
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    await waitFor(() => expect(container.querySelector('.error-summary')).toHaveFocus());
    expect(screen.getByRole('textbox', { name: '第1行释义' })).toHaveValue('教师已确认的苹果');
    expect(screen.getByRole('checkbox', { name: '选择第1行' })).not.toBeChecked();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    { state: '缺少原文', rawText: undefined },
    { state: '空原文', rawText: '' },
  ])('$state的原生工作表不能切成空阅读，校对前后都保留全部来源与教师值', async ({ rawText }) => {
    // 使用 Rust 的实际返回合同：XLSX 只返回 sheets，而不伪造 rawText 或真实文件解码成功。
    native.selectFile.mockResolvedValue({
      token: 'sheets',
      name: '中文工作表.xlsx',
      byteLength: 100,
    });
    native.readMaterial.mockResolvedValue({
      name: '中文工作表.xlsx',
      rawText,
      sheets: [
        {
          name: '第一组',
          rows: [
            ['英文', '释义'],
            ['apple', '苹果'],
          ],
        },
        {
          name: '第二组',
          rows: [
            ['英文', '释义'],
            ['orange', '橙子'],
            ['record', '记录'],
          ],
        },
      ],
      warnings: [],
    } satisfies MaterialFile);
    const { confirm } = mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    const worksheet = await screen.findByRole('combobox', { name: '工作表' });
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先粘贴或导入阅读文章');
    expect(screen.getByRole('button', { name: '词表 / 表格' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(worksheet).getAllByRole('option')).toHaveLength(2);
    expect(worksheet).toHaveValue('0');

    fireEvent.change(worksheet, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    fireEvent.change(screen.getByRole('textbox', { name: '第2行释义' }), {
      target: { value: '教师修订的橙子' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择第3行' }));
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.getByRole('alert')).toHaveTextContent('全部工作表和校对已保留');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '工作表' })).toHaveValue('1');
    expect(
      within(screen.getByRole('combobox', { name: '工作表' })).getAllByRole('option'),
    ).toHaveLength(2);
    expect(screen.getByLabelText('第 2 列用途')).toHaveValue('meaning');
    expect(screen.getByRole('textbox', { name: '第2行释义' })).toHaveValue('教师修订的橙子');
    expect(screen.getByRole('checkbox', { name: '选择第3行' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0]).toHaveLength(1);
    expect(confirm.mock.calls[0][0][0]).toMatchObject({
      english: 'orange',
      meaning: '教师修订的橙子',
    });
    expect(confirm.mock.calls[0][1].name).toBe('中文工作表.xlsx');
  });

  it('手工替换工作表来源为阅读文章后解除保护，不因历史工作表误拦截', async () => {
    native.selectFile.mockResolvedValue({ token: 'sheets', name: '词表.xlsx', byteLength: 100 });
    native.readMaterial.mockResolvedValue({
      name: '词表.xlsx',
      sheets: [{ name: 'Sheet1', rows: [['knowledge', '知识']] }],
      warnings: [],
    } satisfies MaterialFile);
    mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await screen.findByRole('combobox', { name: '工作表' });
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.getByRole('alert')).toHaveTextContent('没有阅读文章原文');
    fireEvent.change(screen.getByRole('textbox', { name: '教学词表' }), {
      target: { value: 'Students share knowledge.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.getByRole('textbox', { name: '高中阅读文本' })).toHaveValue(
      'Students share knowledge.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('重新导入有原始文本的文件后解除纯工作表保护，仍可正常切换阅读', async () => {
    native.selectFile
      .mockResolvedValueOnce({ token: 'sheets', name: '词表.xlsx', byteLength: 100 })
      .mockResolvedValueOnce({ token: 'article', name: '文章.txt', byteLength: 100 });
    native.readMaterial
      .mockResolvedValueOnce({
        name: '词表.xlsx',
        sheets: [{ name: 'Sheet1', rows: [['knowledge', '知识']] }],
        warnings: [],
      } satisfies MaterialFile)
      .mockResolvedValueOnce({
        name: '文章.txt',
        rawText: 'Students share knowledge.',
        sheets: [{ name: '文章.txt', rows: [['Students share knowledge.']] }],
        warnings: [],
      } satisfies MaterialFile);
    mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await screen.findByRole('combobox', { name: '工作表' });
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await screen.findByRole('option', { name: '文章.txt' });
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.getByRole('textbox', { name: '高中阅读文本' })).toHaveValue(
      'Students share knowledge.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('重复选择当前词表类型保留已校对释义、排除范围及列用途', () => {
    const { confirm } = mount();
    pasteVocabulary('apple\t苹果\nrecord\t记录');
    fireEvent.change(screen.getByRole('textbox', { name: '第1行释义' }), {
      target: { value: '苹果；苹果树（教师校对）' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择第2行' }));
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    fireEvent.click(screen.getByRole('button', { name: '词表 / 表格' }));
    expect(screen.getByRole('textbox', { name: '第1行释义' })).toHaveValue(
      '苹果；苹果树（教师校对）',
    );
    expect(screen.getByLabelText('第 2 列用途')).toHaveValue('meaning');
    expect(screen.getByRole('checkbox', { name: '选择第2行' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0]).toHaveLength(1);
    expect(confirm.mock.calls[0][0][0].meaning).toBe('苹果；苹果树（教师校对）');
  });

  it('切换另一材料类型先说明校对损失，取消保留，确认后仅保留原文', () => {
    mount();
    pasteVocabulary('apple\t苹果');
    fireEvent.change(screen.getByRole('textbox', { name: '第1行释义' }), {
      target: { value: '教师修订' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    const dialog = screen.getByRole('dialog', { name: '切换材料类型？' });
    expect(dialog).toHaveTextContent('原文会保留');
    fireEvent.click(within(dialog).getByRole('button', { name: '保留当前校对' }));
    expect(screen.getByRole('textbox', { name: '第1行释义' })).toHaveValue('教师修订');
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }));
    expect(screen.getByRole('textbox', { name: '高中阅读文本' })).toHaveValue('apple\t苹果');
    expect(screen.queryByRole('textbox', { name: '第1行释义' })).not.toBeInTheDocument();
  });

  it('只有原文时切换类型不多问，重复选择阅读类型也保留已选候选', () => {
    mount([dictionaryEntry('apple', '苹果')]);
    fireEvent.change(screen.getByRole('textbox', { name: '教学词表' }), {
      target: { value: 'apple' },
    });
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    const selection = screen.getByRole('checkbox', { name: '选择apple' });
    fireEvent.click(selection);
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    expect(screen.getByRole('checkbox', { name: '选择apple' })).toBeChecked();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('内置六列示例无需测试代选列用途即可到下一步，保留六项内容与独立单元标签', () => {
    const { confirm } = mount();
    fireEvent.click(screen.getByRole('button', { name: '使用示例词表' }));
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByText('校对 6 条教学内容')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^确认内容$/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    const entries = confirm.mock.calls[0][0];
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({
      english: 'achievement',
      unit: 'Unit 1',
      tags: ['高中'],
      priority: true,
    });
    expect(entries[3].english).toBe('make a difference');
  });

  it('无表头材料在映射区就近说明缺项并提供下一步，建议不覆盖人工选择', () => {
    mount();
    fireEvent.change(screen.getByLabelText('教学词表'), {
      target: { value: 'apple\t苹果\tn.\tUnit 1\t是' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByRole('button', { name: '下一步：校对内容' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('第 4 列用途'), { target: { value: 'tags' } });
    fireEvent.click(screen.getByRole('button', { name: '采用列用途建议' }));
    expect(screen.getByLabelText('第 4 列用途')).toHaveValue('tags');
    fireEvent.click(screen.getByRole('button', { name: '下一步：校对内容' }));
    expect(screen.getByText('校对 1 条教学内容')).toBeInTheDocument();
  });
  it('显式保存宿主收到初始和清空状态，不把普通会话导航当丢弃', () => {
    const dirty = vi.fn();
    const view = render(
      <ImportPanel dictionary={[]} commonWords={[]} onConfirm={vi.fn()} onDraftChange={dirty} />,
    );
    expect(dirty).toHaveBeenLastCalledWith(false);
    const text = screen.getByRole('textbox', { name: '教学词表' });
    fireEvent.change(text, { target: { value: 'knowledge' } });
    expect(dirty).toHaveBeenLastCalledWith(true);
    view.rerender(
      <ImportPanel
        dictionary={[]}
        commonWords={[]}
        onConfirm={vi.fn()}
        onDraftChange={dirty}
        disabled
      />,
    );
    expect(text).toBeDisabled();
    view.rerender(
      <ImportPanel dictionary={[]} commonWords={[]} onConfirm={vi.fn()} onDraftChange={dirty} />,
    );
    expect(text).toHaveValue('knowledge');
    fireEvent.change(text, { target: { value: '' } });
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('选择文件尚未返回时不能确认旧预览；取消选择后保留原输入', async () => {
    const pick = deferred<SelectedFile | null>();
    native.selectFile.mockReturnValue(pick.promise);
    const { confirm } = mount();
    pasteVocabulary('knowledge\t知识');
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    const action = screen.getByRole('button', { name: '确认内容' });
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => pick.resolve(null));
    expect(action).toBeEnabled();
    expect(screen.getByLabelText('第1行释义')).toHaveValue('知识');
  });

  it('迟到的文件读取不能覆盖重新粘贴的内容，来源与编码也不回退', async () => {
    const read = deferred<MaterialFile>();
    native.selectFile.mockResolvedValue({ token: 'old', name: '旧材料.xlsx', byteLength: 100 });
    native.readMaterial.mockReturnValue(read.promise);
    const { confirm } = mount();
    pasteVocabulary('old\t旧内容');
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await waitFor(() => expect(native.readMaterial).toHaveBeenCalledWith('old', 'utf-8'));
    expect(screen.queryByRole('button', { name: '确认内容' })).not.toBeInTheDocument();
    pasteVocabulary('new\t新粘贴内容');
    await act(async () =>
      read.resolve({
        name: '旧材料.xlsx',
        sheets: [{ name: 'Sheet1', rows: [['expired', '不应回写']] }],
        warnings: ['旧文件警告'],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '查看或修改原文与列设置' }));
    expect(screen.getByRole('textbox', { name: '教学词表' })).toHaveValue('new\t新粘贴内容');
    expect(screen.queryByText('旧文件警告')).not.toBeInTheDocument();
    expect(screen.getByLabelText('工作表')).toHaveTextContent('粘贴内容');
    expect(screen.getByLabelText('文件编码')).toHaveValue('utf-8');
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0][0].english).toBe('new');
    expect(confirm.mock.calls[0][1]).toEqual({ name: '粘贴词表', original: 'new\t新粘贴内容' });
  });

  it('新文件重置编码与列映射；无表头的homework不被误删且释义仍在第二列', async () => {
    const first: MaterialFile = {
      name: '原表.csv',
      rawText: '释义,英文,单元\n知识,knowledge,Unit1',
      sheets: [
        {
          name: '原表',
          rows: [
            ['释义', '英文', '单元'],
            ['知识', 'knowledge', 'Unit1'],
          ],
        },
      ],
      warnings: [],
    };
    native.selectFile
      .mockResolvedValueOnce({ token: 'first', name: first.name, byteLength: 100 })
      .mockResolvedValueOnce({ token: 'second', name: '新表.txt', byteLength: 100 });
    native.readMaterial
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        name: '新表.txt',
        rawText: 'homework\t家庭作业',
        sheets: [{ name: '新表', rows: [['homework', '家庭作业']] }],
        warnings: [],
      });
    mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await waitFor(() => expect(screen.getByLabelText('第 2 列用途')).toHaveValue('english'));
    expect(screen.getByLabelText('第 3 列用途')).toHaveValue('unit');
    expect(screen.getByRole('checkbox', { name: '首行是表头' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('文件编码'), { target: { value: 'gb18030' } });
    await waitFor(() => expect(native.readMaterial).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '导入文件' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('第 2 列用途'), { target: { value: 'ignore' } });
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await waitFor(() => expect(native.readMaterial).toHaveBeenLastCalledWith('second', 'utf-8'));
    await waitFor(() => expect(screen.getByLabelText('第 1 列用途')).toHaveValue(''));
    expect(screen.getByLabelText('第 2 列用途')).toHaveValue('');
    expect(screen.getByLabelText('文件编码')).toHaveValue('utf-8');
    expect(screen.getByRole('checkbox', { name: '首行是表头' })).not.toBeChecked();
    confirmColumns(['english', 'meaning']);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByLabelText('第1行英文')).toHaveValue('homework');
    expect(screen.getByLabelText('第1行释义')).toHaveValue('家庭作业');
  });

  it('编码重读迟到时保留新的阅读文本，不重新带回旧表格', async () => {
    const late = deferred<MaterialFile>();
    const first: MaterialFile = {
      name: '原表.txt',
      rawText: 'knowledge\t知识',
      sheets: [{ name: '原表', rows: [['knowledge', '知识']] }],
      warnings: [],
    };
    native.selectFile.mockResolvedValue({ token: 'first', name: first.name, byteLength: 100 });
    native.readMaterial.mockResolvedValueOnce(first).mockReturnValueOnce(late.promise);
    mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '教学词表' })).toHaveValue(first.rawText),
    );
    fireEvent.change(screen.getByLabelText('文件编码'), { target: { value: 'gb18030' } });
    await waitFor(() => expect(native.readMaterial).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('checkbox', { name: '首行是表头' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('第 1 列用途')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    fireEvent.change(screen.getByRole('textbox', { name: '高中阅读文本' }), {
      target: { value: 'A fresh reading passage.' },
    });
    await act(async () => late.resolve(first));
    expect(screen.getByRole('textbox', { name: '高中阅读文本' })).toHaveValue(
      'A fresh reading passage.',
    );
    expect(screen.queryByLabelText('第 1 列用途')).not.toBeInTheDocument();
    expect(screen.getByLabelText('文件编码')).toHaveValue('utf-8');
  });

  it('教师可关闭误判表头并取消可选列，第一条词汇及仅英文练习不丢失', async () => {
    const material: MaterialFile = {
      name: '词表.txt',
      rawText: 'word\t单词\nhomework\t家庭作业',
      sheets: [
        {
          name: '词表',
          rows: [
            ['word', '单词'],
            ['homework', '家庭作业'],
          ],
        },
      ],
      warnings: [],
    };
    native.selectFile.mockResolvedValue({ token: 'plain', name: material.name, byteLength: 100 });
    native.readMaterial.mockResolvedValue(material);
    const { confirm } = mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await waitFor(() => expect(screen.getByLabelText('首行是表头')).toBeChecked());
    fireEvent.click(screen.getByLabelText('首行是表头'));
    confirmColumns(['english', 'ignore']);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByLabelText('第1行英文')).toHaveValue('word');
    expect(screen.getByLabelText('第2行英文')).toHaveValue('homework');
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0].map((entry) => [entry.english, entry.meaning])).toEqual([
      ['word', ''],
      ['homework', ''],
    ]);
  });

  it('编码重读失败不能重新提交旧解码内容，保留文件身份供切回正确编码恢复', async () => {
    const material: MaterialFile = {
      name: '编码词表.txt',
      rawText: 'knowledge\t知识',
      sheets: [{ name: '词表', rows: [['knowledge', '知识']] }],
      warnings: [],
    };
    native.selectFile.mockResolvedValue({ token: 'encoded', name: material.name, byteLength: 100 });
    native.readMaterial
      .mockResolvedValueOnce(material)
      .mockRejectedValueOnce(new Error('编码不符，请重新选择编码。'))
      .mockResolvedValueOnce(material);
    const { confirm } = mount();
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    await waitFor(() => expect(screen.getByLabelText('教学词表')).toHaveValue(material.rawText));
    confirmColumns(['english', 'meaning']);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    fireEvent.change(screen.getByLabelText('文件编码'), { target: { value: 'gb18030' } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('编码不符'));
    expect(screen.queryByLabelText('工作表')).not.toBeInTheDocument();
    expect(screen.getByLabelText('教学词表')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.queryByRole('button', { name: '确认内容' })).not.toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('文件编码'), { target: { value: 'utf-8' } });
    await waitFor(() => expect(screen.getByLabelText('教学词表')).toHaveValue(material.rawText));
    expect(native.readMaterial).toHaveBeenLastCalledWith('encoded', 'utf-8');
    confirmColumns(['english', 'meaning']);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0][0]).toMatchObject({ english: 'knowledge', meaning: '知识' });
  });

  it('浏览器文本文件也可校对真实列映射，确认时保留原文与单元', async () => {
    environment.desktop = false;
    const original = '释义,英文,单元\n知识,knowledge,Unit1';
    const bytes = new TextEncoder().encode(original);
    const file = new File([bytes], '列映射.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
    const { container, confirm } = mount();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('第 2 列用途')).toHaveValue('english'));
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByLabelText('第2行英文')).toHaveValue('knowledge');
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0][0]).toMatchObject({
      english: 'knowledge',
      meaning: '知识',
      unit: 'Unit1',
    });
    expect(confirm.mock.calls[0][1].original).toBe(original);
  });
});

describe('候选范围、接受与错误恢复', () => {
  it('无表头五列同样逐列确认，未映射和重复用途不允许绕过，明确忽略才丢弃一列', () => {
    const { confirm } = mount();
    fireEvent.change(screen.getByLabelText('教学词表'), {
      target: { value: 'knowledge\t知识\tn.\tUnit 3\t保留原文' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.queryByLabelText('第1行英文')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(/第 \d+ 列用途/u)).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByRole('alert')).toHaveTextContent('第 1 列用途');
    confirmColumns(['english', 'meaning', 'partOfSpeech', 'unit', 'english']);
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByRole('alert')).toHaveTextContent('用途重复');
    fireEvent.change(screen.getByLabelText('第 5 列用途'), { target: { value: 'ignore' } });
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0][0]).toMatchObject({
      english: 'knowledge',
      meaning: '知识',
      unit: 'Unit 3',
    });
    expect(confirm.mock.calls[0][1].original).toContain('保留原文');
  });

  // 真实51行预览经历整页校验、焦点迁移与往返翻页；全套并行时CPU争用可超过5秒，单独保留10秒预算。
  it('折叠属性保留错误标记，提交摘要定位跨页字段，修改与翻页均不丢失输入', async () => {
    const { confirm, container } = mount();
    pasteVocabulary(
      Array.from(
        { length: 51 },
        (_, index) => `word${index}\t释义\t${index === 50 ? 'x'.repeat(41) : ''}`,
      ).join('\n'),
    );
    // 收起状态不创建隐藏属性表单，避免50行预览仍挂载150个不可见输入。
    expect(screen.queryByLabelText('第1行词性')).not.toBeInTheDocument();
    // 精确文字定位稳定存在的操作，再单独检查语义；避免每次操作都对50行重复计算角色与可见性。
    const submit = screen.getByText('确认内容', { selector: 'button' });
    expect(submit).toHaveAccessibleName('确认内容');
    fireEvent.click(submit);
    const summary = container.querySelector<HTMLElement>('.error-summary')!;
    await waitFor(() => expect(summary).toHaveFocus());
    fireEvent.click(within(summary).getByRole('button', { name: '定位：词性最多 40 字符。' }));
    const input = await screen.findByLabelText('第51行词性');
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue('x'.repeat(41));
    fireEvent.change(input, { target: { value: 'n.' } });
    fireEvent.click(screen.getByText('上一页', { selector: 'button' }));
    fireEvent.click(screen.getByText('下一页', { selector: 'button' }));
    expect(screen.getByLabelText('第51行词性')).toHaveValue('n.');
    fireEvent.click(submit);
    expect(confirm.mock.calls[0][0][50].partOfSpeech).toBe('n.');
  }, 10_000);

  it('批量接受只影响选中且空释义的独立义项，参考多义、超长与教师原值保持原状', () => {
    const dictionary = [
      dictionaryEntry('alpha', '甲'),
      dictionaryEntry('beta', '乙'),
      dictionaryEntry('gamma', '一；二', { reviewStatus: 'reference' }),
      dictionaryEntry('delta', '一'),
      dictionaryEntry('delta', '二'),
      dictionaryEntry('zeta', '字'.repeat(201)),
    ];
    const { confirm } = mount(dictionary);
    pasteVocabulary('alpha\nbeta\ngamma\ndelta\nalpha\t教师原有释义\nzeta');
    expect(screen.getByRole('button', { name: '接受 2 项单一词义候选' })).toBeVisible();
    fireEvent.click(screen.getByLabelText('选择第2行'));
    fireEvent.click(screen.getByRole('button', { name: '接受 1 项单一词义候选' }));
    expect(screen.getByLabelText('第1行释义')).toHaveValue('甲');
    for (const row of [2, 3, 4, 6]) expect(screen.getByLabelText(`第${row}行释义`)).toHaveValue('');
    expect(screen.getByLabelText('第5行释义')).toHaveValue('教师原有释义');
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0]).toHaveLength(5);
    expect(confirm.mock.calls[0][0][0].meaningSource).toMatchObject({
      name: '受控高中词库',
      originalMeaning: '甲',
      acceptedFields: ['meaning', 'partOfSpeech'],
    });
  });

  it('英文和重点源错误修正后即时解除，旧提交错误不持续阻塞确认', () => {
    const { confirm } = mount();
    pasteVocabulary('x'.repeat(121) + '\t教学义项\t\t\t\tmaybe');
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请修正');
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('第1行英文'), { target: { value: 'knowledge' } });
    fireEvent.click(screen.getByLabelText('knowledge设为重点'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('重点标记请填写“是”或“否”。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0][0]).toMatchObject({ english: 'knowledge', priority: true });
  });

  it('命中教师重点的功能词默认展开，其余功能词折叠，仍由教师选词', () => {
    mount([dictionaryEntry('and', '和', { priority: true })]);
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    fireEvent.change(screen.getByRole('textbox', { name: '高中阅读文本' }), {
      target: { value: 'and the' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(screen.getByLabelText('选择and')).not.toBeChecked();
    expect(screen.queryByLabelText('选择the')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('显示功能词与短语内部词'));
    expect(screen.getByLabelText('选择the')).not.toBeChecked();
    expect(screen.getByLabelText('选择and')).not.toBeChecked();
  });

  it('每页50项，分组全选明确覆盖当前结果；隐藏选择与跨页选择保留且不代选词义', () => {
    const words = Array.from(
      { length: 52 },
      (_, position) =>
        `term${String.fromCharCode(97 + Math.floor(position / 26))}${String.fromCharCode(97 + (position % 26))}`,
    );
    const { confirm, container } = mount(words.map((word) => dictionaryEntry(word)));
    fireEvent.click(screen.getByRole('button', { name: '阅读选词' }));
    fireEvent.change(screen.getByRole('textbox', { name: '高中阅读文本' }), {
      target: { value: `${words.join(' ')} and` },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理并预览' }));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: '选中高中词库当前结果（52项）' }));
    expect(screen.getByText('已选 52 项 · 其他页或隐藏项 2 项')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByLabelText(`选择${words[51]}`)).toBeChecked();
    fireEvent.click(screen.getByLabelText('显示功能词与短语内部词'));
    fireEvent.click(screen.getByRole('button', { name: '选中其他原词当前结果（1项）' }));
    fireEvent.click(screen.getByLabelText('显示功能词与短语内部词'));
    expect(screen.getByText('已选 53 项 · 其他页或隐藏项 3 项')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认内容' }));
    expect(confirm.mock.calls[0][0]).toHaveLength(53);
    expect(confirm.mock.calls[0][0].every((entry) => entry.meaning === '')).toBe(true);
    expect(confirm.mock.calls[0][0].at(-1)?.english).toBe('and');
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
    fireEvent.click(screen.getByRole('button', { name: '全选本页' }));
    expect(screen.getByText('已选 50 项')).toBeVisible();
  });
});
