/**
 * 教师主动批改的原子操作。所有字符串先校验再克隆应用，避免部分词已改、后续词失败；
 * 智能锁定不拦截教师明确编辑，但原有锁定状态和未指定字段必须保留。
 * @author ahui
 */
import type { WordBeatLesson } from '../games/word-beat/model';
import {
  getEntries,
  PRESETS,
  refreshAudioDependencies,
  setEntryPriority,
  setEntryType,
} from '../games/word-beat/rules';

/** 缺省字段不修改；已选字段必须非空。preset / inherit 分别明确恢复预设或声音继承。 */
export interface BatchInputs {
  rounds?: string;
  chorusBeats?: string;
  chorusPerRead?: string;
  priority?: string;
  entryType?: string;
  followMode?: string;
  followBeats?: string;
  modelBeats?: string;
  voiceId?: string;
  rate?: string;
  lockPosition?: string;
  lockRounds?: string;
  lockFollow?: string;
  lockModel?: string;
  lockSound?: string;
  lockChorusBeats?: string;
  lockChorusRead?: string;
}

/**
 * 按明示的条目标识应用一次批改，不改变调用方的文档与录音绑定。
 * @param lesson 当前完整草稿，保留未涉及的原始错误输入。
 * @param ids 教师已勾选的独立条目标识，重复标识只处理一次。
 * @param input 弹窗原始值；整数/小数不合法时整批拒绝，不自动夹值。
 * @returns 可作为一次撤销记录提交的新草稿，声音按有效文本和覆盖参数重查。
 * @throws Error 选择为空、条目已删除、没有指定变更或字段不合法时抛出可读原因。
 */
export function applyEntryBatch(
  lesson: WordBeatLesson,
  ids: string[],
  input: BatchInputs,
): WordBeatLesson {
  const selected = new Set(ids);
  if (!selected.size) throw new Error('请先选择要修改的词条。');
  if (!Object.values(input).some((value) => value !== undefined))
    throw new Error('请选择至少一项需要修改的设置。');
  for (const value of Object.values(input)) {
    if (value !== undefined && !value.trim())
      throw new Error('整批未应用：已勾选的修改字段不能为空，请填写或取消勾选。');
  }
  const entries = getEntries(lesson);
  if ([...selected].some((id) => !entries.some((entry) => entry.id === id)))
    throw new Error('所选词条已变化，请重新选择。');

  const numeric: Partial<
    Record<
      'rounds' | 'followBeats' | 'modelBeats' | 'rate' | 'chorusBeats' | 'chorusPerRead',
      number
    >
  > = {};
  for (const [key, min, max, integer, label] of [
    ['rounds', 1, 8, true, '轮数'],
    ['chorusBeats', 1, 32, true, '齐读总拍数'],
    ['chorusPerRead', 1, 2, true, '每次朗读占用拍数'],
    ['followBeats', 1, 32, true, '跟读拍数'],
    ['modelBeats', 1, 32, true, '教师示范拍数'],
    ['rate', 0.75, 1.25, false, '语速'],
  ] as const) {
    const raw = input[key];
    if (
      raw === undefined ||
      (key === 'rate' && raw === 'inherit') ||
      ((key === 'rounds' || key === 'modelBeats') && raw === 'preset')
    )
      continue;
    const value = Number(raw);
    if (
      !raw.trim() ||
      !Number.isFinite(value) ||
      (integer && !Number.isInteger(value)) ||
      value < min ||
      value > max
    )
      throw new Error(
        `整批未应用：${label}须为${min}～${max}${integer ? '的整数' : '之间的数值'}。`,
      );
    numeric[key] = value;
  }
  for (const key of [
    'lockPosition',
    'lockRounds',
    'lockFollow',
    'lockModel',
    'lockSound',
    'lockChorusBeats',
    'lockChorusRead',
  ] as const) {
    if (input[key] && !['lock', 'unlock'].includes(input[key]))
      throw new Error('锁定选择无效，请重新选择。');
  }
  if (input.priority && !['yes', 'no'].includes(input.priority)) throw new Error('重点标记无效。');
  if (input.entryType && !['word', 'phrase'].includes(input.entryType))
    throw new Error('词条类型无效。');
  if (input.followMode && !['preset', 'manual'].includes(input.followMode))
    throw new Error('跟读来源无效。');
  if (input.followMode === 'preset' && input.followBeats)
    throw new Error('按预设公式计算时不能同时设置固定拍数。');

  let next = structuredClone(lesson);
  for (const id of selected) {
    if (input.priority) next = setEntryPriority(next, id, input.priority === 'yes');
    if (input.entryType) next = setEntryType(next, id, input.entryType as 'word' | 'phrase');
    const entry = getEntries(next).find((item) => item.id === id)!;
    if (numeric.chorusBeats !== undefined || numeric.chorusPerRead !== undefined) {
      entry.chorus ??= {
        beats: { value: 4, source: 'preset', locked: false },
        beatsPerRead: { value: 1, source: 'preset', locked: false },
      };
      if (numeric.chorusBeats !== undefined)
        entry.chorus.beats = {
          ...entry.chorus.beats,
          value: numeric.chorusBeats,
          source: 'manual',
        };
      if (numeric.chorusPerRead !== undefined)
        entry.chorus.beatsPerRead = {
          ...entry.chorus.beatsPerRead,
          value: numeric.chorusPerRead,
          source: 'manual',
        };
      if (entry.chorus.beats.value % entry.chorus.beatsPerRead.value !== 0)
        throw new Error('整批未应用：总拍数必须能被每次占用拍数整除。');
    }
    if (numeric.rounds !== undefined)
      entry.rounds = { ...entry.rounds, value: numeric.rounds, source: 'manual' };
    else if (input.rounds === 'preset')
      entry.rounds = {
        ...entry.rounds,
        value: entry.priority
          ? PRESETS[next.gameData.preset].priorityRounds
          : PRESETS[next.gameData.preset].normalRounds,
        source: 'preset',
      };
    if (input.followMode === 'preset')
      entry.follow = { ...entry.follow, mode: 'preset', preset: next.gameData.preset };
    else if (input.followMode === 'manual' || numeric.followBeats !== undefined)
      entry.follow = {
        ...entry.follow,
        mode: 'manual',
        beats: numeric.followBeats ?? entry.follow.beats,
      };
    if (numeric.modelBeats !== undefined)
      entry.modelBeats = { ...entry.modelBeats, value: numeric.modelBeats, source: 'manual' };
    else if (input.modelBeats === 'preset')
      entry.modelBeats = {
        ...entry.modelBeats,
        value: entry.entryType === 'phrase' ? 3 : 2,
        source: 'preset',
      };
    // 系统覆盖值不替换教师录音；当前为录音的词条完全跳过这两项。
    if (entry.audio?.source !== 'recording' && (input.voiceId || input.rate)) {
      entry.voiceOverrides ??= {};
      if (input.voiceId === 'inherit') delete entry.voiceOverrides.voiceId;
      else if (input.voiceId) entry.voiceOverrides.voiceId = input.voiceId;
      if (input.rate === 'inherit') delete entry.voiceOverrides.rate;
      else if (numeric.rate !== undefined) entry.voiceOverrides.rate = numeric.rate;
      if (!Object.keys(entry.voiceOverrides).length) delete entry.voiceOverrides;
    }
    if (input.lockChorusBeats || input.lockChorusRead) {
      entry.chorus ??= {
        beats: { value: 4, source: 'preset', locked: false },
        beatsPerRead: { value: 1, source: 'preset', locked: false },
      };
      if (input.lockChorusBeats) entry.chorus.beats.locked = input.lockChorusBeats === 'lock';
      if (input.lockChorusRead) entry.chorus.beatsPerRead.locked = input.lockChorusRead === 'lock';
    }
    if (input.lockPosition) entry.positionLocked = input.lockPosition === 'lock';
    if (input.lockRounds) entry.rounds.locked = input.lockRounds === 'lock';
    if (input.lockFollow) entry.follow.locked = input.lockFollow === 'lock';
    if (input.lockModel) entry.modelBeats.locked = input.lockModel === 'lock';
    if (input.lockSound) entry.soundLocked = input.lockSound === 'lock';
    // 仅明确修正过的字段移除原始错误，其他错误仍阻止准备和导出。
    for (const [specified, suffix] of [
      [input.rounds, 'rounds'],
      [input.chorusBeats, 'chorusBeats'],
      [input.chorusPerRead, 'chorusPerRead'],
      [input.followMode || input.followBeats, 'follow'],
      [input.modelBeats, 'model'],
    ] as const) {
      if (specified && next.draftInputs) delete next.draftInputs[`${id}.${suffix}`];
    }
  }
  return refreshAudioDependencies(next);
}
