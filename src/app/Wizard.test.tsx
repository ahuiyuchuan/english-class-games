// @vitest-environment jsdom
/** 制作会话的异步回归；验证教师新输入与真实任务结果隔离，不模拟Windows实机验收。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeedbackProvider } from '../shared/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetMap, AudioAsset, TeachingEntry } from '../platform/types';
import type { TaskRecord } from '../platform/native';
import type { TeacherPreferences } from '../platform/repository';
import type { WordBeatLesson } from '../games/word-beat/model';
import {
  bindAudio,
  createWordBeatLesson,
  getAudioRequests,
  getEntries,
} from '../games/word-beat/rules';
import { VoiceFields, Wizard } from './Wizard';

const services = vi.hoisted(() => ({
  save: vi.fn(),
  produce: vi.fn(),
  synthesize: vi.fn(),
  cancel: vi.fn(),
  getTask: vi.fn(),
  clear: vi.fn(),
  readAsset: vi.fn(),
  preview: vi.fn(),
  stop: vi.fn(),
  voices: vi.fn(),
}));
vi.mock('../platform/repository', () => ({
  desktopAvailable: true,
  saveLesson: services.save,
  markPrepared: vi.fn(),
  readAssetData: vi.fn(),
}));
vi.mock('../games/word-beat/production', async (original) => ({
  ...(await original<typeof import('../games/word-beat/production')>()),
  produceLesson: services.produce,
}));
vi.mock('../platform/audio-preview', () => ({
  previewAudio: services.preview,
  stopPreview: services.stop,
  validatePlayableAssets: vi.fn(),
}));
vi.mock('../platform/native', () => ({
  listVoices: services.voices,
  synthesizeSpeech: services.synthesize,
  getTask: services.getTask,
  cancelTask: services.cancel,
  clearTask: services.clear,
  readAsset: services.readAsset,
}));
vi.mock('./ImportPanel', () => ({
  ImportPanel: ({
    onConfirm,
  }: {
    onConfirm: (entries: TeachingEntry[], source: { name: string; original: string }) => void;
  }) => (
    <button
      onClick={() =>
        onConfirm([{ id: 'new', english: 'new material', meaning: '新材料', priority: false }], {
          name: '新词表',
          original: 'new material',
        })
      }
    >
      确认测试材料
    </button>
  ),
}));
vi.mock('../portable/export', () => ({
  createClassroomHtml: vi.fn(),
  suggestClassroomFileName: vi.fn(),
}));
vi.mock('../games/word-beat/Classroom', () => ({ WordBeatClassroom: () => null }));

const voices = [{ id: 'en', name: '英文测试音色', language: 'en-US' }];
const entry: TeachingEntry = {
  id: 'source',
  english: 'challenge',
  meaning: '挑战',
  priority: false,
};
const sound: AudioAsset = {
  assetId: 'test-sound',
  mimeType: 'audio/wav',
  byteLength: 4000,
  durationMs: 900,
  sha256: 'a'.repeat(64),
};

/** 受控延迟复现“任务/保存完成之前教师又编辑”的竞态，不依赖设备速度。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function task(state: TaskRecord['state'] = 'completed'): TaskRecord {
  return {
    taskId: 'preview-task',
    kind: 'speech',
    state,
    stage: '声音制作',
    completed: state === 'completed' ? 1 : 0,
    total: 1,
    results:
      state === 'completed'
        ? [{ requestId: 'request', objectId: 'voice-preview', asset: sound, cached: false }]
        : [],
    failures: [],
    cancelRequested: state === 'cancelled',
    createdAt: '',
    updatedAt: '',
  };
}

function wizard(
  onEdit = vi.fn(),
  entries = [entry],
  preferences: TeacherPreferences = {
    gameDefaults: {
      'word-beat': {
        englishVoiceId: 'en',
        chineseVoiceId: 'zh',
        targetDurationMs: 720_000,
      },
    },
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  /** 正式宿主会发布制作素材；测试也更新props，避免用空素材库判断就绪。 */
  function Host() {
    const [allAssets, setAllAssets] = useState<AssetMap>({});
    return (
      <Wizard
        dictionary={[]}
        commonWords={[]}
        preferences={preferences}
        assets={allAssets}
        initialEntries={entries}
        onAssets={setAllAssets}
        onBack={vi.fn()}
        onEdit={onEdit}
        onMaterial={vi.fn(async () => undefined)}
      />
    );
  }
  const view = render(
    <QueryClientProvider client={client}>
      <FeedbackProvider>
        <Host />
      </FeedbackProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.resetAllMocks();
  services.voices.mockResolvedValue([
    { id: 'en', name: '英文测试音色', language: 'en-US' },
    { id: 'zh', name: '中文测试音色', language: 'zh-CN' },
  ]);
  services.save.mockImplementation(async (lesson: WordBeatLesson) => ({
    ...structuredClone(lesson),
    revision: lesson.revision + 1,
  }));
  services.produce.mockImplementation(async (lesson: WordBeatLesson, assets: AssetMap) => ({
    lesson,
    assets,
  }));
  services.clear.mockResolvedValue(undefined);
  services.cancel.mockResolvedValue(task('cancelled'));
  services.synthesize.mockResolvedValue(task());
  services.readAsset.mockResolvedValue(sound);
  services.preview.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('三步制作会话', () => {
  it('自主齐读说明使用当前新建一轮规则，不把预设目标当已应用安排', async () => {
    wizard();
    fireEvent.change(screen.getByLabelText('练习模式'), { target: { value: 'chorus' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(screen.getByLabelText('练习模式')).toHaveValue('chorus'));
    expect(
      screen.getByText(/新建每词默认1轮；主动应用练习预设后才按预设调整轮数/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/轮数沿用预设/u)).not.toBeInTheDocument();
    expect(
      screen.getByText(/在编辑器或课堂设置中可按词或范围调整轮数、每轮总拍数和每次占拍/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/课堂设置仅本课本地保存，不改原课件/u)).toBeInTheDocument();
    expect(screen.getByText(/当前安排：每词 1 轮/u)).toBeInTheDocument();
  });

  it('课件名按Unicode码点计数，80个补充平面字符保留，81个明确报错且不制作', async () => {
    wizard();
    const name = screen.getByRole('textbox', { name: '课件名称' });
    const validName = '𠮷'.repeat(80);
    fireEvent.change(name, { target: { value: validName } });
    fireEvent.blur(name);
    expect(name).toHaveValue(validName);
    expect(name).not.toHaveAttribute('maxlength');
    expect(name).not.toBeInvalid();

    fireEvent.change(name, { target: { value: `${validName}𠮷` } });
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    expect(name).toHaveValue(`${validName}𠮷`);
    expect(name).toBeInvalid();
    expect(services.produce).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: validName } });
    expect(name).not.toBeInvalid();
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
    expect(services.produce.mock.calls[0][0].name).toBe(validName);
  });

  it('新课无需系统音色配置，缺省使用内置中英音色进入真实制作服务', async () => {
    wizard(vi.fn(), [entry], { gameDefaults: {} });
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
    expect(services.produce.mock.calls[0][0].gameData.voices).toMatchObject({
      englishVoiceId: 'builtin:melo-zh-en-v1:en',
      chineseVoiceId: 'builtin:melo-zh-en-v1:zh',
    });
  });

  it('已保存音色不在本机枚举中仍交由制作服务查缓存，不提前阻止匹配声音复用', async () => {
    services.voices.mockResolvedValue([]);
    const view = wizard();
    await waitFor(() => expect(view.client.getQueryState(['voices'])?.status).toBe('success'));
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
    expect(services.produce.mock.calls[0][0].gameData.voices).toMatchObject({
      englishVoiceId: 'en',
      chineseVoiceId: 'zh',
    });
    expect(screen.queryByText(/请先选择并试听当前可用的音色/)).not.toBeInTheDocument();
  });
  it('沿用教师保存的目标时长，非法输入在返回步骤后保留并阻止制作', async () => {
    wizard();
    const input = screen.getByRole('spinbutton', { name: '目标时长（分钟，仅作建议依据）' });
    expect(input).toHaveAccessibleDescription('按编排本身计算，不含教师等待、暂停和临时重读。');
    expect(input).toHaveValue(12);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '1 内容校对' }));
    fireEvent.click(screen.getByRole('button', { name: '2 活动编排' }));
    expect(screen.getByRole('spinbutton', { name: '目标时长（分钟，仅作建议依据）' })).toHaveValue(
      null,
    );
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    expect(services.produce).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('目标时长需为1～30分钟');
  });

  it('新课创建采用教师保存的课堂推进默认，并原样交给制作任务', async () => {
    wizard(vi.fn(), [entry], {
      gameDefaults: {
        'word-beat': {
          englishVoiceId: 'en',
          chineseVoiceId: 'zh',
          displayMode: 'blocks',
          progression: 'auto',
        },
      },
    });

    expect(screen.getByLabelText('展示模式')).toHaveValue('blocks');
    expect(screen.getByLabelText('课堂推进方式')).toHaveValue('auto');
    fireEvent.change(screen.getByLabelText('课堂推进方式'), { target: { value: 'step' } });

    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());

    expect(services.produce.mock.calls[0][0].gameData.displayMode).toBe('blocks');
    expect(services.produce.mock.calls[0][0].gameData.progression).toBe('step');
  });

  it('预设切换先看差异，取消不改值，确认才切换并恢复操作焦点', async () => {
    wizard();
    expect(screen.getByText(/当前安排：每词 1 轮/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /重点强化/ }));
    expect(screen.getByRole('dialog', { name: '确认切换练习预设' })).toHaveTextContent(
      '1 轮 → 3 轮',
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText(/当前安排：每词 1 轮/u)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /常规巩固/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /重点强化/ }));
    fireEvent.click(screen.getByRole('button', { name: '应用预设' }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /重点强化/ })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(screen.getByText(/当前安排：每词 3 轮/u)).toBeInTheDocument();
  });

  it('返回校对选择新材料时先确认替换，取消保留原词条', async () => {
    wizard();
    fireEvent.click(screen.getByRole('button', { name: '1 内容校对' }));
    fireEvent.click(screen.getByRole('button', { name: '确认测试材料' }));
    expect(screen.getByRole('dialog', { name: '替换本次制作材料' })).toHaveTextContent(
      '新词条不继承',
    );
    fireEvent.click(screen.getByRole('button', { name: '保留原材料' }));
    fireEvent.click(screen.getByRole('button', { name: '2 活动编排' }));
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
    expect(getEntries(services.produce.mock.calls[0][0])[0].english).toBe('challenge');
  });

  it('制作中改名不被旧结果覆盖，旧成果只能只读查看', async () => {
    const pending = deferred<{ lesson: WordBeatLesson; assets: AssetMap }>();
    services.produce.mockReturnValueOnce(pending.promise);
    const onEdit = vi.fn();
    wizard(onEdit);
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
    const snapshot = services.produce.mock.calls[0][0] as WordBeatLesson;
    fireEvent.click(screen.getByRole('button', { name: '2 活动编排' }));
    fireEvent.change(screen.getByRole('textbox', { name: '课件名称' }), {
      target: { value: '当前教师修改' },
    });
    await act(async () => pending.resolve({ lesson: snapshot, assets: {} }));
    expect(screen.getByRole('textbox', { name: '课件名称' })).toHaveValue('当前教师修改');
    fireEvent.click(screen.getByRole('button', { name: '3 声音制作与检查' }));
    fireEvent.click(screen.getByRole('button', { name: '查看旧成果（只读）' }));
    expect(screen.getByRole('dialog', { name: '旧制作成果（只读）' })).toHaveTextContent(
      snapshot.name,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
    fireEvent.click(screen.getByRole('button', { name: '进入当前草稿' }));
    expect(onEdit.mock.calls[0][0].name).toBe('当前教师修改');
    expect(services.save).toHaveBeenCalledOnce();
  });

  it('最终保存等待中继续编辑也保留新输入并提示版本不同', async () => {
    const pending = deferred<WordBeatLesson>();
    services.save
      .mockImplementationOnce(async (lesson: WordBeatLesson) => ({ ...lesson, revision: 1 }))
      .mockReturnValueOnce(pending.promise);
    wizard();
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.save).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '2 活动编排' }));
    fireEvent.change(screen.getByRole('textbox', { name: '课件名称' }), {
      target: { value: '保存期间的新名称' },
    });
    await act(async () => pending.resolve({ ...services.save.mock.calls[1][0], revision: 2 }));
    expect(screen.getByRole('textbox', { name: '课件名称' })).toHaveValue('保存期间的新名称');
    fireEvent.click(screen.getByRole('button', { name: '3 声音制作与检查' }));
    expect(screen.getByRole('button', { name: '查看旧成果（只读）' })).toBeInTheDocument();
  });

  it.each(['成功', '失败'] as const)(
    '旧任务取消%s答复晚于新制作启动时，不替换新任务进度和取消入口',
    async (outcome) => {
      const first = deferred<{ lesson: WordBeatLesson; assets: AssetMap }>();
      const second = deferred<{ lesson: WordBeatLesson; assets: AssetMap }>();
      const cancellation = deferred<TaskRecord>();
      services.cancel.mockReturnValueOnce(cancellation.promise);
      services.produce
        .mockImplementationOnce(
          (_lesson: WordBeatLesson, _assets: AssetMap, onTask: (value: TaskRecord) => void) => {
            onTask({ ...task('running'), taskId: 'task-a', stage: '正在制作 A' });
            return first.promise;
          },
        )
        .mockImplementationOnce(
          (_lesson: WordBeatLesson, _assets: AssetMap, onTask: (value: TaskRecord) => void) => {
            onTask({ ...task('running'), taskId: 'task-b', stage: '正在制作 B' });
            return second.promise;
          },
        );
      wizard();
      fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
      await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole('button', { name: '取消制作' }));
      expect(services.cancel).toHaveBeenCalledWith('task-a');
      // A 的正常轮询先收到终态，取消调用仍在等待；教师随后重新制作 B。
      await act(async () => {
        services.produce.mock.calls[0][2]({ ...task(), taskId: 'task-a' });
        first.resolve({ lesson: services.produce.mock.calls[0][0], assets: {} });
      });
      fireEvent.click(screen.getByRole('button', { name: '调整编排' }));
      fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
      await waitFor(() => expect(services.produce).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === '成功')
          cancellation.resolve({
            ...task('cancelled'),
            taskId: 'task-a',
            stage: '旧任务 A 已取消',
          });
        else cancellation.reject(new Error('旧任务取消失败'));
      });
      expect(screen.getByText('正在制作 B')).toBeVisible();
      expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
      expect(screen.getByRole('progressbar')).toHaveAttribute('max', '1');
      expect(screen.queryByText(/旧任务 A 已取消/u)).not.toBeInTheDocument();
      expect(screen.queryByText(/旧任务取消失败/u)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消制作' })).toBeEnabled();
      await act(async () => {
        services.produce.mock.calls[1][2]({ ...task(), taskId: 'task-b' });
        second.resolve({ lesson: services.produce.mock.calls[1][0], assets: {} });
      });
    },
  );

  it('成果按固定唯一声音需求显示三类数量，任务内缓存计为复用', async () => {
    services.produce.mockImplementationOnce(
      async (lesson: WordBeatLesson, assets: AssetMap, onTask: (value: TaskRecord) => void) => {
        const result = {
          ...task(),
          lessonId: lesson.id,
          inputRevision: lesson.revision,
          results: [
            { requestId: 'word', objectId: getEntries(lesson)[0].id, asset: sound, cached: true },
            {
              requestId: 'opening',
              objectId: lesson.gameData.slogans.opening.id,
              asset: sound,
              cached: false,
            },
          ],
        };
        onTask(result);
        return { lesson, assets, task: result };
      },
    );
    wizard(vi.fn(), [entry, { ...entry, id: 'duplicate' }]);
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(screen.getByText('新制作 1 项')).toBeInTheDocument());
    expect(screen.getByText('声音需求 3 项')).toBeInTheDocument();
    expect(screen.getByText('复用 1 项')).toBeInTheDocument();
    expect(screen.getByText('未完成 1 项')).toBeInTheDocument();
  });
});

/** 单测产物只验证绑定及状态，实际语音和桌面保存另有原生验收。 */
function withSounds(input: WordBeatLesson, assets: AssetMap) {
  let lesson = structuredClone(input);
  const nextAssets = { ...assets };
  for (const request of getAudioRequests(input, assets)) {
    const asset = { ...sound, assetId: `test-${request.objectId}` };
    nextAssets[asset.assetId] = asset;
    lesson = bindAudio(lesson, request.objectId, asset, request);
  }
  return { lesson, assets: nextAssets };
}

/** 与Rust的排序相似但保持数组顺序；真实Rust返回值另由专项收据核对。 */
function reorderSaved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderSaved);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, reorderSaved(item)]),
    );
  return value;
}

describe('制作一致性与范围反馈', () => {
  beforeEach(() => {
    services.save.mockImplementation(async (lesson: WordBeatLesson) =>
      reorderSaved({
        ...structuredClone(lesson),
        revision: lesson.revision + 1,
        updatedAt: '2026-10-22T01:00:00Z',
      }),
    );
    services.produce.mockImplementation(async (lesson: WordBeatLesson, assets: AssetMap) =>
      withSounds(lesson, assets),
    );
  });

  it('初存和终存递归重排后声音自动回填，首制与重制均可预演导出', async () => {
    wizard();
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(screen.getByText('当前课件已就绪')).toBeVisible());
    expect(screen.queryByText('当前草稿已有修改')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预演课件' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '导出课堂文件' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '调整编排' }));
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(services.save).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByText('当前课件已就绪')).toBeVisible());
    expect(
      getAudioRequests(services.produce.mock.calls[1][0], services.produce.mock.calls[1][1]),
    ).toEqual([]);
    expect(screen.queryByRole('button', { name: '查看旧成果（只读）' })).not.toBeInTheDocument();
  });

  it.each(['cancelled', 'partialFailure'] as const)(
    '%s保留可用产物但不宣称就绪，重试可复用并完成当前课件',
    async (state) => {
      services.produce.mockImplementationOnce(
        async (lesson: WordBeatLesson, assets: AssetMap, onTask: (value: TaskRecord) => void) => {
          const result = withSounds(lesson, assets);
          const record = { ...task(state), results: [], completed: 0 };
          onTask(record);
          return { ...result, task: record };
        },
      );
      wizard();
      fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
      await waitFor(() => expect(services.save).toHaveBeenCalledTimes(2));
      expect(screen.queryByText('当前课件已就绪')).not.toBeInTheDocument();
      expect(screen.queryByText('当前草稿已有修改')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '调整编排' }));
      fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
      await waitFor(() => expect(screen.getByText('当前课件已就绪')).toBeVisible());
      expect(
        getAudioRequests(services.produce.mock.calls[1][0], services.produce.mock.calls[1][1]),
      ).toEqual([]);
    },
  );

  it.each(['初次保存', '制作', '最终保存'] as const)(
    '%s等待中改名，保存返回不覆盖且只显示一个有依据的警告',
    async (phase) => {
      const pending = deferred<WordBeatLesson>();
      const production = deferred<ReturnType<typeof withSounds>>();
      if (phase === '初次保存') services.save.mockReturnValueOnce(pending.promise);
      if (phase === '最终保存')
        services.save
          .mockImplementationOnce(async (lesson: WordBeatLesson) => ({ ...lesson, revision: 1 }))
          .mockReturnValueOnce(pending.promise);
      if (phase === '制作') services.produce.mockReturnValueOnce(production.promise);
      wizard();
      fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
      await waitFor(() =>
        expect(phase === '制作' ? services.produce : services.save).toHaveBeenCalledTimes(
          phase === '最终保存' ? 2 : 1,
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: '2 活动编排' }));
      fireEvent.change(screen.getByRole('textbox', { name: '课件名称' }), {
        target: { value: '教师正在修改的课件' },
      });
      await act(async () => {
        if (phase === '制作') production.resolve(withSounds(services.produce.mock.calls[0][0], {}));
        else
          pending.resolve(
            reorderSaved({
              ...services.save.mock.calls[phase === '最终保存' ? 1 : 0][0],
              revision: phase === '最终保存' ? 2 : 1,
            }) as WordBeatLesson,
          );
      });
      fireEvent.click(screen.getByRole('button', { name: '3 声音制作与检查' }));
      await waitFor(() => expect(screen.getByText('当前草稿已有修改')).toBeVisible());
      expect(screen.getAllByText('当前草稿已有修改')).toHaveLength(1);
      expect(screen.getByText(/已变化：课件名称/u)).toBeVisible();
      expect(screen.queryByText('当前课件已就绪')).not.toBeInTheDocument();
      expect(screen.queryByText('当前课件检查通过')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '预演课件' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '导出课堂文件' })).toBeDisabled();
    },
  );

  it.each(['词语', '设置'] as const)(
    '制作中修改%s仍保留新草稿，重新制作才采用对应成果',
    async (kind) => {
      const pending = deferred<ReturnType<typeof withSounds>>();
      services.produce.mockReturnValueOnce(pending.promise);
      const onEdit = vi.fn();
      wizard(onEdit);
      fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
      await waitFor(() => expect(services.produce).toHaveBeenCalledOnce());
      if (kind === '词语') {
        fireEvent.click(screen.getByRole('button', { name: '1 内容校对' }));
        fireEvent.click(screen.getByRole('button', { name: '确认测试材料' }));
        fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: '2 活动编排' }));
        fireEvent.change(screen.getByLabelText('目标时长（分钟，仅作建议依据）'), {
          target: { value: '5' },
        });
      }
      await act(async () => pending.resolve(withSounds(services.produce.mock.calls[0][0], {})));
      fireEvent.click(screen.getByRole('button', { name: '3 声音制作与检查' }));
      await waitFor(() => expect(screen.getByText('当前草稿已有修改')).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: '进入当前草稿' }));
      if (kind === '词语')
        expect(getEntries(onEdit.mock.calls[0][0])[0].english).toBe('new material');
      else expect(onEdit.mock.calls[0][0].gameData.targetDurationMs).toBe(300_000);
      fireEvent.click(screen.getByRole('button', { name: '基于当前内容重新制作' }));
      await waitFor(() => expect(screen.getByText('当前课件已就绪')).toBeVisible());
      expect(screen.queryByText('当前草稿已有修改')).not.toBeInTheDocument();
    },
  );

  it('制作完成返回编排修改后及时标为过期，恢复原名后自动恢复就绪', async () => {
    wizard();
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(screen.getByText('当前课件已就绪')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '调整编排' }));
    const name = screen.getByRole('textbox', { name: '课件名称' });
    const original = (name as HTMLInputElement).value;
    fireEvent.change(name, { target: { value: '另一个名称' } });
    fireEvent.click(screen.getByRole('button', { name: '3 声音制作与检查' }));
    expect(screen.getByText('当前草稿已有修改')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '调整编排' }));
    fireEvent.change(screen.getByRole('textbox', { name: '课件名称' }), {
      target: { value: original },
    });
    fireEvent.click(screen.getByRole('button', { name: '3 声音制作与检查' }));
    expect(screen.getByText('当前课件已就绪')).toBeVisible();
    expect(screen.queryByText('当前草稿已有修改')).not.toBeInTheDocument();
  });

  it('最终保存失败不显示就绪，原草稿保留且允许重试', async () => {
    services.save
      .mockImplementationOnce(async (lesson: WordBeatLesson) => ({ ...lesson, revision: 1 }))
      .mockRejectedValueOnce(new Error('保存失败测试'));
    wizard();
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(screen.getByText('保存失败测试')).toBeVisible());
    expect(screen.queryByText('当前课件已就绪')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '调整编排' }));
    fireEvent.click(screen.getByRole('button', { name: '一键制作' }));
    await waitFor(() => expect(screen.getByText('当前课件已就绪')).toBeVisible());
  });
});

describe('试听与未完成语速输入', () => {
  it('语速清空保留原有效值和错误输入，修正后删除错误，不把空值变成0', () => {
    let changed!: WordBeatLesson;
    function Example() {
      const [lesson, setLesson] = useState(() => createWordBeatLesson([entry], { seed: 1 }));
      return (
        <VoiceFields
          lesson={lesson}
          voices={voices}
          onChange={(next) => {
            changed = next;
            setLesson(next);
          }}
        />
      );
    }
    render(<Example />);
    fireEvent.change(screen.getByRole('spinbutton', { name: '英文语速（倍）' }), {
      target: { value: '' },
    });
    expect(changed.gameData.voices.englishRate).toBe(1);
    expect(changed.draftInputs?.[`${changed.id}.englishRate`]?.raw).toBe('');
    expect(screen.getByRole('spinbutton', { name: '英文语速（倍）' })).toBeInvalid();
    fireEvent.change(screen.getByRole('spinbutton', { name: '英文语速（倍）' }), {
      target: { value: '1.2' },
    });
    expect(changed.gameData.voices.englishRate).toBe(1.2);
    expect(changed.draftInputs?.[`${changed.id}.englishRate`]).toBeUndefined();
  });

  it('隐藏后迟到的试听任务只取消一次并清理，不能播放', async () => {
    const pending = deferred<TaskRecord>();
    services.synthesize.mockReturnValueOnce(pending.promise);
    const lesson = createWordBeatLesson([entry], { seed: 1 });
    lesson.gameData.voices.englishVoiceId = 'en';
    const view = render(<VoiceFields lesson={lesson} voices={voices} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '试听英文' }));
    view.rerender(
      <VoiceFields lesson={lesson} voices={voices} onChange={vi.fn()} active={false} />,
    );
    await act(async () => pending.resolve(task('running')));
    await waitFor(() => expect(services.clear).toHaveBeenCalledWith('preview-task'));
    expect(services.cancel).toHaveBeenCalledOnce();
    expect(services.preview).not.toHaveBeenCalled();
  });

  it('隐藏停止本页试听，之后隐藏参数变化不会停止其他页面的音频', async () => {
    const lesson = createWordBeatLesson([entry], { seed: 1 });
    lesson.gameData.voices.englishVoiceId = 'en';
    const view = render(<VoiceFields lesson={lesson} voices={voices} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '试听英文' }));
    await waitFor(() => expect(services.preview).toHaveBeenCalledOnce());
    view.rerender(
      <VoiceFields lesson={lesson} voices={voices} onChange={vi.fn()} active={false} />,
    );
    const stopped = services.stop.mock.calls.length;
    const next = structuredClone(lesson);
    next.gameData.voices.englishRate = 1.2;
    view.rerender(<VoiceFields lesson={next} voices={voices} onChange={vi.fn()} active={false} />);
    expect(services.stop).toHaveBeenCalledTimes(stopped);
  });
});
