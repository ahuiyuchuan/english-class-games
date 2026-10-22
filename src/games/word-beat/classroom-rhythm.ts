/**
 * 课堂齐读草稿与范围预览；复用课件字段，不另建教学时间轴。
 * 原始输入只在完整合法后进入候选；批量逐字段保护手动／锁定值。
 * @author ahui
 */
import type { WordBeatEntry, WordBeatLesson } from './model';
import { getEntries } from './rules';

/** 同一词的两项输入共同保留，允许从非法组合继续修正另一项。 */
export interface ClassroomRhythmDraft {
  id: string;
  beats: string;
  beatsPerRead: string;
  /** 只认领教师实际编辑的字段，取消批量预览不能留下其他字段的副本。 */
  edited: ('beats' | 'beatsPerRead')[];
}

/** null 表示未要求批改该字段；空字符串表示教师已启用但尚未完成输入。 */
export interface ClassroomRhythmBulk {
  beats: string | null;
  beatsPerRead: string | null;
  /** 教师明确允许改写手动值时为 true；锁定值在任何情况下均保留。 */
  includeManual?: boolean;
}

/** 旧课件未设置齐读字段时继承正式 4／1 默认，不根据词长推测。 */
export function getClassroomChorus(entry: WordBeatEntry): NonNullable<WordBeatEntry['chorus']> {
  return (
    entry.chorus ?? {
      beats: { value: 4, source: 'preset', locked: false },
      beatsPerRead: { value: 1, source: 'preset', locked: false },
    }
  );
}

/** 返回教师可就近修正的原因；拍数与朗读次数不能混用或静默取整。 */
export function classroomRhythmError(beats: string, beatsPerRead: string): string {
  const count = Number(beats);
  const perRead = Number(beatsPerRead);
  if (beats.trim() === '' || !Number.isInteger(count) || count < 1 || count > 32)
    return '每轮总拍数需为 1～32 的整数。';
  if (beatsPerRead.trim() === '' || ![1, 2].includes(perRead))
    return '每次朗读占用拍数只能为 1 或 2。';
  if (count % perRead !== 0)
    return `${count} 拍不能分成每次 ${perRead} 拍；请改为相邻的偶数拍，或每次 1 拍。`;
  return '';
}

/**
 * 生成不修改原对象的批量候选。两个启用字段一起计算，避免 3／1→4／2 被中间态误拒绝。
 * 只跳过被保护字段；若最终组合不整除，整次完成阻止，不悄悄提交部分词。
 */
export function previewClassroomRhythm(
  lesson: WordBeatLesson,
  bulk: ClassroomRhythmBulk,
  scope: string,
) {
  const next = structuredClone(lesson);
  let changed = 0;
  let protectedFields = 0;
  let error = '';
  if (lesson.gameData.soundMode !== 'chorus')
    return { lesson: next, changed, protectedFields, error };
  // 即使当前范围为0词也校验已输入目标，不能用空遍历吞掉教师的非法原输入。
  for (const field of ['beats', 'beatsPerRead'] as const) {
    const raw = bulk[field];
    if (raw === null) continue;
    const valid =
      field === 'beats'
        ? raw.trim() !== '' &&
          Number.isInteger(Number(raw)) &&
          Number(raw) >= 1 &&
          Number(raw) <= 32
        : raw.trim() !== '' && [1, 2].includes(Number(raw));
    if (!valid) {
      error = field === 'beats' ? '统一总拍数需为 1～32 的整数。' : '统一每次占拍只能为 1 或 2。';
      return { lesson: next, changed, protectedFields, error };
    }
  }
  for (const entry of getEntries(next)) {
    if (scope !== 'all' && entry.priority !== (scope === 'priority')) continue;
    const chorus = structuredClone(getClassroomChorus(entry));
    let entryChanged = false;
    for (const field of ['beats', 'beatsPerRead'] as const) {
      const raw = bulk[field];
      if (raw === null) continue;
      if (chorus[field].locked || (chorus[field].source === 'manual' && !bulk.includeManual)) {
        protectedFields += 1;
        continue;
      }
      if (chorus[field].value !== Number(raw)) {
        chorus[field].value = Number(raw);
        entryChanged = true;
      }
    }
    if (entryChanged) {
      entry.chorus = chorus;
      changed += 1;
    }
    if (bulk.beats !== null || bulk.beatsPerRead !== null)
      error ||= classroomRhythmError(String(chorus.beats.value), String(chorus.beatsPerRead.value))
        ? `${entry.english}：${classroomRhythmError(String(chorus.beats.value), String(chorus.beatsPerRead.value))} 手动／锁定值保持不变。`
        : '';
  }
  return { lesson: next, changed, protectedFields, error };
}

/**
 * 比较正式运行字段，来源变化不重新启动阶段。
 * includeGap=false 仅判断逐词拍数，用于对应的撤销入口；间隔没有冒充拍数撤销。
 */
export function classroomRhythmChanged(
  before: WordBeatLesson,
  after: WordBeatLesson,
  includeGap = true,
): boolean {
  if (after.gameData.soundMode !== 'chorus') return false;
  const previousEntries = new Map(getEntries(before).map((entry) => [entry.id, entry]));
  const nextEntries = getEntries(after);
  return (
    (includeGap &&
      (before.gameData.chorusGapBeats ?? 0) !== (after.gameData.chorusGapBeats ?? 0)) ||
    previousEntries.size !== nextEntries.length ||
    nextEntries.some((entry) => {
      const previousEntry = previousEntries.get(entry.id);
      if (!previousEntry) return true;
      const previous = getClassroomChorus(previousEntry);
      const next = getClassroomChorus(entry);
      return (
        previous.beats.value !== next.beats.value ||
        previous.beatsPerRead.value !== next.beatsPerRead.value
      );
    })
  );
}
