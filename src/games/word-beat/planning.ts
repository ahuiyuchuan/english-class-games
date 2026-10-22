/** 教学方案比较与整课拆分只生成候选；不写库、不改变原课。 @author ahui */
import type { AssetMap } from '../../platform/types';
import type { WordBeatLesson } from './model';
import { compileWordBeat, getEntries } from './rules';
import { copyLesson } from './suggestions';

/**
 * 按原顺序保留全部出现位置；以真实编排（包括段落准备和口号）衡量分组。
 * 单词本身超过目标时独立保留并显示超时，不删词、不降轮、不改 BPM。
 * 声音不完整或分组使占位符配音失效时抛出原检查错误，调用方不得伪造时长。
 */
export function proposeLessonSplit(
  lesson: WordBeatLesson,
  assets: AssetMap,
): { lesson: WordBeatLesson; durationMs: number }[] {
  compileWordBeat(lesson, assets);
  const groups: string[][] = [];
  let current: string[] = [];
  const subset = (ids: string[]) => {
    const result = structuredClone(lesson),
      selected = new Set(ids);
    result.gameData.segments = result.gameData.segments
      .map((segment) => ({
        ...segment,
        entries: segment.entries.filter((entry) => selected.has(entry.id)),
      }))
      .filter((segment) => segment.entries.length);
    return result;
  };
  for (const entry of getEntries(lesson)) {
    const candidate = [...current, entry.id];
    const duration = compileWordBeat(subset(candidate), assets).durationMs;
    if (current.length && duration > lesson.gameData.targetDurationMs) {
      groups.push(current);
      current = [entry.id];
    } else current = candidate;
  }
  if (current.length) groups.push(current);
  if (groups.length < 2) return [];
  return groups.map((ids, index) => {
    const result = copyLesson(
      subset(ids),
      `${[...lesson.name].slice(0, 65).join('')} · 第${index + 1}课`,
    );
    return { lesson: result, durationMs: compileWordBeat(result, assets).durationMs };
  });
}
