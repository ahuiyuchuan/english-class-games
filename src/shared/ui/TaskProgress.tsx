/** 共享真实任务进度；不把成功数、耗时或模型推理伪装成整体百分比。 @author ahui */
import type { TaskRecord } from '../../platform/native';

/**
 * 原生 completed 含缓存成功，失败另计；终止任务保持已处理数量，不人为填满。
 * 未知总量省略 value，交给原生 progress 表达不确定进度。
 */
export function TaskProgress({ task }: { task: TaskRecord }) {
  const processed = Math.min(task.total, task.completed + task.failures.length);
  const active = ['queued', 'running', 'cancelling'].includes(task.state);
  const labels: Record<TaskRecord['state'], string> = {
    queued: '等待制作',
    running: '正在制作声音',
    completed: '声音已准备好',
    partialFailure: '部分声音需要重试',
    failed: '声音制作失败',
    cancelling: '正在取消，请稍候',
    cancelled: '制作已取消',
    interrupted: '制作已中断',
  };
  const reused = task.results.filter((result) => result.cached).length;
  return (
    <div
      className="task-progress"
      data-state={task.state}
      data-active={active && !task.cancelRequested}
    >
      <div className="task-progress-heading" role="status" aria-atomic="true">
        <strong>{task.cancelRequested && active ? '正在取消，请稍候' : labels[task.state]}</strong>
        <span>
          {task.total > 0 ? `已处理 ${processed} / ${task.total} 项` : '正在确认任务数量'}
        </span>
      </div>
      <progress
        aria-label="声音任务处理进度"
        max={task.total > 0 ? task.total : 1}
        value={task.total > 0 ? processed : undefined}
      />
      <div className="task-progress-details">
        <span>{task.stage}</span>
        <span>
          成功 {task.completed} 项{reused > 0 ? `（复用 ${reused} 项）` : ''}
        </span>
        {task.failures.length > 0 && (
          <span className="error-text">失败 {task.failures.length} 项</span>
        )}
        {task.total > processed && <span>未处理 {task.total - processed} 项</span>}
        {task.inputRevision !== undefined && <span>内容版本 v{task.inputRevision}</span>}
      </div>
      {active && (
        <p className="muted">
          {task.cancelRequested || task.state === 'cancelling'
            ? '正在停止当前声音；已完成结果保留，不会继续制作后续项。'
            : task.state === 'queued'
              ? '前面的声音任务完成后会自动开始。'
              : '按实际声音逐项更新；单项制作期间进度保持不变。'}
        </p>
      )}
    </div>
  );
}
