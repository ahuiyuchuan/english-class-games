/** 导出统一入口与真实结果；选旧版不回退草稿，返回不取消后台写盘。 @author ahui */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AssetMap, LessonDocument } from '../platform/types';
import { getLesson } from '../platform/repository';
import { getGame } from '../platform/games';
import * as native from '../platform/native';
import {
  getExportTasks,
  subscribeExportTasks,
  startLessonExport,
  recopyTaskArtifact,
  loadExportHistory,
  getExportHistoryError,
  retryExportHistory,
} from '../platform/exports';
import type { LessonExportTask } from '../platform/exports';
import { Button, Check, Modal, Notice, errorMessage } from '../shared/ui';

/** 只比较实际内容；摘要不声称系统理解语义，也不向教师显示内部字段或标识。 */
function difference(current: LessonDocument, old: LessonDocument, assets: AssetMap): string[] {
  const game = getGame(current.gameId);
  const before = game?.summarize?.(old, assets);
  const after = game?.summarize?.(current, assets);
  return [
    ...(old.name !== current.name ? [`课件名：${old.name} → ${current.name}`] : []),
    ...(before?.itemCount !== undefined && after?.itemCount !== undefined
      ? [`${after.itemLabel ?? '练习项'}：${before.itemCount} → ${after.itemCount}`]
      : []),
    JSON.stringify(old.gameData) === JSON.stringify(current.gameData) &&
    JSON.stringify(old.draftInputs) === JSON.stringify(current.draftInputs)
      ? '教学内容与活动设置相同'
      : '教学内容或活动设置已有变化；导出旧版将保留旧版安排',
  ];
}

/** 文件结果独立展示，包没有课堂播放按钮；已有成品才能重新复制。 */
export function ExportTaskResult({
  task,
  onRestart,
}: {
  task: LessonExportTask;
  onRestart?: () => void;
}) {
  const [error, setError] = useState('');
  const action = (run: () => Promise<unknown>) => {
    void run().catch((cause) => setError(errorMessage(cause)));
  };
  return (
    <div className="stack" aria-live="polite">
      <p>
        {task.name} · 草稿v{task.draftRevision}
        {task.outcomes.some((item) => item.kind === 'html')
          ? ` / 课堂v${task.selectedRevision}`
          : ''}{' '}
        · {task.stage}
      </p>
      {task.outcomes.map((item) => (
        <section className="panel stack-sm" key={item.kind}>
          <h3>{item.kind === 'html' ? '课堂HTML' : '可编辑课件包'}</h3>
          <p>
            {item.state === 'running'
              ? '处理中'
              : item.state === 'pending'
                ? '等待处理'
                : item.downloaded
                  ? '已生成浏览器下载，请检查实际文件'
                  : item.result?.completed
                    ? item.restored
                      ? '上次记录：目标已保存；可检查本机副本，原目标尚未重新核验'
                      : '目标文件已校验并保存'
                    : item.result
                      ? '本机成品已保留，目标复制未完成'
                      : '尚未生成成品'}
          </p>
          {item.error && <Notice tone="warning">{item.error}</Notice>}
          {item.result && (
            <>
              <p className="file-path">
                {item.result.completed ? item.result.path : item.result.localCopy}
              </p>
              {item.restored && <p className="file-path">本机副本：{item.result.localCopy}</p>}
              {!item.result.completed && item.result.path && (
                <p className="file-path">未完成的目标：{item.result.path}</p>
              )}
              <div className="row wrap">
                {item.kind === 'html' && (
                  <Button
                    onClick={() =>
                      action(() =>
                        native.openExport(
                          item.result!.completed && !item.restored
                            ? item.result!.path
                            : item.result!.localCopy,
                        ),
                      )
                    }
                  >
                    {item.restored ? '打开本机副本检查' : '打开检查'}
                  </Button>
                )}
                <Button
                  onClick={() =>
                    action(() =>
                      native.openExport(
                        item.result!.completed && !item.restored
                          ? item.result!.path
                          : item.result!.localCopy,
                        true,
                      ),
                    )
                  }
                >
                  {item.restored ? '打开本机副本文件夹' : '打开文件夹'}
                </Button>
                {(!item.result.completed || item.restored) && (
                  <Button
                    busy={item.state === 'running'}
                    disabled={task.running}
                    onClick={() => action(() => recopyTaskArtifact(task.id, item.kind))}
                  >
                    重新复制
                  </Button>
                )}
              </div>
            </>
          )}
          {!task.running && (item.state === 'failed' || item.restored) && onRestart && (
            <Button onClick={onRestart}>重新导出（重新选版）</Button>
          )}
        </section>
      ))}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/**
 * getCurrent负责完成编辑会话保存；对话框与任务分离，组件退出后任务仍可在公共入口查看。
 * onPrepared仅通知调用页检查完成的修订，不能用旧结果覆盖当前编辑内容。
 */
export function LessonExportDialog({
  open,
  assets,
  getCurrent,
  onPrepared,
  onClose,
  initialKind = 'html',
}: {
  open: boolean;
  assets: AssetMap;
  getCurrent: () => Promise<LessonDocument>;
  onPrepared?: (revision: number, lessonId: string) => void;
  onClose: () => void;
  initialKind?: 'html' | 'package';
}) {
  const [draft, setDraft] = useState<LessonDocument>();
  const [prepared, setPrepared] = useState<LessonDocument>();
  const [selected, setSelected] = useState<'current' | 'prepared'>('current');
  const [alsoPackage, setAlsoPackage] = useState(false);
  const [openAfter, setOpenAfter] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [taskId, setTaskId] = useState<string>();
  const readSequence = useRef(0);
  // 打开、重新读取与退出共用递增序列；清理必须使当时所有未完成读取失效。
  const advanceReadSequence = useCallback(() => ++readSequence.current, []);
  const submitted = useRef(false);
  const callbacks = useRef({ getCurrent, onPrepared });
  callbacks.current = { getCurrent, onPrepared };
  const tasks = useSyncExternalStore(subscribeExportTasks, getExportTasks);
  const task = tasks.find((item) => item.id === taskId);
  const reload = () => {
    const sequence = advanceReadSequence();
    submitted.current = false;
    setTaskId(undefined);
    setDraft(undefined);
    setPrepared(undefined);
    setSelected('current');
    setError('');
    setLoading(true);
    void callbacks.current
      .getCurrent()
      .then(async (current) => {
        if (sequence !== readSequence.current) return;
        setDraft(current);
        if (initialKind === 'html' && current.preparedRevision) {
          const snapshot = await getLesson(current.id, current.preparedRevision);
          if (sequence === readSequence.current) setPrepared(snapshot);
        }
      })
      .catch((cause) => {
        if (sequence === readSequence.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (sequence === readSequence.current) setLoading(false);
      });
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (open) reloadRef.current();
    return () => {
      advanceReadSequence();
    };
  }, [open, initialKind, advanceReadSequence]);
  const submit = (packageOnly: boolean) => {
    if (submitted.current || loading || !draft || (!packageOnly && !choice)) return;
    submitted.current = true;
    const preparedCallback = callbacks.current.onPrepared;
    setTaskId(
      startLessonExport({
        draft,
        selected: packageOnly ? draft : choice!,
        assets,
        alsoPackage: packageOnly || alsoPackage,
        packageOnly,
        openAfterExport: !packageOnly && openAfter,
        onPrepared: (revision) => preparedCallback?.(revision, draft.id),
      }),
    );
  };
  const choice = selected === 'prepared' ? prepared : draft;
  const summary = choice && getGame(choice.gameId)?.summarize?.(choice, assets);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={initialKind === 'package' ? '导出可编辑课件包' : '导出课堂文件'}
      footer={
        <>
          <Button onClick={onClose}>返回{task?.running ? '（后台继续）' : ''}</Button>
          {!task && (
            <Button
              variant={initialKind === 'package' ? 'primary' : 'secondary'}
              busy={loading}
              disabled={!draft}
              onClick={() => submit(true)}
            >
              仅保存可编辑包
            </Button>
          )}
          {!task && initialKind === 'html' && (
            <Button
              variant="primary"
              busy={loading}
              disabled={!draft || !choice}
              onClick={() => submit(false)}
            >
              检查并导出
            </Button>
          )}
        </>
      }
    >
      {task ? (
        <ExportTaskResult task={task} onRestart={reload} />
      ) : (
        <div className="stack">
          {loading && <p role="status">读取已保存版本…</p>}
          {draft && (
            <>
              <p>
                {draft.name} · 当前保存版本 v{draft.revision}
              </p>
              {initialKind === 'html' && (
                <fieldset className="stack-sm">
                  <legend>课堂文件使用的版本</legend>
                  <label>
                    <input
                      type="radio"
                      name="export-version"
                      checked={selected === 'current'}
                      onChange={() => setSelected('current')}
                    />
                    当前草稿 v{draft.revision}（默认）
                  </label>
                  {prepared && (
                    <label>
                      <input
                        type="radio"
                        name="export-version"
                        checked={selected === 'prepared'}
                        onChange={() => setSelected('prepared')}
                      />
                      上次已准备版 v{prepared.revision} ·{' '}
                      {new Date(prepared.updatedAt).toLocaleString()}
                    </label>
                  )}
                </fieldset>
              )}
              {prepared && selected === 'prepared' && (
                <Notice tone="warning">
                  <p>仅本次HTML使用旧版，当前草稿保留。</p>
                  {difference(draft, prepared, assets).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </Notice>
              )}
              {initialKind === 'html' && (
                <>
                  <p>
                    准备状态：
                    {summary?.preparationState === 'ready'
                      ? '已准备，导出前仍会检查'
                      : '需检查所选版本'}
                    {summary?.durationMs !== undefined
                      ? ` · 编排 ${(summary.durationMs / 60000).toFixed(1)} 分钟`
                      : ''}
                  </p>
                  <Check
                    checked={alsoPackage}
                    onChange={(event) => setAlsoPackage(event.target.checked)}
                    label="同时保存可编辑课件包"
                  />
                  <Check
                    checked={openAfter}
                    onChange={(event) => setOpenAfter(event.target.checked)}
                    label="导出后打开检查"
                  />
                </>
              )}
              <Notice>
                {initialKind === 'html' ? '课堂文件只检查所选运行版本。' : ''}
                可编辑包独立保留本次草稿与准备版；可带走尚未完成的教学输入，全部引用素材仍须完整。可编辑包用于安装备课软件的电脑，不用于浏览器课堂播放。
              </Notice>
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}

/** 公共入口持有任务结果视图，跨页面返回后仍可查看已完成或失败的实际成品。 */
export function ExportTaskCenter({ onRestart }: { onRestart?: (lessonId: string) => void } = {}) {
  const tasks = useSyncExternalStore(subscribeExportTasks, getExportTasks);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void loadExportHistory();
  }, []);
  const historyError = getExportHistoryError();
  return (
    <>
      <Button variant="text" onClick={() => setOpen(true)}>
        导出任务
        {tasks.some((task) => task.running)
          ? `（${tasks.filter((task) => task.running).length}）`
          : ''}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title="导出任务">
        {historyError && (
          <Notice tone="warning">
            {historyError}
            <Button
              onClick={() => {
                void retryExportHistory();
              }}
            >
              重试保存导出记录
            </Button>
          </Notice>
        )}
        {tasks.length ? (
          <div className="stack">
            {[...tasks].reverse().map((task) => (
              <ExportTaskResult
                key={task.id}
                task={task}
                onRestart={
                  onRestart
                    ? () => {
                        setOpen(false);
                        onRestart(task.lessonId);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <p>暂无导出任务。</p>
        )}
      </Modal>
    </>
  );
}
