// @vitest-environment jsdom
/**
 * 实际平台外壳的原生关闭回归：导入尚未提交完成时保留窗口，完成后才允许销毁。
 * 只替代窗口、文件和存储边界；包结构、游戏身份计划、对话框与编辑器均使用实际实现。
 * 不将此测试等同于真实 Windows 文件选择、数据库写盘或原生 X 实机验收。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LessonDocument } from '../platform/types';
import { createWordBeatLesson } from '../games/word-beat/rules';
import { createPackageData } from '../shared/schemas/lesson-package';
import { FeedbackProvider } from '../shared/ui';
import { App } from './App';
import { startLessonExport, getExportTasks, retryExportHistory } from '../platform/exports';

const windowApi = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
  unlisten: vi.fn(),
}));
const native = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listVoices: vi.fn(),
  selectFile: vi.fn(),
  inspectLessonPackage: vi.fn(),
  importLessonPackage: vi.fn(),
  retainAssets: vi.fn(),
  releaseAssets: vi.fn(),
  exportLessonPackage: vi.fn(),
}));
const repository = vi.hoisted(() => ({
  listLessons: vi.fn(),
  listAssets: vi.fn(),
  readAppData: vi.fn(),
  readTeacherPreferences: vi.fn(),
  getLesson: vi.fn(),
  saveLesson: vi.fn(),
  writeAppData: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApi,
}));
vi.mock('../platform/native', () => native);
vi.mock('../platform/repository', async (original) => ({
  ...(await original<typeof import('../platform/repository')>()),
  desktopAvailable: true,
  ...repository,
}));
vi.mock('../platform/materials', async (original) => ({
  ...(await original<typeof import('../platform/materials')>()),
  getBuiltinDictionary: async () => [],
}));

/** 受控的原生事件保留 preventDefault 契约，不直接调用 App 内部状态。 */
let closeRequested: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;

/** 合法但未发布的文字领读草稿，导入和编辑仍经过生产结构检查。 */
function lessonFixture() {
  const lesson = createWordBeatLesson(
    [{ id: 'source-entry', english: 'knowledge', meaning: '知识', priority: false }],
    { name: '高中导入课件', soundMode: 'teacher', seed: 1 },
  );
  lesson.revision = 1;
  for (const slogan of Object.values(lesson.gameData.slogans)) slogan.enabled = false;
  return lesson;
}

beforeEach(() => {
  vi.clearAllMocks();
  closeRequested = undefined;
  windowApi.onCloseRequested.mockImplementation(async (handler: typeof closeRequested) => {
    closeRequested = handler;
    return windowApi.unlisten;
  });
  windowApi.destroy.mockResolvedValue(undefined);
  native.listTasks.mockResolvedValue([]);
  native.listVoices.mockResolvedValue([]);
  native.retainAssets.mockResolvedValue(undefined);
  native.releaseAssets.mockResolvedValue(undefined);
  native.selectFile.mockResolvedValue({ token: 'package-token', name: '高中词汇.ecglesson' });
  repository.listLessons.mockResolvedValue([]);
  repository.listAssets.mockResolvedValue([]);
  repository.readAppData.mockImplementation(async (_key: string, fallback: unknown) => fallback);
  repository.writeAppData.mockResolvedValue(undefined);
  repository.readTeacherPreferences.mockResolvedValue({ gameDefaults: {} });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('原生关窗与课件包提交', () => {
  it('公共导出队列写盘期间保留窗口，返回结果页面不改变关闭保护', async () => {
    const lesson = lessonFixture();
    let finish!: (value: {
      completed: boolean;
      path: string;
      localCopy: string;
      sha256: string;
      byteLength: number;
    }) => void;
    native.exportLessonPackage.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const view = render(
      <QueryClientProvider client={client}>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(closeRequested).toBeTypeOf('function'));
    let taskId = '';
    await act(async () => {
      taskId = startLessonExport({
        draft: lesson,
        selected: lesson,
        assets: {},
        alsoPackage: true,
        packageOnly: true,
        openAfterExport: false,
      });
    });
    await waitFor(() => expect(native.exportLessonPackage).toHaveBeenCalled());
    await act(async () => closeRequested!({ preventDefault: vi.fn() }));
    expect(windowApi.destroy).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        completed: true,
        path: 'E:/备课.ecglesson',
        localCopy: 'C:/exports/备课.ecglesson',
        sha256: 'a'.repeat(64),
        byteLength: 10,
      }),
    );
    await waitFor(() =>
      expect(getExportTasks().find((task) => task.id === taskId)?.running).toBe(false),
    );
    await act(async () => closeRequested!({ preventDefault: vi.fn() }));
    expect(windowApi.destroy).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });
  it('等待导出记录慢写期间新开始的导出也不能被原生关窗中断', async () => {
    let finishHistory!: () => void;
    repository.writeAppData.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHistory = resolve;
      }),
    );
    const history = retryExportHistory();
    const lesson = lessonFixture();
    let finishExport!: (value: {
      completed: boolean;
      path: string;
      localCopy: string;
      sha256: string;
      byteLength: number;
    }) => void;
    native.exportLessonPackage.mockReturnValueOnce(
      new Promise((resolve) => {
        finishExport = resolve;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const view = render(
      <QueryClientProvider client={client}>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(closeRequested).toBeTypeOf('function'));
    await waitFor(() => expect(repository.writeAppData).toHaveBeenCalled());
    let closing!: Promise<void>;
    await act(async () => {
      closing = closeRequested!({ preventDefault: vi.fn() });
    });
    let taskId = '';
    await act(async () => {
      taskId = startLessonExport({
        draft: lesson,
        selected: lesson,
        assets: {},
        alsoPackage: true,
        packageOnly: true,
        openAfterExport: false,
      });
    });
    await waitFor(() => expect(native.exportLessonPackage).toHaveBeenCalled());
    await act(async () => {
      finishHistory();
      await history;
      await closing;
    });
    expect(windowApi.destroy).not.toHaveBeenCalled();
    await act(async () =>
      finishExport({
        completed: true,
        path: 'E:/备课.ecglesson',
        localCopy: 'C:/exports/备课.ecglesson',
        sha256: 'a'.repeat(64),
        byteLength: 10,
      }),
    );
    await waitFor(() =>
      expect(getExportTasks().find((task) => task.id === taskId)?.running).toBe(false),
    );
    await act(async () => closeRequested!({ preventDefault: vi.fn() }));
    expect(windowApi.destroy).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });
  it.each(['导入已在写入', '关窗等待期间开始导入'] as const)(
    '%s时阻止销毁，导入完成后可关闭',
    async (order) => {
      const lesson = lessonFixture();
      const manifest = {
        formatVersion: 1,
        gameId: lesson.gameId,
        minimumPlatformVersion: '1.0.0',
        runtimeVersion: 1,
        sourceLessonId: lesson.id,
        generatedAt: '2026-10-20T00:00:00Z',
        lessonSha256: 'a'.repeat(64),
        assets: [],
      };
      native.inspectLessonPackage.mockResolvedValue({
        manifest,
        lesson: createPackageData(lesson),
        assets: [],
      });
      let finishImport!: (document: LessonDocument) => void;
      const importing = new Promise<LessonDocument>((resolve) => {
        finishImport = resolve;
      });
      native.importLessonPackage.mockReturnValueOnce(importing);
      repository.getLesson.mockResolvedValue(lesson);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const view = render(
        <QueryClientProvider client={client}>
          <FeedbackProvider>
            <App />
          </FeedbackProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(closeRequested).toBeTypeOf('function'));
      fireEvent.click(
        within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', {
          name: '我的课件',
        }),
      );
      fireEvent.click(await screen.findByRole('button', { name: '导入课件包' }));
      const preview = within(await screen.findByRole('dialog', { name: '检查可编辑课件包' }));
      expect(preview.getByRole('heading', { name: lesson.name })).toBeVisible();
      const importCopy = preview.getByRole('button', { name: '导入独立副本' });
      const preventDefault = vi.fn();
      await act(async () => {
        if (order === '导入已在写入') {
          fireEvent.click(importCopy);
          await closeRequested!({ preventDefault });
        } else {
          // 守卫返回 Promise 时关闭处理会让出执行权；同帧开始的导入必须在销毁前复查。
          const closing = closeRequested!({ preventDefault });
          fireEvent.click(importCopy);
          await closing;
        }
      });
      expect(native.importLessonPackage).toHaveBeenCalledOnce();
      expect(native.importLessonPackage).toHaveBeenCalledWith('package-token', true, {
        lessonSha256: manifest.lessonSha256,
        revisions: [{ revision: 1, layout: expect.any(Object) }],
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(windowApi.destroy).not.toHaveBeenCalled();
      expect(importCopy).toBeDisabled();
      const repeatedPreventDefault = vi.fn();
      await act(async () => closeRequested!({ preventDefault: repeatedPreventDefault }));
      expect(repeatedPreventDefault).toHaveBeenCalledOnce();
      expect(windowApi.destroy).not.toHaveBeenCalled();

      await act(async () => {
        finishImport(lesson);
        await importing;
      });
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: '检查可编辑课件包' })).not.toBeInTheDocument(),
      );
      expect(await screen.findByRole('textbox', { name: '课件名称' })).toHaveValue(lesson.name);
      const finishedPreventDefault = vi.fn();
      await act(async () => closeRequested!({ preventDefault: finishedPreventDefault }));
      expect(finishedPreventDefault).toHaveBeenCalledOnce();
      expect(windowApi.destroy).toHaveBeenCalledOnce();
      expect(repository.saveLesson).not.toHaveBeenCalled();
      view.unmount();
      expect(windowApi.unlisten).toHaveBeenCalledOnce();
      client.clear();
    },
  );
});
