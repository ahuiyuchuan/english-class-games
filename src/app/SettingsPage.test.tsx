// @vitest-environment jsdom
/**
 * 设置页的实际交互边界回归：偏好主动提交、资源引用保留、按选择清理和恢复失败。
 * IPC 在此以受控结果替代，真实 Windows 文件与语音另由原生集成测试验证。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { FeedbackProvider } from '../shared/ui';
import type { TeacherPreferences } from '../platform/repository';
import type { AudioAsset } from '../platform/types';
import type { TaskRecord } from '../platform/native';

const native = vi.hoisted(() => ({
  listVoices: vi.fn(),
  getDataLocation: vi.fn(),
  listExportCopies: vi.fn(),
  clearExportCopies: vi.fn(),
  resourceUsage: vi.fn(),
  deleteResource: vi.fn(),
  cleanCache: vi.fn(),
  selectFile: vi.fn(),
  restoreBackup: vi.fn(),
  exportBackup: vi.fn(),
  openExport: vi.fn(),
  importAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  getTask: vi.fn(),
  cancelTask: vi.fn(),
  clearTask: vi.fn(),
  readAsset: vi.fn(),
}));
const audio = vi.hoisted(() => ({ preview: vi.fn(), stop: vi.fn() }));
const repository = vi.hoisted(() => ({ listAssets: vi.fn(), saveLesson: vi.fn() }));
vi.mock('../platform/native', () => native);
vi.mock('../platform/audio-preview', () => ({
  previewAudio: audio.preview,
  stopPreview: audio.stop,
  validatePlayableAssets: vi.fn(),
}));
vi.mock('../platform/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/repository')>()),
  desktopAvailable: true,
  ...repository,
}));

/** 三种实际用途故意同时存在，避免把配音文件误列为可选背景音乐。 */
const assets: AudioAsset[] = [
  { assetId: 'music', kind: 'music', name: '课堂背景', durationMs: 60_000 },
  { assetId: 'recording', kind: 'recording', name: '教师录音', durationMs: 3_000 },
  { assetId: 'speech', kind: 'speech', name: '英文配音', durationMs: 1_000 },
].map((asset) => ({
  ...asset,
  byteLength: 100_000,
  mimeType: 'audio/wav',
  sha256: 'a'.repeat(64),
})) as AudioAsset[];

const copyA = { path: 'D:/managed/exports/a.html', name: '早读课.html', byteLength: 2_000_000 };
const copyB = {
  path: 'D:/managed/exports/b.ecglesson',
  name: '晚读课.ecglesson',
  byteLength: 3_000_000,
};

/** 试听任务仅用于异步生命周期；实际合成和设备播放由原生验收覆盖。 */
function previewTask(state: TaskRecord['state'] = 'completed'): TaskRecord {
  return {
    taskId: 'settings-preview-task',
    kind: 'speech',
    state,
    stage: '配音',
    completed: state === 'completed' ? 1 : 0,
    total: 1,
    results:
      state === 'completed'
        ? [
            {
              requestId: 'preview-request',
              objectId: 'voice-preview',
              asset: assets[2],
              cached: false,
            },
          ]
        : [],
    failures: [],
    cancelRequested: state === 'cancelled',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  };
}

/** 每次创建独立查询缓存，失败不自动重试，从而检查页面真实反馈。 */
function mount(
  preferences: TeacherPreferences = { gameDefaults: {} },
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void,
) {
  const onPreferences = vi.fn(async (_value: TeacherPreferences) => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <FeedbackProvider>
        <SettingsPage
          preferences={preferences}
          onPreferences={onPreferences}
          assets={Object.fromEntries(assets.map((asset) => [asset.assetId, asset]))}
          onAssets={vi.fn()}
          onRegisterLeaveGuard={onRegisterLeaveGuard}
        />
      </FeedbackProvider>
    </QueryClientProvider>,
  );
  return { onPreferences, client, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.listVoices.mockResolvedValue([]);
  native.synthesizeSpeech.mockResolvedValue(previewTask());
  native.readAsset.mockResolvedValue(assets[2]);
  native.cancelTask.mockResolvedValue(previewTask('cancelled'));
  native.clearTask.mockResolvedValue(undefined);
  audio.preview.mockResolvedValue(undefined);
  native.getDataLocation.mockResolvedValue('D:/managed/english-class-games');
  repository.listAssets.mockResolvedValue(assets);
  native.listExportCopies.mockResolvedValue({
    files: [copyA, copyB],
    count: 2,
    byteLength: 5_000_000,
  });
});
afterEach(cleanup);

describe('资源与设置的影响范围', () => {
  it('备份目标复制未完成时展示并打开实际本机副本，失败目标单独说明', async () => {
    const user = userEvent.setup();
    native.exportBackup.mockResolvedValue({
      completed: false,
      path: 'E:/未完成的备份.ecgbackup',
      localCopy: 'D:/managed/exports/保留的备份.ecgbackup',
      sha256: 'a'.repeat(64),
      byteLength: 100_000,
    });
    native.openExport.mockResolvedValue(undefined);
    mount();
    await user.click(screen.getByRole('tab', { name: '数据与备份' }));
    await user.click(screen.getByRole('button', { name: '导出完整备份' }));
    const result = (await screen.findByRole('heading', { name: '完整备份已保存在本机' }))
      .parentElement!;
    expect(within(result).getByText('D:/managed/exports/保留的备份.ecgbackup')).toBeVisible();
    expect(within(result).getByText('未完成的目标：E:/未完成的备份.ecgbackup')).toBeVisible();
    await user.click(within(result).getByRole('button', { name: '打开文件夹' }));
    await waitFor(() =>
      expect(native.openExport).toHaveBeenCalledWith(
        'D:/managed/exports/保留的备份.ecgbackup',
        true,
      ),
    );
    expect(native.openExport).not.toHaveBeenCalledWith('E:/未完成的备份.ecgbackup', true);
  });

  it('新课默认只在主动保存时一次提交，未完成目标时长不能发布', async () => {
    const original: TeacherPreferences = {
      gameDefaults: {
        'word-beat': { preset: 'regular', targetDurationMs: 300_000 },
        'uninstalled-game': { contrast: 'high' },
      },
    };
    const { onPreferences } = mount(original);
    expect(screen.getByLabelText('新课默认课堂推进方式')).toHaveValue('auto');
    expect(screen.getByLabelText('新课默认展示模式')).toHaveValue('blocks');
    const target = screen.getByLabelText('目标时长（分钟）');
    fireEvent.change(target, { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存新课默认' })).toBeDisabled();
    expect(onPreferences).not.toHaveBeenCalled();
    fireEvent.change(target, { target: { value: '7.5' } });
    fireEvent.change(screen.getByLabelText('新课默认练习预设'), { target: { value: 'focus' } });
    fireEvent.change(screen.getByLabelText('新课默认声音模式'), { target: { value: 'teacher' } });
    fireEvent.change(screen.getByLabelText('新课默认展示模式'), { target: { value: 'blocks' } });
    fireEvent.change(screen.getByLabelText('新课默认课堂推进方式'), {
      target: { value: 'auto' },
    });
    expect(onPreferences).not.toHaveBeenCalled();
    // 跨设置分区不卸载游戏表单，避免未提交的教师输入被重建成上次保存值。
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '音乐与口号' }));
    await user.click(screen.getByRole('tab', { name: '语音与制作默认' }));
    expect(screen.getByLabelText('目标时长（分钟）')).toHaveValue(7.5);
    const save = screen.getByRole('button', { name: '保存新课默认' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(onPreferences).toHaveBeenCalledOnce());
    expect(onPreferences).toHaveBeenCalledWith({
      gameDefaults: {
        'word-beat': expect.objectContaining({
          preset: 'focus',
          targetDurationMs: 450_000,
          soundMode: 'teacher',
          displayMode: 'blocks',
          progression: 'auto',
          englishRate: 1,
          chineseRate: 1,
        }),
        'uninstalled-game': { contrast: 'high' },
      },
    });
    expect(original.gameDefaults['word-beat']).toEqual({
      preset: 'regular',
      targetDurationMs: 300_000,
    });
  });

  it('按真实输入保护离开，改回原值即解锁；跨分区保留修改且不弹确认', async () => {
    const user = userEvent.setup();
    let guard!: () => Promise<boolean>;
    const register = vi.fn((next: (() => Promise<boolean>) | null) => {
      if (next) guard = next;
    });
    const { onPreferences, unmount } = mount(undefined, register);
    expect(await guard()).toBe(true);
    const target = screen.getByLabelText('目标时长（分钟）');
    fireEvent.change(target, { target: { value: '' } });
    let permission!: Promise<boolean>;
    act(() => {
      permission = guard();
    });
    expect(await screen.findByRole('dialog', { name: '未保存的修改' })).toHaveTextContent(
      '新课制作默认尚未应用',
    );
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(await permission).toBe(false);
    expect(target).toHaveValue(null);
    fireEvent.change(target, { target: { value: '5' } });
    expect(await guard()).toBe(true);
    // 无效语速保留在编辑输入中；不得把之前的合法语速冒充本次提交。
    const rate = screen.getByLabelText('英文语速（倍）');
    fireEvent.change(rate, { target: { value: '' } });
    expect(screen.getByRole('button', { name: '保存新课默认' })).toBeDisabled();
    const rateUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(rateUnload);
    expect(rateUnload.defaultPrevented).toBe(true);
    fireEvent.change(rate, { target: { value: '1' } });
    expect(await guard()).toBe(true);

    fireEvent.change(screen.getByLabelText('新课默认练习预设'), { target: { value: 'focus' } });
    await user.click(screen.getByRole('tab', { name: '音乐与口号' }));
    await user.click(screen.getByRole('tab', { name: '数据与备份' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => {
      permission = guard();
    });
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(await permission).toBe(false);
    await user.click(screen.getByRole('tab', { name: '语音与制作默认' }));
    expect(screen.getByLabelText('新课默认练习预设')).toHaveValue('focus');
    act(() => {
      permission = guard();
    });
    await user.click(await screen.findByRole('button', { name: '放弃修改' }));
    expect(await permission).toBe(true);
    expect(onPreferences).not.toHaveBeenCalled();
    unmount();
    expect(register).toHaveBeenLastCalledWith(null);
    const releasedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(releasedUnload);
    expect(releasedUnload.defaultPrevented).toBe(false);
  });

  it('保存失败保留输入与离开保护，重试成功后以新保存值解除保护', async () => {
    const user = userEvent.setup();
    let guard!: () => Promise<boolean>;
    const { onPreferences } = mount(undefined, (next) => {
      if (next) guard = next;
    });
    onPreferences.mockRejectedValueOnce(new Error('磁盘空间不足，默认值未保存。'));
    const target = screen.getByLabelText('目标时长（分钟）');
    fireEvent.change(target, { target: { value: '7.5' } });
    await user.click(screen.getByRole('button', { name: '保存新课默认' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘空间不足，默认值未保存。');
    expect(target).toHaveValue(7.5);
    let permission!: Promise<boolean>;
    act(() => {
      permission = guard();
    });
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(await permission).toBe(false);

    await user.click(screen.getByRole('button', { name: '保存新课默认' }));
    await waitFor(() => expect(onPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存新课默认' })).toBeEnabled());
    expect(await guard()).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const savedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
    // 父级尚未刷新的旧 props 不得把成功基线重置回最初的 5 分钟。
    fireEvent.change(target, { target: { value: '5' } });
    act(() => {
      permission = guard();
    });
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(await permission).toBe(false);
    fireEvent.change(target, { target: { value: '7.5' } });
    expect(await guard()).toBe(true);
  });

  it('保存中阻止宿主离开，完成后仍保护提交期间新增的编辑', async () => {
    const user = userEvent.setup();
    let guard!: () => Promise<boolean>;
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const { onPreferences } = mount(undefined, (next) => {
      if (next) guard = next;
    });
    onPreferences.mockImplementationOnce(() => pendingSave);
    const target = screen.getByLabelText('目标时长（分钟）');
    fireEvent.change(target, { target: { value: '7.5' } });
    await user.click(screen.getByRole('button', { name: '保存新课默认' }));
    expect(await guard()).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存新课默认' })).toBeDisabled();
    const savingUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savingUnload);
    expect(savingUnload.defaultPrevented).toBe(true);
    fireEvent.change(target, { target: { value: '9' } });
    await act(async () => {
      finishSave();
      await pendingSave;
    });
    expect(onPreferences).toHaveBeenCalledOnce();
    expect(onPreferences).toHaveBeenCalledWith({
      gameDefaults: { 'word-beat': expect.objectContaining({ targetDurationMs: 450_000 }) },
    });
    expect(target).toHaveValue(9);
    let permission!: Promise<boolean>;
    act(() => {
      permission = guard();
    });
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(await permission).toBe(false);
    fireEvent.change(target, { target: { value: '7.5' } });
    expect(await guard()).toBe(true);
  });

  it.each(['制作返回前', '素材读取期间'] as const)(
    '切走设置分区后%s到达的试听不能播放，返回后须主动重新试听',
    async (stage) => {
      const user = userEvent.setup();
      native.listVoices.mockResolvedValue([
        { id: 'english', name: '英文测试音色', language: 'en-US' },
      ]);
      let finishTask!: (task: TaskRecord) => void;
      let finishAsset!: (asset: AudioAsset) => void;
      const pendingTask = new Promise<TaskRecord>((resolve) => {
        finishTask = resolve;
      });
      const pendingAsset = new Promise<AudioAsset>((resolve) => {
        finishAsset = resolve;
      });
      if (stage === '制作返回前') native.synthesizeSpeech.mockReturnValueOnce(pendingTask);
      else native.readAsset.mockReturnValueOnce(pendingAsset);
      mount();
      const voice = screen.getByRole('combobox', { name: '英文示范音色' });
      await within(voice).findByRole('option', { name: '英文测试音色 · en-US' });
      await user.selectOptions(voice, 'english');
      await user.click(screen.getByRole('button', { name: '试听英文' }));
      await waitFor(() => expect(native.synthesizeSpeech).toHaveBeenCalledOnce());
      if (stage === '素材读取期间')
        await waitFor(() => expect(native.readAsset).toHaveBeenCalledOnce());
      await user.click(screen.getByRole('tab', { name: '音乐与口号' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await act(async () => {
        if (stage === '制作返回前') finishTask(previewTask('running'));
        else finishAsset(assets[2]);
      });
      await waitFor(() => expect(native.clearTask).toHaveBeenCalledWith('settings-preview-task'));
      expect(audio.preview).not.toHaveBeenCalled();
      expect(native.cancelTask).toHaveBeenCalledTimes(stage === '制作返回前' ? 1 : 0);
      await user.click(screen.getByRole('tab', { name: '语音与制作默认' }));
      expect(screen.getByRole('combobox', { name: '英文示范音色' })).toHaveValue('english');
      expect(audio.preview).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '试听英文' }));
      await waitFor(() => expect(audio.preview).toHaveBeenCalledOnce());
      const stops = audio.stop.mock.calls.length;
      await user.click(screen.getByRole('tab', { name: '数据与备份' }));
      expect(audio.stop.mock.calls.length).toBeGreaterThan(stops);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('按真实类型筛选音乐，先展示引用；移出资源库不代替缓存清理或删除课件声音', async () => {
    const user = userEvent.setup();
    native.resourceUsage
      .mockResolvedValueOnce({ inLibrary: true, lessons: [{ id: 'lesson', name: '高二复习课' }] })
      .mockResolvedValueOnce({ inLibrary: false, lessons: [{ id: 'lesson', name: '高二复习课' }] });
    native.deleteResource.mockResolvedValue(undefined);
    mount();
    await user.click(screen.getByRole('tab', { name: '音乐与口号' }));
    expect(await screen.findByText('课堂背景')).toBeVisible();
    expect(screen.queryByText('教师录音')).not.toBeInTheDocument();
    expect(screen.queryByText('英文配音')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看引用与管理' }));
    const dialog = within(await screen.findByRole('dialog', { name: '声音素材引用与管理' }));
    expect(dialog.getByText('高二复习课')).toBeVisible();
    expect(native.deleteResource).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: '移出资源库' }));
    await waitFor(() => expect(native.deleteResource).toHaveBeenCalledWith('music'));
    expect(await dialog.findByText('未在资源库收藏')).toBeVisible();
    expect(dialog.getByText('高二复习课')).toBeVisible();
    expect(native.cleanCache).not.toHaveBeenCalled();
  });

  it('清理导出副本必须选择并确认，只传递选中的本机路径', async () => {
    const user = userEvent.setup();
    native.clearExportCopies.mockImplementation(async () => {
      native.listExportCopies.mockResolvedValue({
        files: [copyB],
        count: 1,
        byteLength: 3_000_000,
      });
      return { count: 1, byteLength: 2_000_000 };
    });
    mount();
    await user.click(screen.getByRole('tab', { name: '数据与备份' }));
    expect(await screen.findByText('共 2 份 · 5.00 MB')).toBeVisible();
    const remove = screen.getByRole('button', { name: '清理所选副本' });
    expect(remove).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '早读课.html' }));
    expect(screen.getByText('已选 1 份 · 2.00 MB')).toBeVisible();
    await user.click(remove);
    expect(native.clearExportCopies).not.toHaveBeenCalled();
    const confirmation = within(screen.getByRole('dialog', { name: '清理所选本机导出副本' }));
    expect(confirmation.getByText(/课件素材和 U 盘等外部文件不受影响/u)).toBeVisible();
    await user.click(confirmation.getByRole('button', { name: '清理所选副本' }));
    await waitFor(() => expect(native.clearExportCopies).toHaveBeenCalledWith([copyA.path]));
    expect(await screen.findByText('共 1 份 · 3.00 MB')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '晚读课.ecglesson' })).not.toBeChecked();
  });

  it('恢复失败保留当前查询资料并展示可读错误，不按成功清空旧会话', async () => {
    const user = userEvent.setup();
    native.selectFile.mockResolvedValue({ token: 'backup-token', name: '备课备份.ecgbackup' });
    native.restoreBackup.mockRejectedValue({
      code: 'BAD_BACKUP',
      message: '备份验证未通过，原资料保留。',
    });
    const { client } = mount();
    client.setQueryData(['retained-input'], { text: '原资料' });
    await user.click(screen.getByRole('tab', { name: '数据与备份' }));
    await user.click(screen.getByRole('button', { name: '选择备份恢复' }));
    const confirmation = within(await screen.findByRole('dialog', { name: '恢复完整备份' }));
    await user.click(confirmation.getByRole('button', { name: '备份当前并恢复' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('备份验证未通过，原资料保留。');
    expect(client.getQueryData(['retained-input'])).toEqual({ text: '原资料' });
  });
});
