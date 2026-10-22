/** 导出记录的兼容读取；只恢复结果，不恢复已释放的制作输入或自动重启任务。 @author ahui */
import { z } from 'zod';
import type { LessonExportTask } from './exports';

const failure = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().nullable().optional(),
  retryable: z.boolean(),
});
const result = z.object({
  path: z.string(),
  localCopy: z.string(),
  sha256: z.string(),
  byteLength: z.number().nonnegative(),
  completed: z.boolean(),
  error: failure.optional(),
});
const outcome = z.object({
  kind: z.enum(['html', 'package']),
  state: z.enum(['pending', 'running', 'completed', 'failed']),
  result: result.optional(),
  error: z.string().optional(),
  downloaded: z.boolean().optional(),
  restored: z.boolean().optional(),
});
const task = z.object({
  id: z.string().min(1),
  lessonId: z.string().min(1),
  name: z.string(),
  draftRevision: z.number().int().positive(),
  selectedRevision: z.number().int().positive().optional(),
  stage: z.string().optional(),
  running: z.boolean().optional(),
  outcomes: z.array(outcome).min(1).max(2),
});

/**
 * 空存储兼容首次启动；旧数组记录兼容V1早期结构。更高格式版本或坏结构报错并
 * 保护原记录，不能用空列表覆盖。上次未结束的项目只标中断，已有成品仍可重复制。
 */
export function parseExportHistory(value: unknown): LessonExportTask[] {
  if (value == null) return [];
  let records: unknown = value;
  if (!Array.isArray(value)) {
    if (
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('tasks' in value)
    )
      throw new Error('导出记录格式不受当前软件支持，原记录已保留。');
    records = value.tasks;
  }
  const parsed = z.array(task).safeParse(records);
  if (!parsed.success) throw new Error('导出记录读取失败，原记录已保留；本次成品结果仍可查看。');
  if (new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length)
    throw new Error('导出记录包含重复任务，原记录已保留。');
  return parsed.data.map((item) => {
    const interrupted =
      item.running || item.outcomes.some((entry) => ['pending', 'running'].includes(entry.state));
    return {
      ...item,
      selectedRevision: item.selectedRevision ?? item.draftRevision,
      stage: interrupted ? '上次导出已中断' : (item.stage ?? '已结束'),
      running: false,
      outcomes: item.outcomes.map((entry) =>
        ['pending', 'running'].includes(entry.state)
          ? {
              ...entry,
              state: 'failed' as const,
              restored: true,
              error: '上次运行已中断；已有本机成品可重新复制，尚未生成成品请重新选择版本。',
            }
          : { ...entry, restored: true },
      ),
    };
  });
}
