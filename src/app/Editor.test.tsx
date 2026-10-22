// @vitest-environment jsdom
/**
 * 真实编辑组件与保存会话回归。原生对话框及文件服务可控，交互、规则和撤销使用实际模块；
 * 重点验证教师内容保护、迟到结果以及两种成品的独立状态，不把模拟文件服务当成实机验收。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWordBeatLesson, getEntries } from '../games/word-beat/rules';
import { createPresetSuggestion } from '../games/word-beat/suggestions';
import type { WordBeatLesson } from '../games/word-beat/model';
import type { AudioAsset } from '../platform/types';
import type { ExportResult } from '../platform/native';
import { FeedbackProvider } from '../shared/ui';
import { Editor } from './Editor';

const services = vi.hoisted(() => ({
  save: vi.fn(),
  copy: vi.fn(),
  get: vi.fn(),
  prepared: vi.fn(),
  select: vi.fn(),
  importAudio: vi.fn(),
  inspectMusic: vi.fn(),
  prepareMusic: vi.fn(),
  cancelMusic: vi.fn(),
  commitMusic: vi.fn(),
  retain: vi.fn(),
  release: vi.fn(),
  exportHtml: vi.fn(),
  exportPackage: vi.fn(),
  open: vi.fn(),
  validate: vi.fn(),
  html: vi.fn(),
  voices: vi.fn(),
  produce: vi.fn(),
}));
vi.mock('../platform/repository', () => ({
  desktopAvailable: true,
  saveLesson: services.save,
  saveLocalLessonCopy: services.copy,
  getLesson: services.get,
  markPrepared: services.prepared,
  readAssetData: vi.fn(),
}));
vi.mock('../platform/native', () => ({
  listVoices: services.voices,
  selectFile: services.select,
  importAudio: services.importAudio,
  inspectMusic: services.inspectMusic,
  prepareMusic: services.prepareMusic,
  cancelMusic: services.cancelMusic,
  commitMusic: services.commitMusic,
  retainAssets: services.retain,
  releaseAssets: services.release,
  exportHtml: services.exportHtml,
  exportLessonPackage: services.exportPackage,
  openExport: services.open,
}));
vi.mock('../platform/audio-preview', () => ({
  stopPreview: vi.fn(),
  previewAudio: vi.fn(),
  validatePlayableAssets: services.validate,
}));
vi.mock('../games/word-beat/production', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../games/word-beat/production')>()),
  produceLesson: services.produce,
}));
vi.mock('../portable/export', () => ({
  createClassroomHtml: services.html,
  suggestClassroomFileName: (name: string) => `${name}.html`,
}));
vi.mock('../games/word-beat/Classroom', () => ({
  WordBeatClassroom: ({ onExit }: { onExit: () => void }) => (
    <div>
      <p>真实运行核心由课堂组件专项验收</p>
      <button onClick={onExit}>退出测试课堂</button>
    </div>
  ),
}));

/** 由测试精确释放原生服务，复现对话框或磁盘慢于教师编辑的边界。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const lesson = createWordBeatLesson(
    [
      { id: 'first', english: 'knowledge', meaning: '知识', priority: false },
      { id: 'second', english: 'confidence', meaning: '信心', priority: false },
    ],
    { soundMode: 'teacher', name: '高中复习' },
  );
  // Existing lesson fixtures retain their saved two-round configuration.
  getEntries(lesson).forEach((entry) => {
    entry.rounds.value = 2;
  });
  lesson.revision = 3;
  Object.values(lesson.gameData.slogans).forEach((slogan) => {
    slogan.enabled = false;
  });
  return lesson;
}

function fileResult(name: string, completed = true): ExportResult {
  return {
    path: `E:/课堂/${name}`,
    localCopy: `C:/成品/${name}`,
    sha256: 'test-hash',
    byteLength: 100,
    completed,
  };
}

function mount(initial = fixture(), initialAssets: Record<string, AudioAsset> = {}) {
  let flush: (() => Promise<WordBeatLesson>) | null = null;
  const currentAssets = { current: initialAssets };
  const onAssets = vi.fn((next: Record<string, AudioAsset>) => {
    currentAssets.current = { ...currentAssets.current, ...next };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderEditor = (active = true) => (
    <QueryClientProvider client={client}>
      <FeedbackProvider>
        <Editor
          active={active}
          initial={initial}
          assets={currentAssets.current}
          dictionary={[]}
          commonWords={[]}
          onAssets={onAssets}
          onExit={vi.fn()}
          onSaveCommon={vi.fn()}
          onRegisterFlush={(next) => {
            flush = next;
          }}
        />
      </FeedbackProvider>
    </QueryClientProvider>
  );
  const result = render(renderEditor());
  return {
    ...result,
    setActive: (active: boolean) => result.rerender(renderEditor(active)),
    onAssets,
    requestLeave: () => flush!(),
    assetSnapshot: () => currentAssets.current,
    snapshot: async () => {
      let saved!: WordBeatLesson;
      await act(async () => {
        saved = await flush!();
      });
      return saved;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.voices.mockResolvedValue([]);
  services.inspectMusic.mockResolvedValue({ video: false, tracks: [], selectedTrack: null });
  services.prepareMusic.mockResolvedValue(undefined);
  services.cancelMusic.mockResolvedValue(undefined);
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
  services.save.mockImplementation(async (document: WordBeatLesson, expected: number) => ({
    ...structuredClone(document),
    revision: expected + 1,
  }));
  services.prepared.mockImplementation(async (document: WordBeatLesson) => ({
    ...structuredClone(document),
    preparedRevision: document.revision,
  }));
  services.copy.mockImplementation(async (document: WordBeatLesson, name: string) => ({
    ...structuredClone(document),
    id: crypto.randomUUID(),
    name,
    revision: 1,
  }));
  services.get.mockResolvedValue(fixture());
  services.select.mockResolvedValue(null);
  services.retain.mockResolvedValue(undefined);
  services.release.mockResolvedValue(undefined);
  services.validate.mockResolvedValue(undefined);
  services.html.mockResolvedValue('<!doctype html><html></html>');
  services.exportHtml.mockResolvedValue(fileResult('课堂.html'));
  services.exportPackage.mockResolvedValue(fileResult('课件.ecglesson'));
  services.open.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('教师编辑与差异保护', () => {
  it('公共成果课堂覆盖期间停用编辑热键，返回时保留原草稿和历史', async () => {
    const { snapshot, setActive } = mount();
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '后台保留草稿' } });
    await snapshot();
    const savedCalls = services.save.mock.calls.length;
    setActive(false);
    for (const key of ['z', 'y', 's']) {
      expect(fireEvent.keyDown(document.body, { key, ctrlKey: true })).toBe(true);
      expect((await snapshot()).name).toBe('后台保留草稿');
      expect(services.save).toHaveBeenCalledTimes(savedCalls);
    }
    expect(screen.queryByText('课件已保存')).not.toBeInTheDocument();
    setActive(true);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(screen.getByLabelText('课件名称')).toHaveValue('高中复习');
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
    expect(screen.getByLabelText('课件名称')).toHaveValue('后台保留草稿');
    await snapshot();
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    expect(await screen.findByText('课件已保存')).toBeInTheDocument();
  });

  it('课堂中编辑热键不修改后台草稿，退出后恢复撤销、重做和保存', async () => {
    const { snapshot } = mount();
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '第一步修改' } });
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '第二步修改' } });
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(screen.getByLabelText('课件名称')).toHaveValue('第一步修改');
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重做' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '预演 / 上课' }));
    const exit = await screen.findByRole('button', { name: '退出测试课堂' });
    const savedCalls = services.save.mock.calls.length;

    // 每个按键后分别检查，避免撤销和重做互相抵消后漏报后台内容变化。
    for (const key of ['z', 'y', 's']) {
      expect(fireEvent.keyDown(exit, { key, ctrlKey: true })).toBe(true);
      expect((await snapshot()).name).toBe('第一步修改');
      expect(services.save).toHaveBeenCalledTimes(savedCalls);
    }
    expect(screen.queryByText('课件已保存')).not.toBeInTheDocument();

    fireEvent.click(exit);
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
    expect(screen.getByLabelText('课件名称')).toHaveValue('第二步修改');
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(screen.getByLabelText('课件名称')).toHaveValue('第一步修改');
    await snapshot();
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    expect(await screen.findByText('课件已保存')).toBeInTheDocument();
  });

  it('课件名保留完整Unicode输入，口号预览按展开后的码点即时检查且不截断', async () => {
    const lesson = fixture();
    lesson.gameData.slogans.opening.enabled = true;
    lesson.gameData.slogans.opening.text = '{{lessonName}}';
    const { snapshot } = mount(lesson);
    const name = screen.getByLabelText('课件名称');
    expect(name).not.toHaveAttribute('maxlength');
    fireEvent.click(screen.getByText('声音、口号及导出设置'));
    fireEvent.change(name, { target: { value: '𠮷'.repeat(80) } });
    expect((await snapshot()).name).toBe('𠮷'.repeat(80));
    const preview = screen.getByLabelText('开场口号最终口号预览');
    expect(within(preview).getByText('𠮷'.repeat(80))).toBeVisible();
    expect(preview).toHaveTextContent('80 / 60 字符');
    expect(screen.getByLabelText('开场口号文本')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('课件名需为1～80个字符。')).not.toBeInTheDocument();
    fireEvent.change(name, { target: { value: '𠮷'.repeat(60) } });
    expect(preview).toHaveTextContent('60 / 60 字符');
    expect(screen.getByLabelText('开场口号文本')).not.toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(name, { target: { value: '𠮷'.repeat(81) } });
    expect((await snapshot()).name).toBe('𠮷'.repeat(81));
    expect(screen.getByRole('button', { name: /课件名需为1～80个字符/u })).toBeInTheDocument();
  });

  it('时间建议保留检查快照，无关释义编辑仍有效，依赖变化后须明确重查', async () => {
    const lesson = fixture();
    const original = getEntries(lesson)[0];
    lesson.gameData.segments[0].entries = Array.from({ length: 20 }, (_, index) => ({
      ...structuredClone(original),
      id: `time-${index}`,
      english: `word${index}`,
    }));
    lesson.gameData.targetDurationMs = 60_000;
    const { snapshot } = mount(lesson);
    fireEvent.click(screen.getByRole('button', { name: '检查时间建议' }));
    const saved = await snapshot();
    const originalSuggestion = saved.gameData.suggestionHistory!.find(
      (item) => item.kind === 'time',
    )!;
    const card = () =>
      screen.getByText('调整练习以接近目标时长').closest('.suggestion') as HTMLElement;
    expect(within(card()).getByRole('button', { name: '应用全部' })).toBeEnabled();
    // 阅读建议本身不触发跳转；教师明确定位后聚焦实际差异字段，且不会应用建议。
    expect(within(card()).getByRole('heading').closest('button')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: '定位词条' }));
    await waitFor(() => expect(screen.getByLabelText('练习轮数')).toHaveFocus());
    expect(getEntries(await snapshot())[0].rounds.value).toBe(2);
    fireEvent.change(screen.getByLabelText('教学释义'), { target: { value: '教师改写的释义' } });
    expect(within(card()).getByRole('button', { name: '应用全部' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('练习轮数'), { target: { value: '3' } });
    expect(within(card()).getByRole('button', { name: '需重新检查' })).toBeDisabled();
    const stale = (await snapshot()).gameData.suggestionHistory!.find(
      (item) => item.kind === 'time',
    )!;
    expect(stale.id).toBe(originalSuggestion.id);
    expect(stale.changes).toEqual(originalSuggestion.changes);
    fireEvent.click(within(card()).getByRole('button', { name: '重新检查' }));
    expect(within(card()).getByRole('button', { name: '应用全部' })).toBeEnabled();
    const refreshed = (await snapshot()).gameData.suggestionHistory!.find(
      (item) => item.kind === 'time',
    )!;
    expect(refreshed.id).not.toBe(originalSuggestion.id);
    expect(refreshed.changes.every((change) => change.objectId !== 'time-0')).toBe(true);
  });

  it('批改显示共同值及多个值，只写入本次改动，不改变未指定来源', async () => {
    const lesson = fixture();
    getEntries(lesson)[0].rounds = { value: 4, source: 'manual', locked: true };
    const { snapshot } = mount(lesson);
    fireEvent.click(screen.getByRole('button', { name: '全选当前词表' }));
    fireEvent.click(screen.getByRole('button', { name: '批量修改' }));
    const dialog = screen.getByRole('dialog', { name: '批量修改 2 条词汇' });
    expect(within(dialog).getByRole('spinbutton', { name: '练习轮数' })).toHaveAttribute(
      'placeholder',
      '多个值',
    );
    expect(within(dialog).getByRole('spinbutton', { name: '批量教师示范拍数' })).toHaveValue(2);
    fireEvent.click(within(dialog).getByLabelText('修改批量重点'));
    fireEvent.change(within(dialog).getByLabelText('批量重点'), { target: { value: 'yes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '整批应用' }));
    const saved = getEntries(await snapshot());
    expect(saved.map((entry) => entry.rounds)).toEqual([
      { value: 4, source: 'manual', locked: true },
      { value: 3, source: 'preset', locked: false },
    ]);
    expect(saved.every((entry) => entry.modelBeats.source === 'preset')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(getEntries(await snapshot()).map((entry) => entry.priority)).toEqual([false, false]);
  });

  it('过期的预设建议重新检查仍为预设切换，保留具体手动值和锁定项', async () => {
    const lesson = fixture();
    const suggestion = createPresetSuggestion(lesson, 'focus')!;
    getEntries(lesson)[0].rounds = { value: 4, source: 'manual', locked: true };
    lesson.gameData.suggestionHistory = [suggestion];
    const { snapshot } = mount(lesson);
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    const cards = document.querySelectorAll<HTMLElement>('.suggestion');
    const current = [...cards].find(
      (card) =>
        within(card).queryByRole('button', { name: '应用全部' }) &&
        !within(card).getByRole<HTMLButtonElement>('button', { name: '应用全部' }).disabled,
    )!;
    expect(within(current).getByRole('heading', { name: '切换练习预设' })).toBeInTheDocument();
    expect(
      within(current).getByText(/knowledge · 轮数 4 轮（教师手动、已锁定）/u),
    ).toBeInTheDocument();
    fireEvent.click(within(current).getByRole('button', { name: '应用全部' }));
    const saved = await snapshot();
    expect(saved.gameData.preset).toBe('focus');
    expect(getEntries(saved)[0].rounds.value).toBe(4);
    expect(getEntries(saved)[1].rounds.value).toBe(3);
  });

  it('允许小数目标时长，音量可用数字修订且与滑杆同步', async () => {
    const { snapshot } = mount();
    fireEvent.click(screen.getByText('声音、口号及导出设置'));
    fireEvent.change(screen.getByLabelText('目标时长（分钟）'), { target: { value: '7.5' } });
    fireEvent.change(screen.getByLabelText('节拍音量数值（%）'), { target: { value: '18' } });
    expect(screen.getByRole('slider', { name: '节拍音量' })).toHaveValue('18');
    const saved = await snapshot();
    expect(saved.gameData.targetDurationMs).toBe(450000);
    expect(saved.gameData.volumes.beat).toBe(0.18);
    expect(saved.draftInputs?.target).toBeUndefined();
  });

  it('窄屏属性仅挂载一份表单，问题点击打开抽屉并聚焦原始错误', async () => {
    window.innerWidth = 911;
    const lesson = fixture();
    lesson.draftInputs = {
      [`${getEntries(lesson)[0].id}.rounds`]: {
        raw: '99',
        message: '请输入 1～8 的整数。',
        objectId: getEntries(lesson)[0].id,
      },
    };
    getEntries(lesson)[0].meaningSource = {
      name: '高中词库',
      version: 'v1',
      english: 'knowledge',
      originalMeaning: '知识',
      teacherRevised: true,
      acceptedFields: ['meaning'],
    };
    mount(lesson);
    fireEvent.click(screen.getByRole('button', { name: /^检查（/u }));
    fireEvent.click(screen.getByRole('button', { name: /请输入 1～8 的整数/u }));
    const drawer = await screen.findByRole('dialog', { name: '词条属性' });
    const rounds = within(drawer).getByLabelText('练习轮数');
    await waitFor(() => expect(rounds).toHaveFocus());
    expect(document.querySelectorAll('[aria-label="词条英文"]')).toHaveLength(1);
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(within(drawer).getByText('教师修订')).toBeInTheDocument();
    expect(within(drawer).getByText('未记录校对状态')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByText('查看来源与原文'));
    expect(within(drawer).getByText(/词义来源：高中词库 · v1/u)).toBeInTheDocument();
  });

  it('未应用的导入可继续编辑，页面离开取消不会把输入写入词表', async () => {
    const { snapshot, requestLeave } = mount();
    fireEvent.click(screen.getByRole('button', { name: '导入 / 粘贴' }));
    const imported = screen.getByRole('dialog', { name: '追加教学词汇' });
    const input = within(imported).getByLabelText('教学词表');
    fireEvent.change(input, { target: { value: 'responsibility\t责任' } });
    fireEvent.keyDown(imported, { key: 'Escape' });
    const confirmation = await screen.findByRole('dialog', { name: '未保存的修改' });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
    });
    expect(input).toHaveValue('responsibility\t责任');
    let leaving!: Promise<WordBeatLesson | string>;
    act(() => {
      leaving = requestLeave().catch((cause: DOMException) => cause.name);
    });
    const leaveConfirmation = await screen.findByRole('dialog', { name: '未保存的修改' });
    await act(async () => {
      fireEvent.click(within(leaveConfirmation).getByRole('button', { name: '继续编辑' }));
    });
    expect(await leaving).toBe('AbortError');
    expect(input).toHaveValue('responsibility\t责任');
    fireEvent.keyDown(imported, { key: 'Escape' });
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: '未保存的修改' })).getByRole('button', {
        name: '放弃修改',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getEntries(await snapshot()).map((entry) => entry.english)).toEqual([
      'knowledge',
      'confidence',
    ]);
  });

  it('批量未提交修改退出前确认，放弃不改词表，实际应用可整次撤销', async () => {
    const { snapshot } = mount();
    fireEvent.click(screen.getByRole('button', { name: '全选当前词表' }));
    fireEvent.click(screen.getByRole('button', { name: '批量修改' }));
    const dialog = screen.getByRole('dialog', { name: '批量修改 2 条词汇' });
    fireEvent.click(within(dialog).getByLabelText('修改练习轮数'));
    fireEvent.change(within(dialog).getByLabelText('练习轮数'), {
      target: { value: '4' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    const confirmation = await screen.findByRole('dialog', { name: '未保存的修改' });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
    });
    expect(within(dialog).getByLabelText('练习轮数')).toHaveValue(4);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: '未保存的修改' })).getByRole('button', {
        name: '放弃修改',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getEntries(await snapshot()).map((entry) => entry.rounds.value)).toEqual([2, 2]);
    fireEvent.click(screen.getByRole('button', { name: '批量修改' }));
    fireEvent.click(screen.getByLabelText('修改练习轮数'));
    fireEvent.change(
      within(screen.getByRole('dialog', { name: '批量修改 2 条词汇' })).getByLabelText('练习轮数'),
      {
        target: { value: '4' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: '整批应用' }));
    expect(getEntries(await snapshot()).map((entry) => entry.rounds.value)).toEqual([4, 4]);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(getEntries(await snapshot()).map((entry) => entry.rounds.value)).toEqual([2, 2]);
  });

  it('历史版本确认能识别仅改变段名和词序的草稿', async () => {
    const old = fixture();
    old.preparedRevision = old.revision;
    const lesson = structuredClone(old);
    lesson.revision = 4;
    lesson.gameData.segments[0].name = '重点回顾';
    lesson.gameData.segments[0].entries.reverse();
    services.get.mockResolvedValue(old);
    mount(lesson);
    fireEvent.click(screen.getByText('声音、口号及导出设置'));
    fireEvent.click(
      screen.getByLabelText('预演 / 上课使用上次已准备版本 v3（启动前查看版本差异）'),
    );
    fireEvent.click(screen.getByRole('button', { name: '预演 / 上课' }));
    const dialog = await screen.findByRole('dialog', { name: '使用上次已准备版本' });
    expect(
      within(dialog).getByText(/新增或修改 0 条、移除 0 条；段落与词序已有变化/u),
    ).toBeInTheDocument();
    expect(services.prepared).not.toHaveBeenCalled();
  });
});

describe('异步文件结果与固定导出版本', () => {
  it('卸载时终止本地制作观察，迟到成果不写回已离开的编辑会话', async () => {
    const pending = deferred<{ lesson: WordBeatLesson; assets: Record<string, AudioAsset> }>();
    services.produce.mockReturnValue(pending.promise);
    const { unmount, onAssets } = mount();
    fireEvent.click(screen.getByRole('button', { name: '制作 / 更新声音' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalled());
    const signal = services.produce.mock.calls[0][4] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ lesson: fixture(), assets: {} }));
    expect(onAssets).not.toHaveBeenCalled();
  });

  it('音乐返回前离开编辑器，不向已卸载课件绑定音乐或上报局部素材', async () => {
    const imported = deferred<void>();
    services.select.mockResolvedValue({ token: 'music', name: '节奏.mp3', byteLength: 100 });
    services.prepareMusic.mockReturnValue(imported.promise);
    const { unmount, onAssets } = mount();
    fireEvent.click(screen.getByText('声音、口号及导出设置'));
    fireEvent.click(screen.getByRole('button', { name: '导入音乐' }));
    await screen.findByText('等待确认');
    fireEvent.click(screen.getAllByRole('button', { name: '导入音乐' }).at(-1)!);
    await waitFor(() => expect(services.prepareMusic).toHaveBeenCalled());
    unmount();
    await act(async () => imported.resolve(undefined));
    expect(onAssets).not.toHaveBeenCalled();
    expect(services.save).not.toHaveBeenCalled();
  });

  it('导入新音乐只追加资源，不从父级资源库移除已存在素材', async () => {
    const existing: AudioAsset = {
      assetId: 'existing-voice',
      kind: 'speech',
      mimeType: 'audio/wav',
      durationMs: 1000,
      byteLength: 100,
      sha256: 'existing',
    };
    const imported: AudioAsset = {
      assetId: 'new-music',
      kind: 'music',
      mimeType: 'audio/mpeg',
      durationMs: 1000,
      byteLength: 100,
      sha256: 'music',
    };
    services.select.mockResolvedValue({ token: 'music', name: '节奏.mp3', byteLength: 100 });
    services.commitMusic.mockResolvedValue(imported);
    const { assetSnapshot } = mount(fixture(), { [existing.assetId]: existing });
    fireEvent.click(screen.getByText('声音、口号及导出设置'));
    fireEvent.click(screen.getByRole('button', { name: '导入音乐' }));
    await screen.findByText('等待确认');
    fireEvent.click(screen.getAllByRole('button', { name: '导入音乐' }).at(-1)!);
    await waitFor(() => expect(assetSnapshot()).toHaveProperty('new-music', imported));
    expect(assetSnapshot()).toHaveProperty('existing-voice', existing);
  });

  it('保存冲突查看与取消重载均保留本地输入，不能用重试强行抬高版本', async () => {
    const lesson = fixture();
    const saved = { ...structuredClone(lesson), name: '其他窗口的保存', revision: 9 };
    services.get.mockResolvedValue(saved);
    services.save.mockRejectedValueOnce(
      Object.assign(new Error('课件已有更新'), { code: 'REVISION_CONFLICT' }),
    );
    const { requestLeave } = mount(lesson);
    fireEvent.change(screen.getByLabelText('课件名称'), {
      target: { value: '必须保留的本地输入' },
    });
    await act(async () => {
      await expect(requestLeave()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    });
    expect(screen.getByText('保存冲突 · 当前输入尚未保存')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试保存' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看已保存版本（只读）' }));
    const readonly = await screen.findByRole('dialog', { name: '已保存版本（只读）' });
    expect(within(readonly).getByText('其他窗口的保存 · v9')).toBeInTheDocument();
    expect(within(readonly).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(within(readonly).getByRole('button', { name: '关闭对话框' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃本地输入并重载' }));
    const confirmation = await screen.findByRole('dialog', { name: '放弃本地输入并重载' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('课件名称')).toHaveValue('必须保留的本地输入');
    expect(services.save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('课件名称')).toHaveFocus();
  });

  it('冲突另存失败保留错误输入，成功用本地草稿建立独立副本再继续编辑', async () => {
    const lesson = fixture();
    const id = getEntries(lesson)[0].id;
    services.save.mockRejectedValueOnce(
      Object.assign(new Error('课件已有更新'), { code: 'REVISION_CONFLICT' }),
    );
    services.copy.mockRejectedValueOnce(new Error('副本保存失败'));
    const { requestLeave, snapshot } = mount(lesson);
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '本地未保存课件' } });
    fireEvent.change(screen.getByLabelText('练习轮数'), { target: { value: '99' } });
    await act(async () => {
      await expect(requestLeave()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    });
    fireEvent.click(screen.getByRole('button', { name: '另存当前输入为副本' }));
    const dialog = screen.getByRole('dialog', { name: '另存当前输入为副本' });
    fireEvent.change(within(dialog).getByLabelText('副本名称'), { target: { value: '安全副本' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存副本并继续编辑' }));
    await waitFor(() => expect(within(dialog).getByText('副本保存失败')).toBeInTheDocument());
    expect(services.copy.mock.calls[0][0]).toMatchObject({
      id: lesson.id,
      name: '本地未保存课件',
      draftInputs: { [`${id}.rounds`]: { raw: '99' } },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存副本并继续编辑' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const copy = await snapshot();
    expect(copy.id).not.toBe(lesson.id);
    expect(copy.name).toBe('安全副本');
    expect(copy.draftInputs?.[`${id}.rounds`]?.raw).toBe('99');
    expect(screen.queryByText('保存冲突 · 当前输入尚未保存')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    expect(lesson.name).toBe('高中复习');
  });

  it('确认重载后清除旧撤销历史并使用已保存修订作为后续保存基线', async () => {
    const lesson = fixture();
    services.get.mockResolvedValue({
      ...structuredClone(lesson),
      name: '已确认的保存版',
      revision: 9,
    });
    services.save.mockRejectedValueOnce(
      Object.assign(new Error('课件已有更新'), { code: 'REVISION_CONFLICT' }),
    );
    const { requestLeave, snapshot } = mount(lesson);
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '将放弃的输入' } });
    await act(async () => {
      await expect(requestLeave()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    });
    fireEvent.click(screen.getByRole('button', { name: '放弃本地输入并重载' }));
    const dialog = await screen.findByRole('dialog', { name: '放弃本地输入并重载' });
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃本地输入并重载' }));
    await waitFor(() => expect(screen.getByLabelText('课件名称')).toHaveValue('已确认的保存版'));
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '新版本上的修改' } });
    expect((await snapshot()).revision).toBe(10);
    expect(services.save.mock.calls.at(-1)?.[1]).toBe(9);
  });

  it('窄屏词表和预览均常驻检查建议，零问题仍能主动打开检查抽屉', async () => {
    window.innerWidth = 911;
    mount();
    for (const tab of ['词表', '课堂预览']) {
      fireEvent.click(screen.getByRole('button', { name: tab }));
      expect(screen.getByRole('button', { name: '检查（0）' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '建议（0）' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '检查（0）' }));
      const drawer = screen.getByRole('dialog', { name: '智能检查' });
      expect(within(drawer).getByText('检查完成，当前没有需要处理的问题。')).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('button', { name: '关闭对话框' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: tab })).toHaveAttribute('aria-selected', 'true');
    }
    fireEvent.click(screen.getByRole('button', { name: '建议（0）' }));
    expect(screen.getByRole('dialog', { name: '智能建议与改编' })).toBeInTheDocument();
  });

  it('批量字段默认未授权，已选字段留空明确报错，取消该字段后不会写入空值', async () => {
    const { snapshot } = mount();
    fireEvent.click(screen.getByRole('button', { name: '全选当前词表' }));
    fireEvent.click(screen.getByRole('button', { name: '批量修改' }));
    const dialog = screen.getByRole('dialog', { name: '批量修改 2 条词汇' });
    expect(within(dialog).getByLabelText('练习轮数')).toBeDisabled();
    expect(within(dialog).getByLabelText('批量重点')).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText('修改练习轮数'));
    fireEvent.change(within(dialog).getByLabelText('练习轮数'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '整批应用' }));
    expect(
      within(dialog).getByText('整批未应用：已勾选的修改字段不能为空，请填写或取消勾选。'),
    ).toBeInTheDocument();
    expect(services.save).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByLabelText('修改练习轮数'));
    fireEvent.click(within(dialog).getByLabelText('修改批量重点'));
    fireEvent.change(within(dialog).getByLabelText('批量重点'), { target: { value: 'yes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '整批应用' }));
    const entries = getEntries(await snapshot());
    expect(
      entries.every(
        (entry) => entry.priority && entry.rounds.source === 'preset' && entry.rounds.value === 3,
      ),
    ).toBe(true);
  });

  it('改编每次重新授权且父项关闭清除手动覆盖，范围重开后旧预览不能应用', async () => {
    const lesson = fixture();
    lesson.gameData.slogans.opening.enabled = true;
    const original = lesson.gameData.slogans.opening.text;
    const { snapshot } = mount(lesson);
    fireEvent.click(screen.getByRole('button', { name: '换一版' }));
    let dialog = screen.getByRole('dialog', { name: '智能改编范围' });
    const restore = within(dialog).getByLabelText('恢复由预设管理的参数');
    const manual = within(dialog).getByLabelText('明确允许恢复未锁定的教师手动参数');
    expect(manual).toBeDisabled();
    fireEvent.click(restore);
    fireEvent.click(manual);
    expect(manual).toBeChecked();
    fireEvent.click(restore);
    expect(manual).not.toBeChecked();
    expect(manual).toBeDisabled();
    fireEvent.click(restore);
    expect(manual).not.toBeChecked();
    fireEvent.click(manual);
    fireEvent.click(within(dialog).getByLabelText('允许替换手改口号'));
    fireEvent.click(within(dialog).getByLabelText('同时调整段内未锁定词序'));
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '换一版' }));
    dialog = screen.getByRole('dialog', { name: '智能改编范围' });
    within(dialog)
      .getAllByRole('checkbox')
      .forEach((box) => expect(box).not.toBeChecked());
    fireEvent.click(within(dialog).getByRole('button', { name: '生成差异预览' }));
    expect(screen.getByRole('button', { name: '应用全部' })).toBeEnabled();
    expect((await snapshot()).gameData.slogans.opening.text).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: '换一版' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '同时调整段内未锁定词序' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('button', { name: '需重新检查' })).toBeDisabled();
    expect((await snapshot()).gameData.slogans.opening.text).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    fireEvent.click(screen.getByRole('button', { name: '生成差异预览' }));
    fireEvent.click(screen.getByRole('button', { name: '应用全部' }));
    expect((await snapshot()).gameData.slogans.opening.text).not.toBe(original);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect((await snapshot()).gameData.slogans.opening.text).toBe(original);
  });

  it('HTML目标复制失败和课件包失败分别报告，保留真实本机路径', async () => {
    services.exportHtml.mockResolvedValue(fileResult('课堂.html', false));
    services.exportPackage.mockRejectedValue(new Error('U 盘空间不足'));
    mount();
    const dialog = await beginExport(true);
    await waitFor(() =>
      expect(within(dialog).getByText('本机成品已保留，目标复制未完成')).toBeInTheDocument(),
    );
    expect(within(dialog).getByText('U 盘空间不足')).toBeInTheDocument();
    expect(within(dialog).getByText('C:/成品/课堂.html')).toBeInTheDocument();
    expect(within(dialog).queryByText('目标文件已校验并保存')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => expect(services.open).toHaveBeenCalledWith('C:/成品/课堂.html', true));
  });

  it('HTML制作失败仍可保存同组课件包，返回后编辑不改变组内固定修订', async () => {
    const html = deferred<string>();
    services.html.mockReturnValue(html.promise);
    const { snapshot } = mount();
    const dialog = await beginExport(true);
    await waitFor(() => expect(services.html).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole('button', { name: '返回（后台继续）' }));
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '导出后新草稿' } });
    expect((await snapshot()).revision).toBe(4);
    await act(async () => html.reject(new Error('课堂文件超出大小限制')));
    await waitFor(() =>
      expect(services.exportPackage.mock.calls.at(-1)?.slice(1, 3)).toEqual([3, 3]),
    );
    expect((await snapshot()).name).toBe('导出后新草稿');
  });

  it('原课件后台导出迟到时，不把准备修订写入冲突后另存的新副本', async () => {
    const lesson = fixture();
    lesson.revision = 1;
    const prepared = deferred<WordBeatLesson>();
    services.prepared.mockReturnValueOnce(prepared.promise);
    const { requestLeave, snapshot } = mount(lesson);
    const exportDialog = await beginExport();
    await waitFor(() => expect(services.prepared).toHaveBeenCalled());
    fireEvent.click(within(exportDialog).getByRole('button', { name: '返回（后台继续）' }));

    services.save.mockRejectedValueOnce(
      Object.assign(new Error('课件已有更新'), { code: 'REVISION_CONFLICT' }),
    );
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '保留本地修改' } });
    await act(async () => {
      await expect(requestLeave()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    });
    fireEvent.click(screen.getByRole('button', { name: '另存当前输入为副本' }));
    const copyDialog = screen.getByRole('dialog', { name: '另存当前输入为副本' });
    fireEvent.change(within(copyDialog).getByLabelText('副本名称'), {
      target: { value: '正在编辑的独立副本' },
    });
    fireEvent.click(within(copyDialog).getByRole('button', { name: '保存副本并继续编辑' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const copy = await snapshot();
    expect(copy.id).not.toBe(lesson.id);
    expect(copy.preparedRevision).toBeUndefined();

    fireEvent.change(screen.getByLabelText('教学释义'), { target: { value: '副本中新输入' } });
    await act(async () => prepared.resolve({ ...lesson, preparedRevision: lesson.revision }));
    await waitFor(() => expect(services.exportHtml).toHaveBeenCalled());
    const current = await snapshot();
    expect(current.id).toBe(copy.id);
    expect(current.preparedRevision).toBe(copy.preparedRevision);
    expect(current.name).toBe('正在编辑的独立副本');
    expect(getEntries(current)[0].meaning).toBe('副本中新输入');
    expect(services.exportHtml.mock.calls.at(-1)?.slice(2, 4)).toEqual([
      lesson.id,
      lesson.revision,
    ]);
  });

  it('独立课件包使用flush返回的草稿和准备版，不在原生对话框结束时重新取版本', async () => {
    const waitPackage = deferred<ExportResult>();
    services.exportPackage.mockReturnValue(waitPackage.promise);
    const lesson = fixture();
    lesson.preparedRevision = 2;
    const { snapshot } = mount(lesson);
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '第一次修改' } });
    fireEvent.click(screen.getByText('声音、口号及导出设置'));
    fireEvent.click(screen.getByRole('button', { name: '独立导出可编辑包（允许未完成草稿）' }));
    const dialog = await screen.findByRole('dialog', { name: '导出可编辑课件包' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '仅保存可编辑包' })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '仅保存可编辑包' }));
    await waitFor(() =>
      expect(services.exportPackage.mock.calls.at(-1)?.slice(0, 3)).toEqual([lesson.id, 4, 2]),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '返回（后台继续）' }));
    fireEvent.change(screen.getByLabelText('课件名称'), { target: { value: '第二次修改' } });
    expect((await snapshot()).revision).toBe(5);
    await act(async () => waitPackage.resolve(fileResult('固定版本.ecglesson', false)));
    expect(services.exportPackage).toHaveBeenCalledTimes(1);
  });
});

/** 使用真实导出选版界面；原生写盘仍可控，不把服务模拟当作实机成品验收。 */
async function beginExport(alsoPackage = false) {
  fireEvent.click(screen.getByRole('button', { name: '导出课堂文件' }));
  const dialog = await screen.findByRole('dialog', { name: '导出课堂文件' });
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '检查并导出' })).toBeEnabled(),
  );
  if (alsoPackage) fireEvent.click(within(dialog).getByLabelText('同时保存可编辑课件包'));
  fireEvent.click(within(dialog).getByRole('button', { name: '检查并导出' }));
  return dialog;
}
