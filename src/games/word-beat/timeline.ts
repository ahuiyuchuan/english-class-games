/** 单词节拍编排结果及场景数据。 @author ahui */
import type { RuntimeCue, RuntimeTimeline } from '../../runtime/types';

/** 中央教学内容与阶段含义；画面和声音读取同一阶段。 */
export interface WordBeatCueData {
  /** 自主齐读的真实总拍数和朗读占拍，其他阶段不提供。 */
  totalBeats?: number;
  beatsPerRead?: number;
  label: string;
  english: string;
  meaning: string;
  entryId?: string;
  segmentName?: string;
  roundCount?: number;
}

/** 游戏专属字段在此扩展，不污染平台运行协议。 */
export interface WordBeatPlan extends RuntimeTimeline<WordBeatCueData> {
  bpm: number;
  lessonId: string;
  lessonRevision: number;
  assetIds: string[];
}

/**
 * 将真实阶段位置映射为本轮连续拍序，供拍垫和粒子共同读取，不建立动画时钟。
 * 示范与跟读属于同一轮：跟读须承接前段示范，不能每次切阶段都回到第一块。
 * 等待教师时偏移恰好等于阶段时长，仍保留最后一拍，避免凭空跳到下一拍。
 * @param cue 当前真实阶段；恢复准备等临时阶段独立从零计拍，未开始时可为空。
 * @param previousCue 固定编排中紧邻的前一阶段；仅同词同轮的示范可贡献拍数。
 * @param elapsedInCueMs 当前阶段经过时间，单位毫秒；负值及阶段终点按合法拍位处理。
 * @returns 零基拍序；未提供节拍时返回 0，超过四拍由展示层循环映射。
 */
export function getWordBeatBeatProgress(
  cue: RuntimeCue<WordBeatCueData> | undefined,
  previousCue: RuntimeCue<WordBeatCueData> | undefined,
  elapsedInCueMs: number,
): number {
  if (!cue?.pulseIntervalMs) return 0;
  const interval = cue.pulseIntervalMs;
  const lastBeat = Math.max(0, Math.ceil(cue.durationMs / interval) - 1);
  const localBeat = Math.min(lastBeat, Math.floor(Math.max(0, elapsedInCueMs) / interval));
  const modelBeats =
    cue.kind === 'follow' &&
    cue.itemIndex !== null &&
    previousCue?.kind === 'model' &&
    previousCue.itemIndex === cue.itemIndex &&
    previousCue.round === cue.round
      ? Math.round(previousCue.durationMs / interval)
      : 0;
  return modelBeats + localBeat;
}
