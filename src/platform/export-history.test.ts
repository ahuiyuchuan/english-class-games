/** 记录兼容与中断恢复不重做导出，也不声称保留旧输入。 @author ahui */
import { expect, it } from 'vitest';
import { parseExportHistory } from './export-history';

it('首次与旧数组兼容，重启未完成项标中断并保留已有独立成品', () => {
  expect(parseExportHistory(null)).toEqual([]);
  const result = {
    path: '',
    localCopy: 'C:/exports/fixed.html',
    sha256: 'a'.repeat(64),
    byteLength: 25,
    completed: false,
  };
  const restored = parseExportHistory([
    {
      id: 'task',
      lessonId: 'lesson',
      name: '高中课件',
      draftRevision: 3,
      running: true,
      outcomes: [
        { kind: 'html', state: 'running', result },
        { kind: 'package', state: 'completed', result: { ...result, completed: true } },
      ],
    },
  ]);
  expect(restored[0]).toMatchObject({
    running: false,
    selectedRevision: 3,
    stage: '上次导出已中断',
  });
  expect(restored[0].outcomes[0]).toMatchObject({ state: 'failed', result });
  expect(restored[0].outcomes[0].error).toContain('尚未生成成品请重新选择版本');
  expect(restored[0].outcomes[1].state).toBe('completed');
});

it('未来版本或坏结构明确拒绝，不把其解释成空历史覆盖', () => {
  expect(() => parseExportHistory({ version: 2, tasks: [] })).toThrow('原记录已保留');
  expect(() => parseExportHistory({ version: 1, tasks: [{ id: 'incomplete' }] })).toThrow(
    '原记录已保留',
  );
});
