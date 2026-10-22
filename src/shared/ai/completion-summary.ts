/** 教师明确接受的补全成果；不把候选推荐、已有释义或旧资料猜测成新成果。 @author ahui */
import type { TeachingEntry } from '../../platform/types';

/**
 * 仅统计有明确接受记录且仍有内容的字段；一个字段一次计数，不计候选数量。
 * 旧资料没有acceptedFields时记0，避免靠来源或当前非空值倒推教师操作。
 * @param entries 已确认教学条目；空数组返回0，各位置独立计数。
 * @returns 当前非空且有明确接受记录的教学字段总数。
 */
export function countConfirmedFields(entries: TeachingEntry[]): number {
  return entries.reduce(
    (count, entry) =>
      count +
      [...new Set(entry.meaningSource?.acceptedFields ?? [])].filter(
        (field) => !!entry[field]?.trim(),
      ).length,
    0,
  );
}
