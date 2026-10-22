/** 导出任务的固定版本、独立结果与重新复制回归；不冒充原生文件对话框实测。 @author ahui */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWordBeatLesson } from '../games/word-beat/rules';
const mocks = vi.hoisted(() => ({
  package: vi.fn(),
  html: vi.fn(),
  copy: vi.fn(),
  mark: vi.fn(),
  validate: vi.fn(),
  create: vi.fn(),
  retain: vi.fn(),
  release: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock('./repository', () => ({
  desktopAvailable: true,
  markPrepared: mocks.mark,
  readAssetData: vi.fn(),
  readAppData: mocks.read,
  writeAppData: mocks.write,
}));
vi.mock('./audio-preview', () => ({ validatePlayableAssets: mocks.validate }));
vi.mock('../portable/export', () => ({
  createClassroomHtml: mocks.create,
  suggestClassroomFileName: (name: string) => `${name}.html`,
}));
vi.mock('./native', () => ({
  exportHtml: mocks.html,
  exportLessonPackage: mocks.package,
  recopyExport: mocks.copy,
  retainAssets: mocks.retain,
  releaseAssets: mocks.release,
  openExport: vi.fn(),
}));
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(undefined);
  mocks.retain.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.mark.mockResolvedValue(undefined);
  mocks.validate.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue('<!doctype html>');
  mocks.package.mockResolvedValue({
    completed: true,
    localCopy: 'local-package',
    path: 'target-package',
    sha256: 'package-hash',
    byteLength: 3,
  });
  // 首次载入真实模块及课堂依赖属于夹具准备，不是导出队列的业务操作。
  // 必须等装载完成后才进入用例，避免 5 秒业务超时后异步体继续污染下一例。
  // 每次仍先重置模块与原生边界，不能沿用上一例的队列或历史记录。
  await import('./exports');
});
afterEach(async () => {
  const exports = await import('./exports');
  await exports.flushExportHistory();
});
const lesson = () => {
  const result = createWordBeatLesson(
    [{ id: crypto.randomUUID(), english: 'knowledge', meaning: '知识', priority: false }],
    { soundMode: 'teacher' },
  );
  result.revision = 1;
  result.preparedRevision = 1;
  result.gameData.slogans.opening.enabled = false;
  result.gameData.slogans.closing.enabled = false;
  return result;
};
it('旧准备版可运行时，错误草稿独立进入可编辑包；复制使用原成品且不重新读取课件', async () => {
  const exports = await import('./exports');
  const selected = lesson();
  const draft = structuredClone(selected);
  draft.revision = 2;
  draft.draftInputs = { bpm: { raw: '-', message: '未完成' } };
  mocks.html.mockResolvedValue({
    completed: false,
    localCopy: 'local-html',
    path: '',
    sha256: 'html-hash',
    byteLength: 10,
    error: { message: '目标不可写' },
  });
  const id = exports.startLessonExport({
    draft,
    selected,
    assets: {},
    alsoPackage: true,
    openAfterExport: false,
  });
  draft.revision = 99;
  selected.name = '后来编辑';
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === id)?.running).toBe(false),
  );
  expect(mocks.package).toHaveBeenCalledWith(draft.id, 2, 1, [
    expect.any(String),
    expect.any(String),
  ]);
  expect(mocks.mark).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), [], true);
  const task = exports.getExportTasks().find((item) => item.id === id)!;
  expect(task.outcomes.map((item) => item.state)).toEqual(['failed', 'completed']);
  mocks.copy.mockResolvedValue({ ...task.outcomes[0].result, completed: true, path: 'new-target' });
  await exports.recopyTaskArtifact(id, 'html');
  expect(mocks.copy).toHaveBeenCalledWith(
    'local-html',
    'html-hash',
    expect.not.stringContaining('后来编辑'),
  );
  expect(mocks.html).toHaveBeenCalledTimes(1);
  expect(mocks.package).toHaveBeenCalledTimes(1);
});
it('HTML尚未生成时也独立尝试导包，不能把失败项标成可重新复制', async () => {
  const exports = await import('./exports');
  const selected = lesson();
  mocks.create.mockRejectedValueOnce(new Error('生成失败'));
  const id = exports.startLessonExport({
    draft: selected,
    selected,
    assets: {},
    alsoPackage: true,
    openAfterExport: false,
  });
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === id)?.running).toBe(false),
  );
  const outcomes = exports.getExportTasks().find((task) => task.id === id)!.outcomes;
  expect(outcomes[0]).toMatchObject({ state: 'failed', error: '生成失败' });
  expect(outcomes[0].result).toBeUndefined();
  expect(outcomes[1].state).toBe('completed');
  await exports.recopyTaskArtifact(id, 'html');
  expect(mocks.copy).not.toHaveBeenCalled();
});

it('固定后重新保存或准备只影响指针，原来合法快照仍独立导出', async () => {
  const exports = await import('./exports');
  const selected = lesson();
  mocks.mark.mockRejectedValueOnce({ code: 'REVISION_CONFLICT', message: '检查期间已保存新版本' });
  mocks.html.mockResolvedValueOnce({
    completed: true,
    localCopy: 'local',
    path: 'target',
    sha256: 'hash',
    byteLength: 10,
  });
  const callback = vi.fn();
  const id = exports.startLessonExport({
    draft: selected,
    selected,
    assets: {},
    alsoPackage: true,
    openAfterExport: false,
    onPrepared: callback,
  });
  selected.revision = 22;
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === id)?.running).toBe(false),
  );
  expect(
    exports
      .getExportTasks()
      .find((task) => task.id === id)
      ?.outcomes.map((item) => item.state),
  ).toEqual(['completed', 'completed']);
  expect(mocks.html).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    selected.id,
    1,
    [],
    expect.any(String),
  );
  expect(mocks.package).toHaveBeenCalledWith(selected.id, 1, 1, [expect.any(String)]);
  expect(callback).not.toHaveBeenCalled();
});

it('排队时立即固定输入、重点击复用任务，前组结束后才处理下一组', async () => {
  const exports = await import('./exports');
  const first = lesson();
  const second = lesson();
  let release!: (value: string) => void;
  mocks.create.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  mocks.html.mockResolvedValue({
    completed: true,
    localCopy: 'local',
    path: 'target',
    sha256: 'hash',
    byteLength: 10,
  });
  const options = {
    draft: first,
    selected: first,
    assets: {},
    alsoPackage: false,
    openAfterExport: false,
  };
  const a = exports.startLessonExport(options);
  expect(exports.startLessonExport(options)).toBe(a);
  const b = exports.startLessonExport({ ...options, draft: second, selected: second });
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.retain).toHaveBeenCalledTimes(2);
  expect(exports.getExportTasks().find((task) => task.id === b)?.stage).toBe('等待导出');
  release('<!doctype html>');
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === b)?.running).toBe(false),
  );
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.release).toHaveBeenCalledTimes(2);
});

it('草稿快照保留失败不掩盖所选旧版HTML成功，包结果独立失败', async () => {
  const exports = await import('./exports');
  const selected = lesson();
  const draft = structuredClone(selected);
  draft.revision = 2;
  mocks.retain.mockImplementation(
    async (_owner: string, _assets: string[], _lesson: string, revision: number) => {
      if (revision === 2) throw new Error('草稿快照已不存在');
    },
  );
  mocks.html.mockResolvedValue({
    completed: true,
    localCopy: 'local',
    path: 'target',
    sha256: 'hash',
    byteLength: 10,
  });
  const id = exports.startLessonExport({
    draft,
    selected,
    assets: {},
    alsoPackage: true,
    openAfterExport: false,
  });
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === id)?.running).toBe(false),
  );
  expect(
    exports
      .getExportTasks()
      .find((task) => task.id === id)
      ?.outcomes.map((item) => item.state),
  ).toEqual(['completed', 'failed']);
  expect(mocks.package).not.toHaveBeenCalled();
});

it('独立包允许未完成输入，不调用HTML检查、配音解码或准备', async () => {
  const exports = await import('./exports');
  const draft = lesson();
  draft.draftInputs = { bpm: { raw: '-', message: '未完成' } };
  const id = exports.startLessonExport({
    draft,
    selected: draft,
    assets: {},
    alsoPackage: true,
    packageOnly: true,
    openAfterExport: false,
  });
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === id)?.running).toBe(false),
  );
  expect(mocks.mark).not.toHaveBeenCalled();
  expect(mocks.validate).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(exports.getExportTasks().find((task) => task.id === id)?.outcomes).toEqual([
    expect.objectContaining({ kind: 'package', state: 'completed' }),
  ]);
});

it('记录幂等读取并持久化最终结果，未来版本原记录不被新任务覆盖', async () => {
  const exports = await import('./exports');
  const draft = lesson();
  await Promise.all([exports.loadExportHistory(), exports.loadExportHistory()]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  const id = exports.startLessonExport({
    draft,
    selected: draft,
    assets: {},
    alsoPackage: true,
    packageOnly: true,
    openAfterExport: false,
  });
  await vi.waitFor(() =>
    expect(exports.getExportTasks().find((task) => task.id === id)?.running).toBe(false),
  );
  await exports.flushExportHistory();
  expect(mocks.write.mock.calls.at(-1)).toEqual([
    'exportHistory',
    {
      version: 1,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id,
          running: false,
          outcomes: [expect.objectContaining({ state: 'completed' })],
        }),
      ]),
    },
  ]);
  mocks.read.mockResolvedValueOnce({ version: 99, tasks: [] });
  await exports.retryExportHistory();
  const writes = mocks.write.mock.calls.length;
  await exports.recopyTaskArtifact(id, 'package');
  await exports.flushExportHistory();
  expect(mocks.write).toHaveBeenCalledTimes(writes);
  expect(exports.getExportHistoryError()).toContain('原记录已保留');
});
