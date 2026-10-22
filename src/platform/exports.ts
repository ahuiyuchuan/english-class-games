/**
 * 跨页面导出队列。每组固定输入、独立保留快照和素材，HTML与可编辑包分别报告结果；
 * 关闭页面只退出视图，不能中断写盘或把后来的编辑混进当前成果。
 * @author ahui
 */
import { getGame } from './games';
import * as native from './native';
import {
  desktopAvailable,
  markPrepared,
  readAssetData,
  readAppData,
  writeAppData,
} from './repository';
import { parseExportHistory } from './export-history';
import { validatePlayableAssets } from './audio-preview';
import { createClassroomHtml, suggestClassroomFileName } from '../portable/export';
import type { AssetMap, LessonDocument } from './types';

/** 一个实际文件的独立结果；本机成品存在与目标复制完成是两件事。 */
export interface FileExportOutcome {
  kind: 'html' | 'package';
  state: 'pending' | 'running' | 'completed' | 'failed';
  result?: native.ExportResult;
  error?: string;
  /** 浏览器下载不冒充Windows目标文件校验成功。 */
  downloaded?: boolean;
  /** 重启恢复的完成记录未重新核验外部目标，只允许先打开受管理本机副本。 */
  restored?: boolean;
}
/** 一组固定草稿/运行版本的导出记录；任务结束后只保存结果，不继续持有输入。 */
export interface LessonExportTask {
  id: string;
  lessonId: string;
  name: string;
  draftRevision: number;
  selectedRevision: number;
  stage: string;
  running: boolean;
  outcomes: FileExportOutcome[];
}
/** 由调用方完成编辑保存后提供，selected只能是同一课件的明确修订。 */
interface ExportOptions {
  draft: LessonDocument;
  selected: LessonDocument;
  assets: AssetMap;
  alsoPackage: boolean;
  openAfterExport: boolean;
  packageOnly?: boolean;
  onPrepared?: (revision: number) => void;
}
let tasks: LessonExportTask[] = [];
let queue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
let historyLoading: Promise<void> | undefined;
let historyWrites: Promise<void> = Promise.resolve();
let historyError = '';
let historyWritable = true;

/** 持久化失败不改变已完成文件结果；调用方持续显示记录错误。 */
export const getExportHistoryError = () => historyError;
function notifyHistoryError(error: unknown) {
  historyError = message(error);
  tasks = [...tasks];
  listeners.forEach((listener) => listener());
}
/** 幂等载入，合并当前会话任务；绝不让重启记录替代已开始的新任务。 */
export function loadExportHistory(): Promise<void> {
  historyLoading ??= (async () => {
    try {
      const stored = parseExportHistory(await readAppData('exportHistory', null));
      const currentIds = new Set(tasks.map((task) => task.id));
      tasks = [...stored.filter((task) => !currentIds.has(task.id)), ...tasks];
      historyWritable = true;
      historyError = '';
      listeners.forEach((listener) => listener());
    } catch (error) {
      historyWritable = false;
      notifyHistoryError(error);
    }
  })();
  return historyLoading;
}
/** 保存串行化；在正常关闭前等待，避免慢写的旧状态覆盖更近的结果。 */
function persistHistory() {
  historyWrites = historyWrites
    .then(async () => {
      await loadExportHistory();
      if (historyWritable) {
        await writeAppData('exportHistory', { version: 1, tasks: structuredClone(tasks) });
        if (historyError) {
          historyError = '';
          tasks = [...tasks];
          listeners.forEach((listener) => listener());
        }
      }
    })
    .catch(notifyHistoryError);
}
/** 正常退出先等待已排队的记录写入；不触发新导出或重建旧输入。 */
export async function flushExportHistory(): Promise<void> {
  // New writes can be queued while a slow preceding write is pending. Drain a
  // stable tail rather than returning a promise that was current one frame ago.
  for (;;) {
    const current = historyWrites;
    await current;
    if (current === historyWrites) return;
  }
}
/** 显式重试记录读写；不重新运行导出，不覆盖不支持的历史格式。 */
export async function retryExportHistory(): Promise<void> {
  historyLoading = undefined;
  await loadExportHistory();
  persistHistory();
  await flushExportHistory();
}

/** 返回稳定引用的任务视图；仅任务变化时替换，供React外部store订阅。 */
export const getExportTasks = () => tasks;
/** 退出组件只撤销订阅，不撤销后台任务。 */
export const subscribeExportTasks = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const message = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
function update(id: string, change: Partial<LessonExportTask>) {
  tasks = tasks.map((task) => (task.id === id ? { ...task, ...change } : task));
  listeners.forEach((listener) => listener());
  persistHistory();
}
function outcome(id: string, change: FileExportOutcome) {
  const task = tasks.find((item) => item.id === id)!;
  update(id, {
    outcomes: task.outcomes.map((item) => (item.kind === change.kind ? change : item)),
  });
}

/**
 * 固定已保存版本并立即入队；相同在途输入复用任务，防止连点重复导出。
 * 排队时即保留原生独立快照，源课删除、修订回收和清缓存都不改变输入。
 * HTML失败仍独立检查可编辑包；无成品的失败须重新选版发起新任务。
 * @param options 固定草稿、所选运行版和素材；packageOnly跳过课堂检查。onPrepared只通知成功推进的准备指针。
 * @returns 可在公共任务入口持续查看的任务标识。
 * @throws 同步克隆失败时不开始任务；异步文件、检查与记录错误保留到任务结果，调用方无需等待组件存活。
 */
export function startLessonExport(options: ExportOptions): string {
  const fixed = structuredClone({
    draft: options.draft,
    selected: options.selected,
    assets: options.assets,
  });
  const kinds: FileExportOutcome['kind'][] = [
    ...(options.packageOnly ? [] : ['html' as const]),
    ...(options.alsoPackage || options.packageOnly ? ['package' as const] : []),
  ];
  const existing = tasks.find(
    (task) =>
      task.running &&
      task.lessonId === fixed.draft.id &&
      task.draftRevision === fixed.draft.revision &&
      task.selectedRevision === fixed.selected.revision &&
      task.outcomes.map((item) => item.kind).join(',') === kinds.join(','),
  );
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  tasks = [
    ...tasks,
    {
      id,
      lessonId: fixed.draft.id,
      name: options.packageOnly ? fixed.draft.name : fixed.selected.name,
      draftRevision: fixed.draft.revision,
      selectedRevision: fixed.selected.revision,
      stage: '等待导出',
      running: true,
      outcomes: kinds.map((kind) => ({ kind, state: 'pending' })),
    },
  ];
  listeners.forEach((listener) => listener());
  persistHistory();
  const owners = new Map<number, { id: string; ready: Promise<unknown | undefined> }>();
  let preparedRevision = fixed.draft.preparedRevision ?? null;
  // Immediately capture failures even while queued. A failed draft reservation
  // must not hide HTML based on an independently retained legal selected revision.
  if (desktopAvailable)
    for (const revision of new Set([
      fixed.draft.revision,
      fixed.selected.revision,
      ...(preparedRevision ? [preparedRevision] : []),
    ])) {
      const ownerId = crypto.randomUUID();
      const ready = native.retainAssets(ownerId, [], fixed.draft.id, revision).then(
        () => undefined,
        (error: unknown) => error,
      );
      owners.set(revision, { id: ownerId, ready });
    }
  const requireSnapshot = async (revision: number) => {
    const error = await owners.get(revision)?.ready;
    if (error) throw error;
  };
  const run = async () => {
    try {
      if (fixed.draft.id !== fixed.selected.id || fixed.draft.gameId !== fixed.selected.gameId)
        throw new Error('导出草稿和运行版本不属于同一课件。');
      if (!options.packageOnly) {
        update(id, { stage: '检查所选课堂版本' });
        outcome(id, { kind: 'html', state: 'running' });
        try {
          await requireSnapshot(fixed.selected.revision);
          const game = getGame(fixed.selected.gameId);
          if (!game) throw new Error('当前软件不含所选游戏。');
          const structure = game
            .validateStructure(fixed.selected)
            .filter((issue) => issue.severity === 'error');
          if (structure.length) throw new Error(structure.map((issue) => issue.message).join('；'));
          const issues = game
            .validate(fixed.selected, fixed.assets)
            .filter((issue) => issue.severity === 'error');
          if (issues.length) throw new Error(issues.map((issue) => issue.message).join('；'));
          await validatePlayableAssets(fixed.selected, fixed.assets);
          // Compile this fixed input before marking it; current head/prepared
          // pointers cannot substitute for its independently checked teaching data.
          game.compile(fixed.selected, fixed.assets);
          const required = game.requiredAssets(fixed.selected);
          try {
            await markPrepared(
              fixed.selected,
              required,
              fixed.selected.revision !== fixed.draft.revision,
            );
            options.onPrepared?.(fixed.selected.revision);
          } catch (error) {
            // Later saves legitimately move the head. Only CAS conflicts may be
            // tolerated: native export independently checks the retained input.
            if (
              !error ||
              typeof error !== 'object' ||
              !('code' in error) ||
              error.code !== 'REVISION_CONFLICT'
            )
              throw error;
          }
          preparedRevision = fixed.selected.revision;
          update(id, { stage: '打包课堂HTML' });
          const html = await createClassroomHtml(fixed.selected, fixed.assets, {
            resolveAsset: readAssetData,
          });
          if (desktopAvailable) {
            update(id, { stage: '校验与保存课堂HTML' });
            const result = await native.exportHtml(
              html,
              suggestClassroomFileName(fixed.selected.name),
              fixed.selected.id,
              fixed.selected.revision,
              required,
              owners.get(fixed.selected.revision)?.id,
            );
            outcome(id, {
              kind: 'html',
              state: result.completed ? 'completed' : 'failed',
              result,
              error: result.error?.message,
            });
            if (result.completed && options.openAfterExport) {
              try {
                await native.openExport(result.path);
              } catch (error) {
                outcome(id, {
                  kind: 'html',
                  state: 'completed',
                  result,
                  error: `文件已保存，打开检查失败：${message(error)}`,
                });
              }
            }
          } else {
            const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = suggestClassroomFileName(fixed.selected.name);
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            outcome(id, { kind: 'html', state: 'completed', downloaded: true });
          }
        } catch (error) {
          outcome(id, { kind: 'html', state: 'failed', error: message(error) });
        }
      }
      if (kinds.includes('package')) {
        update(id, { stage: '检查与打包可编辑课件包' });
        outcome(id, { kind: 'package', state: 'running' });
        try {
          const revisions = [
            ...new Set([fixed.draft.revision, ...(preparedRevision ? [preparedRevision] : [])]),
          ];
          for (const revision of revisions) await requireSnapshot(revision);
          const result = await native.exportLessonPackage(
            fixed.draft.id,
            fixed.draft.revision,
            preparedRevision,
            revisions.flatMap((revision) =>
              owners.has(revision) ? [owners.get(revision)!.id] : [],
            ),
          );
          outcome(id, {
            kind: 'package',
            state: result.completed ? 'completed' : 'failed',
            result,
            error: result.error?.message,
          });
        } catch (error) {
          outcome(id, { kind: 'package', state: 'failed', error: message(error) });
        }
      }
    } catch (error) {
      const task = tasks.find((item) => item.id === id)!;
      for (const item of task.outcomes)
        outcome(id, { kind: item.kind, state: 'failed', error: message(error) });
    } finally {
      await Promise.allSettled(
        [...owners.values()].map(async (owner) => {
          await owner.ready;
          await native.releaseAssets(owner.id);
        }),
      );
      update(id, { stage: '已结束', running: false });
    }
  };
  queue = queue.then(run, run);
  return id;
}

/**
 * 同一文件复制期间拒绝重复操作；只复制原成品，不重新读取或制作课件。
 * @param taskId 当前会话或历史结果的任务标识，不存在时无操作。
 * @param kind 该任务中已经生成成品的文件类型；无本机成品时无操作。
 * @returns 原生复制结束后完成；取消或失败写入对应文件结果，保留其他文件的成功状态。
 */
export async function recopyTaskArtifact(
  taskId: string,
  kind: FileExportOutcome['kind'],
): Promise<void> {
  const task = tasks.find((item) => item.id === taskId);
  const item = task?.outcomes.find((entry) => entry.kind === kind);
  if (!task || task.running || !item?.result || item.state === 'running') return;
  const original = item.result;
  outcome(taskId, { ...item, state: 'running', error: undefined });
  try {
    const result = await native.recopyExport(
      original.localCopy,
      original.sha256,
      kind === 'html' ? suggestClassroomFileName(task.name) : `${task.name}.ecglesson`,
    );
    outcome(taskId, {
      kind,
      state: result.completed ? 'completed' : 'failed',
      result,
      error: result.error?.message,
    });
  } catch (error) {
    outcome(taskId, { ...item, state: 'failed', error: message(error) });
  }
}
