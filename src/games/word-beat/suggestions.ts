/**
 * 受保护的时间建议、可重复改编及换课复用。
 * 差异必须由教师确认；实际依赖变化后拒绝应用旧建议，不用“AI”掩盖覆盖。
 * @author ahui
 */
import templates from '../../../resources/slogan-templates.json';
import { createRandom, newRandomSeed, shuffle } from '../../shared/ai/random';
import { AI_RULES } from '../../shared/ai/catalog';
import type { AssetMap, TeachingEntry } from '../../platform/types';
import type { PresetId, WordBeatChange, WordBeatLesson, WordBeatSuggestion } from './model';
import {
  applyPreset,
  compileWordBeat,
  createId,
  createWordBeatLesson,
  getEntries,
  isSloganManual,
  refreshAudioDependencies,
  validateWordBeat,
} from './rules';
import { validateWordBeatStructure } from './structure';

/** 仅内部生成的路径可以应用；不接受用户给出的任意属性路径。 */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error('建议路径不合法。');
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  }, value);
}

/** 差异路径由本模块生成，写入前已整批验证旧值及依赖。 */
function writePath(value: unknown, path: string, next: unknown): void {
  const keys = path.split('.');
  const key = keys.pop()!;
  const parent = readPath(value, keys.join('.'));
  if (
    !parent ||
    typeof parent !== 'object' ||
    ['__proto__', 'prototype', 'constructor'].includes(key)
  )
    throw new Error('建议目标已不存在。');
  (parent as Record<string, unknown>)[key] = structuredClone(next);
}

/** JSON值的稳定比较用于实际依赖，不把全课修订号当作唯一有效性判据。 */
function serialized(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/** 只捕获影响当前建议的字段，因此无关释义修改不会废弃时间建议。 */
function timeDependencies(lesson: WordBeatLesson): Record<string, string> {
  const dependencies: Record<string, string> = {};
  const add = (path: string) => {
    dependencies[path] = serialized(readPath(lesson, path));
  };
  [
    'gameData.bpm.value',
    'gameData.targetDurationMs',
    'gameData.preset',
    'gameData.soundMode',
    'gameData.chorusGapBeats',
    'gameData.music.sync',
  ].forEach(add);
  const inherited = new Set<string>();
  const activeVoices = getEntries(lesson).filter(() => lesson.gameData.soundMode === 'voiced');
  if (
    activeVoices.some(
      (entry) => entry.audio?.source !== 'recording' && entry.voiceOverrides?.voiceId === undefined,
    )
  )
    inherited.add('englishVoiceId');
  if (
    activeVoices.some(
      (entry) => entry.audio?.source !== 'recording' && entry.voiceOverrides?.rate === undefined,
    )
  )
    inherited.add('englishRate');
  for (const [kind, slogan] of Object.entries(lesson.gameData.slogans)) {
    const prefix = `gameData.slogans.${kind}`;
    add(`${prefix}.enabled`);
    if (
      !slogan.enabled ||
      (kind === 'transition' &&
        lesson.gameData.segments.filter((segment) => segment.entries.length).length < 2)
    )
      continue;
    ['text', 'textSource', 'enabledSource', 'templateId', 'language', 'locked', 'audio'].forEach(
      (field) => add(`${prefix}.${field}`),
    );
    if (slogan.text.includes('{{lessonName}}')) add('name');
    if (slogan.audio?.source !== 'recording') {
      inherited.add(slogan.language === 'en-US' ? 'englishVoiceId' : 'chineseVoiceId');
      inherited.add(slogan.language === 'en-US' ? 'englishRate' : 'chineseRate');
    }
  }
  inherited.forEach((field) => add(`gameData.voices.${field}`));
  lesson.gameData.segments.forEach((segment, segmentIndex) => {
    add(`gameData.segments.${segmentIndex}.id`);
    segment.entries.forEach((_entry, entryIndex) => {
      const prefix = `gameData.segments.${segmentIndex}.entries.${entryIndex}`;
      ['id', 'english', 'priority', 'entryType', 'rounds', 'follow', 'chorus'].forEach((field) =>
        add(`${prefix}.${field}`),
      );
      (lesson.gameData.soundMode === 'voiced'
        ? ['audio', 'voiceOverrides']
        : ['modelBeats']
      ).forEach((field) => add(`${prefix}.${field}`));
    });
    dependencies[`gameData.segments.${segmentIndex}.entries.length`] = serialized(
      segment.entries.length,
    );
  });
  dependencies['gameData.segments.length'] = serialized(lesson.gameData.segments.length);
  return dependencies;
}

/** 当前依赖未变才可应用；忽略只对应生成建议时的这些依赖值。 */
export function isSuggestionCurrent(
  lesson: WordBeatLesson,
  suggestion: WordBeatSuggestion,
): boolean {
  return (
    Object.entries(suggestion.dependencies).every(
      ([path, value]) => serialized(readPath(lesson, path)) === value,
    ) &&
    suggestion.changes.every(
      (change) => serialized(readPath(lesson, change.path)) === serialized(change.before),
    )
  );
}

/** 整批应用前检查，失败不会写入任何一项；调用方可将返回值作为一次撤销记录。 */
export function applySuggestion(
  lesson: WordBeatLesson,
  suggestion: WordBeatSuggestion,
): WordBeatLesson {
  if (suggestion.state !== 'available' || !isSuggestionCurrent(lesson, suggestion))
    throw new Error('建议依赖已变化，请重新检查。');
  const result = structuredClone(lesson);
  for (const change of suggestion.changes) writePath(result, change.path, change.after);
  if (validateWordBeatStructure(result).length)
    throw new Error('建议产生不支持的课件结构，请重新检查。');
  result.gameData.suggestionHistory = [
    ...(result.gameData.suggestionHistory ?? []).filter((record) => record.id !== suggestion.id),
    { ...structuredClone(suggestion), state: 'applied' },
  ];
  return refreshAudioDependencies(result);
}

/** 保存教师已查看的候选；同一建议ID更新状态，不生成重复历史。 */
export function rememberSuggestion(
  lesson: WordBeatLesson,
  suggestion: WordBeatSuggestion,
): WordBeatLesson {
  if (!isSuggestionCurrent(lesson, suggestion)) throw new Error('建议依赖已变化，请重新检查。');
  const result = structuredClone(lesson);
  result.gameData.suggestionHistory = [
    ...(result.gameData.suggestionHistory ?? []).filter((record) => record.id !== suggestion.id),
    structuredClone(suggestion),
  ];
  return result;
}

/** 忽略只针对当前依赖快照；相关参数改变后仍允许新建议出现。 */
export function ignoreSuggestion(
  lesson: WordBeatLesson,
  suggestion: WordBeatSuggestion,
): WordBeatLesson {
  if (suggestion.state !== 'available') throw new Error('此建议已处理，请重新检查。');
  return rememberSuggestion(lesson, { ...suggestion, state: 'ignored' });
}

/** 历史已应用状态保留；未处理或已忽略项的依赖变化后明确显示需重新检查。 */
export function getSuggestionHistory(lesson: WordBeatLesson): WordBeatSuggestion[] {
  return (lesson.gameData.suggestionHistory ?? []).map((record) => ({
    ...structuredClone(record),
    state:
      record.state !== 'applied' && !isSuggestionCurrent(lesson, record) ? 'stale' : record.state,
  }));
}

/**
 * 预设切换同样先生成差异：只更新未锁定的预设值，不覆盖教师手动参数。
 * 依赖限定到实际参与预设的字段，释义、音色等无关编辑不会废弃此预览。
 * @param lesson 当前输入快照；函数不直接修改该对象。
 * @param preset 三种已注册练习预设之一。
 * @returns 可供教师确认的差异；没有任何实际修改时返回null。
 */
export function createPresetSuggestion(
  lesson: WordBeatLesson,
  preset: PresetId,
): WordBeatSuggestion | null {
  const result = applyPreset(lesson, preset);
  const changes: WordBeatChange[] = [];
  const dependencies: Record<string, string> = {};
  const capture = (path: string, reason: string, objectId?: string) => {
    const before = readPath(lesson, path);
    const after = readPath(result, path);
    dependencies[path] = serialized(before);
    if (serialized(before) !== serialized(after))
      changes.push({
        path,
        before: structuredClone(before),
        after: structuredClone(after),
        reason,
        objectId,
      });
  };
  capture('gameData.preset', '切换本课练习预设。', lesson.id);
  capture('gameData.bpm', '更新由预设管理且未锁定的节奏。', lesson.id);
  dependencies['gameData.segments.length'] = serialized(lesson.gameData.segments.length);
  lesson.gameData.segments.forEach((segment, segmentIndex) => {
    dependencies[`gameData.segments.${segmentIndex}.id`] = serialized(segment.id);
    dependencies[`gameData.segments.${segmentIndex}.entries.length`] = serialized(
      segment.entries.length,
    );
    segment.entries.forEach((entry, entryIndex) => {
      const prefix = `gameData.segments.${segmentIndex}.entries.${entryIndex}`;
      for (const field of ['id', 'priority', 'entryType'])
        dependencies[`${prefix}.${field}`] = serialized(readPath(lesson, `${prefix}.${field}`));
      capture(`${prefix}.rounds`, '按普通 / 重点更新预设管理的练习轮数。', entry.id);
      capture(`${prefix}.follow`, '更新未锁定的跟读公式，保留手动拍数。', entry.id);
      capture(`${prefix}.modelBeats`, '按单词 / 短语更新预设管理的教师示范拍数。', entry.id);
    });
  });
  if (!changes.length) return null;
  return {
    id: createId(),
    ruleId: AI_RULES.preset,
    inputRevision: lesson.revision,
    kind: 'preset',
    title: '切换练习预设',
    reason: '仅更新由预设管理且未锁定的参数；保留教师手动值和锁定项。',
    changes,
    dependencies,
    state: 'available',
  };
}

/**
 * 解释当前实际编排与目标的差额。没有可自动修改项时也能给教师明确指引，
 * 不制造空差异、不越过30分钟上限。超限时指向已有的拆课预览，
 * 由教师检查分组与真实时长后确认创建副本，不能让说明暗示自动删词或直接拆课。
 * @param lesson 当前固定课件，用于读取教师设置的目标时长。
 * @param durationMs 已按真实声音算出的毫秒数；未准备完整时省略。
 * @returns 超目标时的具体建议；时长未知或未超目标时返回 undefined。
 */
export function getDurationGuidance(
  lesson: WordBeatLesson,
  durationMs?: number,
): string | undefined {
  const target = lesson.gameData.targetDurationMs;
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= target)
    return undefined;
  const difference = ((durationMs - target) / 1000).toFixed(1);
  const adjustment =
    '请调整允许修改的参数，或在“比较练习目标／预览拆为多课”中查看分组后确认创建副本（保留原课与全部词条）。';
  if (target >= 1_800_000)
    return `目标已达30分钟上限，当前编排仍超出${difference}秒；${adjustment}`;
  const proposedMinutes = Math.min(30, Math.ceil(durationMs / 600) / 100);
  const remaining = Math.max(0, durationMs - 1_800_000);
  return `当前编排超出目标${difference}秒；可将目标延长至${proposedMinutes}分钟（不超过30分钟）${remaining > 0 ? `，仍超出${(remaining / 1000).toFixed(1)}秒；${adjustment}` : '，也可保留目标调整允许修改的参数，或预览拆为多课。'}`;
}

/** 将检查失败、目标内、保护项和已忽略区分开，避免“无建议”掩盖输入错误。 */
export function explainTimeSuggestions(
  lesson: WordBeatLesson,
  assets: AssetMap,
  durationMs?: number,
): string {
  if (durationMs === undefined) {
    const issue = validateWordBeat(lesson, assets).find((value) => value.severity === 'error');
    return `暂不能提出时间方案：${issue?.message ?? '请先检查参数与所需声音。'}`;
  }
  const target = lesson.gameData.targetDurationMs;
  const summary = `目标 ${(target / 1000).toFixed(1)} 秒 · 实际 ${(durationMs / 1000).toFixed(1)} 秒（不含教师等待、暂停和临时重读）。`;
  if (durationMs <= target)
    return `${summary} 已在目标内，少 ${((target - durationMs) / 1000).toFixed(1)} 秒；不会自动加词或补轮填满。`;
  const ignored = lesson.gameData.suggestionHistory?.some(
    (item) => item.kind === 'time' && item.state === 'ignored' && isSuggestionCurrent(lesson, item),
  );
  if (ignored) return `${summary} 本次时间建议已忽略；相关内容变化后可重新检查。`;
  const protectedCount = getEntries(lesson).filter(
    (entry) => entry.rounds.locked || entry.rounds.source === 'manual',
  ).length;
  return `${summary} ${protectedCount} 条轮数为手动或锁定，自动方案保留这些值。${getDurationGuidance(lesson, durationMs) ?? ''}`;
}

/** 从真实安排计算时间建议，按普通词再重点词逐轮降低，不删词也不改BPM。 */
export function createTimeSuggestions(
  lesson: WordBeatLesson,
  assets: AssetMap,
): WordBeatSuggestion[] {
  let beforeDurationMs: number;
  try {
    beforeDurationMs = compileWordBeat(lesson, assets).durationMs;
  } catch {
    return [];
  }
  if (beforeDurationMs <= lesson.gameData.targetDurationMs) return [];
  const result = structuredClone(lesson);
  const changes: WordBeatChange[] = [];
  let durationMs = beforeDurationMs;
  const transition = result.gameData.slogans.transition;
  if (
    transition.enabled &&
    !transition.locked &&
    transition.enabledSource === 'preset' &&
    !isSloganManual(transition) &&
    result.gameData.segments.filter((segment) => segment.entries.length).length > 1
  ) {
    changes.push({
      path: 'gameData.slogans.transition.enabled',
      before: true,
      after: false,
      objectId: transition.id,
      reason: '关闭段间可选口号，保留教学词条和练习空间。',
    });
    transition.enabled = false;
    changes.push({
      path: 'gameData.slogans.transition.enabledSource',
      before: transition.enabledSource,
      after: 'manual',
      objectId: transition.id,
      reason: '教师接受本次关闭建议，之后不由预设自动恢复。',
    });
    durationMs = compileWordBeat(result, assets).durationMs;
  }
  for (const priority of [false, true]) {
    let changed = true;
    while (durationMs > result.gameData.targetDurationMs && changed) {
      changed = false;
      result.gameData.segments.forEach((segment, segmentIndex) =>
        segment.entries.forEach((entry, entryIndex) => {
          if (
            durationMs <= result.gameData.targetDurationMs ||
            entry.priority !== priority ||
            entry.rounds.locked ||
            entry.rounds.source === 'manual' ||
            entry.rounds.value <= 1
          )
            return;
          const path = `gameData.segments.${segmentIndex}.entries.${entryIndex}.rounds`;
          const existing = changes.find((change) => change.path === path);
          const before = structuredClone(entry.rounds);
          entry.rounds.value -= 1;
          // 候选阶段保留预设来源以便本次逐轮遍历，应用值标记为教师确认。
          const after = { ...entry.rounds, source: 'manual' as const };
          if (existing) existing.after = after;
          else
            changes.push({
              path,
              before,
              after,
              objectId: entry.id,
              reason: `${priority ? '重点' : '普通'}词减少练习轮数，最低保留1轮。`,
            });
          durationMs = compileWordBeat(result, assets).durationMs;
          changed = true;
        }),
      );
    }
  }
  if (!changes.length) return [];
  const candidate: WordBeatSuggestion = {
    id: createId(),
    ruleId: AI_RULES.duration,
    inputRevision: lesson.revision,
    kind: 'time',
    title: '调整练习以接近目标时长',
    reason: getDurationGuidance(lesson, durationMs) ?? '保留全部词条，优先减少普通词的预设轮数。',
    changes,
    dependencies: timeDependencies(lesson),
    beforeDurationMs,
    afterDurationMs: durationMs,
    state: 'available',
  };
  const existing = (lesson.gameData.suggestionHistory ?? []).find(
    (record) =>
      record.ruleId === candidate.ruleId &&
      ['available', 'ignored'].includes(record.state) &&
      isSuggestionCurrent(lesson, record),
  );
  if (existing?.state === 'ignored') return [];
  return [existing ? structuredClone(existing) : candidate];
}

/** 改编选项全部先生成差异，不直接改变词表。 */
export interface RemixOptions {
  seed?: number;
  shuffleEntries?: boolean;
  restorePreset?: boolean;
  overrideManual?: boolean;
  /** 仅允许替换手改口号；不解除锁定，也不授权更改手动练习参数。 */
  overrideManualSlogans?: boolean;
}

/** 指定随机标记可复现；默认保护手改口号，明确授权仍不得修改锁定口号。 */
export function remixLesson(
  lesson: WordBeatLesson,
  options: RemixOptions = {},
): WordBeatSuggestion | null {
  const seed = options.seed ?? newRandomSeed();
  const random = createRandom(seed);
  const result = structuredClone(lesson);
  const changes: WordBeatChange[] = [];
  const append = (path: string, after: unknown, reason: string, objectId?: string) => {
    const before = readPath(lesson, path);
    if (serialized(before) !== serialized(after))
      changes.push({
        path,
        before: structuredClone(before),
        after: structuredClone(after),
        reason,
        objectId,
      });
  };
  for (const kind of ['opening', 'transition', 'closing'] as const) {
    const slogan = result.gameData.slogans[kind];
    if (!slogan.enabled || slogan.locked) continue;
    const manuallyEdited = isSloganManual(slogan);
    if (manuallyEdited && !options.overrideManualSlogans) continue;
    const candidates = templates.templates
      .filter(
        (item) =>
          item.purpose === kind &&
          item.language === slogan.language &&
          item.id !== slogan.templateId &&
          item.text !== slogan.text,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) continue;
    const next = candidates[Math.floor(random() * candidates.length)];
    append(
      `gameData.slogans.${kind}.text`,
      next.text,
      '选择同用途、同语言的其他已校对模板。',
      slogan.id,
    );
    append(`gameData.slogans.${kind}.templateId`, next.id, '记录本次口号模板来源。', slogan.id);
    append(
      `gameData.slogans.${kind}.textSource`,
      'template',
      '本次明确选用模板，保留新的文本来源。',
      slogan.id,
    );
  }
  if (options.shuffleEntries)
    result.gameData.segments.forEach((segment, segmentIndex) => {
      const available = shuffle(
        segment.entries.filter((entry) => !entry.positionLocked),
        random,
      );
      let cursor = 0;
      const entries = segment.entries.map((entry) =>
        entry.positionLocked ? entry : available[cursor++],
      );
      append(
        `gameData.segments.${segmentIndex}.entries`,
        entries,
        '只调整本段未锁定位置，不跨段移动。',
        segment.id,
      );
      segment.entries = entries;
    });
  if (options.restorePreset) {
    const base = structuredClone(result);
    if (options.overrideManual) {
      if (!base.gameData.bpm.locked) base.gameData.bpm.source = 'preset';
      getEntries(base).forEach((entry) => {
        if (!entry.rounds.locked) entry.rounds.source = 'preset';
        if (!entry.follow.locked) entry.follow.mode = 'preset';
        if (!entry.modelBeats.locked) entry.modelBeats.source = 'preset';
      });
    }
    const restored = applyPreset(base, result.gameData.preset);
    append('gameData.bpm', restored.gameData.bpm, '恢复允许变更的节奏预设。');
    // 与洗牌同时进行时整段差异要基于最终结果，避免子路径叠加覆盖。
    restored.gameData.segments.forEach((segment, index) => {
      const existing = changes.find(
        (change) => change.path === `gameData.segments.${index}.entries`,
      );
      if (existing) existing.after = segment.entries;
      else
        segment.entries.forEach((entry, entryIndex) => {
          append(
            `gameData.segments.${index}.entries.${entryIndex}.rounds`,
            entry.rounds,
            '恢复允许修改的练习轮数。',
            entry.id,
          );
          append(
            `gameData.segments.${index}.entries.${entryIndex}.follow`,
            entry.follow,
            '恢复允许修改的跟读公式。',
            entry.id,
          );
          append(
            `gameData.segments.${index}.entries.${entryIndex}.modelBeats`,
            entry.modelBeats,
            '恢复允许修改的教师示范拍数。',
            entry.id,
          );
        });
    });
  }
  if (!changes.length) return null;
  changes.push({
    path: 'gameData.seed',
    before: lesson.gameData.seed,
    after: seed,
    reason: '保存主动改编的随机选择标记。',
  });
  // 改编只依赖实际勾选的范围。默认仅换口号时，释义、目标时长及声音制作
  // 不会撤掉仍适用的候选；整段洗牌要写回完整条目，所以保留完整旧值防覆盖。
  const dependencies: Record<string, string> = {};
  const depend = (path: string) => {
    dependencies[path] = serialized(readPath(lesson, path));
  };
  for (const kind of ['opening', 'transition', 'closing'] as const) {
    ['enabled', 'enabledSource', 'textSource', 'locked', 'language', 'text', 'templateId'].forEach(
      (field) => depend(`gameData.slogans.${kind}.${field}`),
    );
  }
  if (options.shuffleEntries || options.restorePreset) {
    depend('gameData.segments.length');
    lesson.gameData.segments.forEach((segment, index) => {
      depend(`gameData.segments.${index}.id`);
      if (options.shuffleEntries) depend(`gameData.segments.${index}.entries`);
      else {
        depend(`gameData.segments.${index}.entries.length`);
        segment.entries.forEach((_entry, entryIndex) =>
          ['id', 'rounds', 'follow', 'modelBeats', 'entryType', 'priority'].forEach((field) =>
            depend(`gameData.segments.${index}.entries.${entryIndex}.${field}`),
          ),
        );
      }
    });
  }
  if (options.restorePreset) {
    depend('gameData.preset');
    depend('gameData.bpm');
  }
  return {
    id: createId(),
    ruleId: AI_RULES.variant,
    inputRevision: lesson.revision,
    kind: 'remix',
    title: '换一版',
    reason: options.overrideManualSlogans
      ? '只修改勾选范围，允许替换手改口号；所有锁定项继续保留。'
      : '只修改勾选范围，手改口号、手动参数及锁定项继续保留。',
    changes,
    dependencies,
    state: 'available',
  };
}

/** 普通复制重建业务标识，保留教学安排与不可变素材引用。 */
export function copyLesson(
  lesson: WordBeatLesson,
  name = `${[...lesson.name].slice(0, 76).join('')}（副本）`,
  idFactory = createId,
): WordBeatLesson {
  const result = structuredClone(lesson);
  result.id = idFactory();
  result.name = name;
  result.revision = 0;
  result.preparedRevision = null;
  // 新课件没有教师在此副本中作出的建议决定，不继承旧ID和旧依赖路径。
  result.gameData.suggestionHistory = [];
  result.sourceLesson = { id: lesson.id, revision: lesson.revision };
  result.createdAt = new Date().toISOString();
  result.updatedAt = result.createdAt;
  const mapping = new Map<string, string>();
  mapping.set(lesson.id, result.id);
  result.gameData.segments.forEach((segment) => {
    const nextSegment = idFactory();
    mapping.set(segment.id, nextSegment);
    segment.id = nextSegment;
    segment.entries.forEach((entry) => {
      const next = idFactory();
      mapping.set(entry.id, next);
      entry.id = next;
    });
  });
  Object.values(result.gameData.slogans).forEach((slogan) => {
    const next = idFactory();
    mapping.set(slogan.id, next);
    slogan.id = next;
  });
  if (result.draftInputs) {
    result.draftInputs = Object.fromEntries(
      Object.entries(result.draftInputs).map(([key, input]) => [
        // 字段定位以“对象ID.字段”保存，复制后必须连同摘要定位一起换ID。
        key
          .split('.')
          .map((part) => mapping.get(part) ?? part)
          .join('.'),
        {
          ...input,
          objectId: input.objectId ? (mapping.get(input.objectId) ?? input.objectId) : undefined,
        },
      ]),
    );
  }
  return refreshAudioDependencies(result);
}

/** 换材料只继承课级设置，新条目不按英文/位置继承旧轮数、锁定或录音。 */
export function replaceMaterials(
  lesson: WordBeatLesson,
  entries: TeachingEntry[],
  preset: PresetId = lesson.gameData.preset,
): WordBeatLesson {
  const result = structuredClone(lesson);
  const replacement = createWordBeatLesson(entries, {
    preset,
    soundMode: lesson.gameData.soundMode,
  });
  result.gameData.segments = replacement.gameData.segments;
  result.gameData.preset = preset;
  const removedIds = new Set([
    ...getEntries(lesson).map((entry) => entry.id),
    ...lesson.gameData.segments.map((segment) => segment.id),
  ]);
  // 替换只移除已删除条目的未完成输入，课级BPM等草稿仍需教师修复。
  result.draftInputs = Object.fromEntries(
    Object.entries(result.draftInputs ?? {}).filter(
      ([key, input]) => !removedIds.has(input.objectId ?? '') && !removedIds.has(key.split('.')[0]),
    ),
  );
  result.preparedRevision = null;
  const oldSystem = getEntries(lesson).filter((entry) => entry.audio?.source === 'system');
  getEntries(result).forEach((entry) => {
    const matched = oldSystem.find(
      (old) =>
        old.english.trim() === entry.english.trim() &&
        old.audio?.voiceId === result.gameData.voices.englishVoiceId &&
        old.audio?.rate === result.gameData.voices.englishRate,
    );
    if (matched?.audio) entry.audio = structuredClone(matched.audio);
  });
  return refreshAudioDependencies(result);
}
