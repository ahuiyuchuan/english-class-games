// @vitest-environment jsdom
/** 导出界面的选版、独立包与迟到加载回归；文件写盘由原生专项验证。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWordBeatLesson } from '../games/word-beat/rules';
import { ExportTaskResult, LessonExportDialog } from './LessonExportDialog';
import type { LessonExportTask } from '../platform/exports';

const services = vi.hoisted(() => ({
  get: vi.fn(),
  start: vi.fn(),
  snapshot: [],
  open: vi.fn(),
  recopy: vi.fn(),
}));
vi.mock('../platform/native', () => ({ openExport: services.open }));
vi.mock('../platform/repository', () => ({ getLesson: services.get }));
vi.mock('../platform/exports', () => ({
  getExportTasks: () => services.snapshot,
  subscribeExportTasks: () => () => undefined,
  startLessonExport: services.start,
  recopyTaskArtifact: services.recopy,
}));
beforeEach(() => {
  vi.clearAllMocks();
  services.start.mockReturnValue('task');
  services.open.mockResolvedValue(undefined);
  services.recopy.mockResolvedValue(undefined);
});
afterEach(cleanup);
function lesson(name: string) {
  const result = createWordBeatLesson(
    [{ id: crypto.randomUUID(), english: 'knowledge', meaning: '知识', priority: false }],
    { name, soundMode: 'teacher' },
  );
  result.revision = 2;
  result.preparedRevision = 1;
  Object.values(result.gameData.slogans).forEach((slogan) => {
    slogan.enabled = false;
  });
  return result;
}

it('包模式只提供包说明与动作，错误草稿不触发课堂校验且不显示播放选项', async () => {
  const draft = lesson('未完成草稿');
  draft.draftInputs = { bpm: { raw: '-', message: '未完成' } };
  render(
    <LessonExportDialog
      open
      initialKind="package"
      assets={{}}
      getCurrent={async () => draft}
      onClose={() => undefined}
    />,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '仅保存可编辑包' })).toBeEnabled());
  expect(screen.queryByLabelText('导出后打开检查')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('同时保存可编辑课件包')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '仅保存可编辑包' }));
  fireEvent.click(screen.getByRole('button', { name: '仅保存可编辑包' }));
  expect(services.start).toHaveBeenCalledTimes(1);
  expect(services.start.mock.calls[0][0]).toMatchObject({
    draft,
    selected: draft,
    packageOnly: true,
    openAfterExport: false,
  });
  expect(services.get).not.toHaveBeenCalled();
});

it('明确选择旧准备版仅改变本次HTML输入，包仍绑定当前错误草稿', async () => {
  const draft = lesson('新草稿');
  const prepared = structuredClone(draft);
  prepared.name = '旧准备版';
  prepared.revision = 1;
  draft.draftInputs = { bpm: { raw: '-', message: '未完成' } };
  services.get.mockResolvedValueOnce(prepared);
  render(
    <LessonExportDialog
      open
      assets={{}}
      getCurrent={async () => draft}
      onClose={() => undefined}
    />,
  );
  fireEvent.click(await screen.findByRole('radio', { name: /上次已准备版/ }));
  fireEvent.click(screen.getByLabelText('同时保存可编辑课件包'));
  fireEvent.click(screen.getByRole('button', { name: '检查并导出' }));
  expect(services.start.mock.calls[0][0]).toMatchObject({
    draft,
    selected: prepared,
    alsoPackage: true,
  });
  expect(draft.name).toBe('新草稿');
});

it('关闭后快速重开，前次迟到读取不能覆盖新课件或改变加载状态', async () => {
  const old = lesson('迟到旧课');
  const current = lesson('重新打开的新课');
  let resolveOld!: (value: typeof old) => void;
  const first = new Promise<typeof old>((resolve) => {
    resolveOld = resolve;
  });
  const getCurrent = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(current);
  services.get.mockResolvedValue({ ...current, revision: 1 });
  const props = { assets: {}, getCurrent, onClose: () => undefined };
  const view = render(<LessonExportDialog {...props} open />);
  view.rerender(<LessonExportDialog {...props} open={false} />);
  view.rerender(<LessonExportDialog {...props} open />);
  await screen.findByText(/重新打开的新课 · 当前保存版本/);
  await act(async () => resolveOld(old));
  expect(screen.queryByText(/迟到旧课 · 当前保存版本/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '检查并导出' }));
  expect(services.start.mock.calls[0][0].draft.id).toBe(current.id);
});

it('重启成功记录明确打开本机副本并允许重复制，失效路径仍可重新选版', async () => {
  const task: LessonExportTask = {
    id: 'history',
    lessonId: 'lesson',
    name: '历史课件',
    draftRevision: 2,
    selectedRevision: 1,
    stage: '已结束',
    running: false,
    outcomes: [
      {
        kind: 'html',
        state: 'completed',
        restored: true,
        result: {
          completed: true,
          path: 'E:/旧U盘/课件.html',
          localCopy: 'C:/exports/固定课件.html',
          sha256: 'a'.repeat(64),
          byteLength: 100,
        },
      },
    ],
  };
  const restart = vi.fn();
  render(<ExportTaskResult task={task} onRestart={restart} />);
  fireEvent.click(screen.getByRole('button', { name: '打开本机副本检查' }));
  expect(services.open).toHaveBeenCalledWith('C:/exports/固定课件.html');
  expect(services.open).not.toHaveBeenCalledWith('E:/旧U盘/课件.html');
  fireEvent.click(screen.getByRole('button', { name: '重新复制' }));
  expect(services.recopy).toHaveBeenCalledWith('history', 'html');
  fireEvent.click(screen.getByRole('button', { name: '重新导出（重新选版）' }));
  expect(restart).toHaveBeenCalledOnce();
});
