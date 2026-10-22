/**
 * 每课独立的浏览器课堂偏好；包含已完成的文字副本，不写课件、音频或运行进度。
 * 桌面预演和离线 HTML 共用此边界，localStorage 不可用时由界面明确降级。
 * @author ahui
 */
import { z } from 'zod';
import type { AssetMap } from '../../platform/types';
import type { WordBeatLesson } from './model';
import { compileWordBeat, createWordBeatEntry, getEntries, requiredAssets } from './rules';

const namespace = 'ecg:word-beat:classroom:';
const maximumLength = 256 * 1024;
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
// 已交付 v1／v2 的严格字段集合保持不变，不能靠放宽旧 schema 偷渡新参数。
const legacySettingsSchema = z
  .object({
    bpm: integer(50, 180),
    progression: z.enum(['auto', 'step']),
    loop: z.boolean(),
    resumePreparationBeats: z.union([z.literal(0), z.literal(2)]),
    displayMode: z.enum(['centered', 'blocks']),
    showMeaning: z.boolean(),
    stageEffects: z.boolean(),
    showWordTrack: z.boolean(),
    volumes: z
      .object({
        voice: z.number().min(0).max(1),
        beat: z.number().min(0).max(1),
        music: z.number().min(0).max(1),
      })
      .strict(),
    rounds: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
            value: integer(1, 8),
            source: z.enum(['preset', 'manual']),
            locked: z.boolean(),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
const rhythmRule = (value: z.ZodType<number>) =>
  z.object({ value, source: z.enum(['preset', 'manual']), locked: z.boolean() }).strict();
// 已交付 v3 的严格结构冻结；后续版本只能显式扩展，旧版本不能夹带新字段。
const version3SettingsSchema = legacySettingsSchema.extend({
  chorus: z
    .array(
      z
        .object({
          id: z.string().min(1).max(512),
          // 隐藏的其他模式参数只原样保存，不在错误模式下强行修正教学数据。
          // 结构和有限数始终校验；活动模式的范围／组合在 apply 中判断。
          beats: rhythmRule(z.number().finite()),
          beatsPerRead: rhythmRule(z.number().finite()),
        })
        .strict(),
    )
    .max(4096),
  chorusGapBeats: z.number().finite(),
});
const version4SettingsSchema = version3SettingsSchema.extend({
  soundMode: z.enum(['voiced', 'teacher', 'chorus']),
  entries: z
    .array(
      z
        .object({
          id: z.string().min(1).max(512),
          // 不在结构层裁剪原文；Unicode 长度、空白和控制字符由正式编排统一判断。
          english: z.string(),
          meaning: z.string(),
        })
        .strict(),
    )
    .max(4096),
});
// v5 明确携带课堂词表及适用的练习参数，不把新词序藏进旧版文字数组。
// 新增词不存完整游戏对象；恢复时从正式默认值重建，不能注入音频、锁定或来源。
const settingsSchema = version4SettingsSchema.extend({
  segments: z
    .array(
      z
        .object({
          id: z.string().min(1).max(512),
          entryIds: z.array(z.string().min(1).max(512)).max(100),
        })
        .strict(),
    )
    .max(4096),
  practice: z
    .array(
      z
        .object({
          id: z.string().min(1).max(512),
          entryType: z.enum(['word', 'phrase']),
          entryTypeSource: z.enum(['preset', 'manual']),
          priority: z.boolean(),
          modelBeats: rhythmRule(z.number().finite()),
          follow: z
            .object({
              mode: z.enum(['preset', 'manual']),
              beats: z.number().finite(),
              locked: z.boolean(),
              preset: z.enum(['regular', 'focus', 'quick']).optional(),
            })
            .strict(),
        })
        .strict(),
    )
    .min(1)
    .max(100),
});
const envelopeFields = {
  lessonId: z.string(),
  identity: z.string(),
};
// v1 用全素材库作身份，v2 起只核对本课实际依赖。旧记录只能按旧规则验证，
// 不能把任意无法匹配的旧摘要解释为“只是无关素材变化”而绕过过期保护。
const envelopeSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...envelopeFields, settings: legacySettingsSchema }).strict(),
  z.object({ version: z.literal(2), ...envelopeFields, settings: legacySettingsSchema }).strict(),
  z.object({ version: z.literal(3), ...envelopeFields, settings: version3SettingsSchema }).strict(),
  z.object({ version: z.literal(4), ...envelopeFields, settings: version4SettingsSchema }).strict(),
  z.object({ version: z.literal(5), ...envelopeFields, settings: settingsSchema }).strict(),
]);

/** 与文件协议独立的本地设置；文字、模式及规则快照一起提交，来源和锁定随保存保留。 */
export type ClassroomSettings = z.infer<typeof settingsSchema>;

/** 返回当前课的唯一键；不枚举或删除其他课件／平台的记录。 */
export function classroomStorageKey(lesson: WordBeatLesson): string {
  return `${namespace}${encodeURIComponent(lesson.id)}`;
}

/**
 * 稳定排序后作双 32 位变化摘要，识别修订、正文、规则及素材元信息的变化。
 * 这是过期检测而非加密／鉴权；恢复仍独立校验全部字段与正式编排。
 * v2 起只取原课件启用的正式素材依赖，避免导入其他课的音乐使本课设置失效。
 * legacyAllAssets 仅用于读取 v1 旧记录；摘要过程保持旧版逐字节兼容。
 * 不包含音频字节／原路径，不会为了读取小配置解码声音。
 */
function identity(lesson: WordBeatLesson, assets: AssetMap, legacyAllAssets = false): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, part]) => [key, stable(part)]),
      );
    return value;
  };
  const text = JSON.stringify(
    stable({
      lesson,
      assets: (legacyAllAssets
        ? Object.values(assets)
        : requiredAssets(lesson).flatMap((id) => (assets[id] ? [assets[id]] : []))
      )
        .map(({ assetId, sha256, durationMs, byteLength }) => ({
          assetId,
          sha256,
          durationMs,
          byteLength,
        }))
        .sort((a, b) => a.assetId.localeCompare(b.assetId)),
    }),
  );
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index += 1) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(index);
  }
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

/** 创建独立设置快照；装饰值由课堂提供，教学值来自已校验的课堂副本。 */
export function captureClassroomSettings(
  lesson: WordBeatLesson,
  visual = { stageEffects: true, showWordTrack: true },
): ClassroomSettings {
  const data = lesson.gameData;
  return {
    bpm: data.bpm.value,
    soundMode: data.soundMode,
    entries: getEntries(lesson).map(({ id, english, meaning }) => ({ id, english, meaning })),
    segments: data.segments.map(({ id, entries }) => ({
      id,
      entryIds: entries.map((entry) => entry.id),
    })),
    practice: getEntries(lesson).map((entry) => ({
      id: entry.id,
      entryType: entry.entryType,
      entryTypeSource: entry.entryTypeSource,
      priority: entry.priority,
      modelBeats: { ...entry.modelBeats },
      follow: { ...entry.follow },
    })),
    progression: data.progression,
    loop: data.loop,
    resumePreparationBeats: data.resumePreparationBeats,
    displayMode: data.displayMode,
    showMeaning: data.showMeaning,
    ...visual,
    volumes: { ...data.volumes },
    rounds: getEntries(lesson).map(({ id, rounds }) => ({ id, ...rounds })),
    // 三种模式均携带隐藏配置，切换模式不能删掉教师原有的齐读安排。
    // 旧课件无 chorus 时读取既有 4／1 语义，不修改原条目或预设来源。
    chorus: getEntries(lesson).map(({ id, chorus }) => ({
      id,
      beats: { ...(chorus?.beats ?? { value: 4, source: 'preset', locked: false }) },
      beatsPerRead: {
        ...(chorus?.beatsPerRead ?? { value: 1, source: 'preset', locked: false }),
      },
    })),
    chorusGapBeats: data.chorusGapBeats ?? 0,
  };
}

/**
 * 将未知本地数据转换成独立可编排课件。只认领课堂可编辑字段；
 * 条目集合、锁定、对拍速度约束不允许通过修改存储绕过。
 * @throws Error 数据无效、锁定不匹配或整课无法运行；原对象均不修改。
 */
function applyLegacyClassroomSettings(
  original: WordBeatLesson,
  value: unknown,
  assets: AssetMap,
): WordBeatLesson {
  const result = version4SettingsSchema.safeParse(value);
  if (!result.success) throw new Error('本地课堂设置的数据不完整或超出允许范围。');
  const settings = result.data;
  const entries = getEntries(original);
  const texts = new Map(settings.entries.map((entry) => [entry.id, entry]));
  if (
    texts.size !== settings.entries.length ||
    entries.length !== settings.entries.length ||
    entries.some((entry, index) => settings.entries[index].id !== entry.id)
  )
    throw new Error('本地词语与当前课件词条及顺序不匹配，不能增删或重排词语。');
  if (
    settings.soundMode !== original.gameData.soundMode &&
    !(original.gameData.soundMode === 'voiced' && settings.soundMode === 'teacher')
  )
    throw new Error('本地课堂模式只能沿用课件模式，或将配音跟读明确改为文字领读。');
  const rounds = new Map(settings.rounds.map((entry) => [entry.id, entry]));
  if (
    rounds.size !== settings.rounds.length ||
    entries.length !== rounds.size ||
    entries.some((entry) => !rounds.has(entry.id))
  )
    throw new Error('本地轮数与当前课件词条不匹配。');
  const chorus = new Map(settings.chorus.map((entry) => [entry.id, entry]));
  if (
    chorus.size !== settings.chorus.length ||
    entries.length !== chorus.size ||
    entries.some((entry) => !chorus.has(entry.id))
  )
    throw new Error('本地齐读拍数与当前课件词条不匹配。');
  for (const entry of entries) {
    const saved = rounds.get(entry.id)!;
    if (
      saved.locked !== entry.rounds.locked ||
      (entry.rounds.locked &&
        (saved.value !== entry.rounds.value || saved.source !== entry.rounds.source))
    )
      throw new Error('本地轮数不能覆盖课件锁定值。');
    for (const field of ['beats', 'beatsPerRead'] as const) {
      const current = entry.chorus?.[field] ?? {
        value: field === 'beats' ? 4 : 1,
        source: 'preset',
        locked: false,
      };
      const savedRhythm = chorus.get(entry.id)![field];
      if (
        savedRhythm.locked !== current.locked ||
        (current.locked &&
          (savedRhythm.value !== current.value || savedRhythm.source !== current.source))
      )
        throw new Error('本地齐读拍数不能覆盖课件锁定值。');
      if (
        original.gameData.soundMode !== 'chorus' &&
        (savedRhythm.value !== current.value || savedRhythm.source !== current.source)
      )
        throw new Error('当前模式只能保留原有齐读拍数，请在编辑器切换模式后调整。');
    }
    const rhythm = chorus.get(entry.id)!;
    if (
      original.gameData.soundMode === 'chorus' &&
      (!Number.isInteger(rhythm.beats.value) ||
        rhythm.beats.value < 1 ||
        rhythm.beats.value > 32 ||
        ![1, 2].includes(rhythm.beatsPerRead.value) ||
        rhythm.beats.value % rhythm.beatsPerRead.value !== 0)
    )
      throw new Error('本地齐读拍数不完整或超出允许范围，总拍数必须能被每次占用拍数整除。');
  }
  const data = original.gameData;
  if (
    data.soundMode === 'chorus'
      ? !Number.isInteger(settings.chorusGapBeats) ||
        settings.chorusGapBeats < 0 ||
        settings.chorusGapBeats > 4
      : settings.chorusGapBeats !== (data.chorusGapBeats ?? 0)
  )
    throw new Error(
      data.soundMode === 'chorus'
        ? '本地词间间隔不完整或超出允许范围，需为0～4拍整数。'
        : '当前模式只能保留原有齐读词间间隔，请在编辑器切换模式后调整。',
    );
  if (
    data.soundMode === 'chorus' &&
    data.music.enabled &&
    data.music.syncEnabled &&
    settings.bpm !== data.bpm.value
  )
    throw new Error('本地节奏与已准备的对拍音乐不一致。');
  const next = structuredClone(original);
  Object.assign(next.gameData, {
    soundMode: settings.soundMode,
    progression: settings.progression,
    loop: settings.loop,
    resumePreparationBeats: settings.resumePreparationBeats,
    displayMode: settings.displayMode,
    showMeaning: settings.showMeaning,
    volumes: { ...settings.volumes },
    // 原先缺省且仍为 0 时不额外物化旧课件字段；显式调整才保存新的间隔。
    ...(data.chorusGapBeats !== undefined || settings.chorusGapBeats !== 0
      ? { chorusGapBeats: settings.chorusGapBeats }
      : {}),
  });
  next.gameData.bpm.value = settings.bpm;
  for (const entry of getEntries(next)) {
    const text = texts.get(entry.id)!;
    // 只修改文字副本，保留 ID、顺序、类型、配音和来源。失配配音由正式编排拒绝，
    // 不能在此丢弃声音或自动降级；显式文字领读仍可保留旧音频供恢复原词后使用。
    if (entry.meaningSource && text.meaning !== entry.meaning)
      entry.meaningSource = { ...entry.meaningSource, teacherRevised: true };
    entry.english = text.english;
    entry.meaning = text.meaning;
    const saved = rounds.get(entry.id)!;
    entry.rounds = { value: saved.value, source: saved.source, locked: saved.locked };
    const rhythm = chorus.get(entry.id)!;
    // 未编辑的旧条目保持缺省表示；已经存在或明确改变的齐读值完整克隆，
    // 避免返回对象、调用方设置快照与原课件共用 RuleValue 引用。
    if (
      entry.chorus ||
      rhythm.beats.value !== 4 ||
      rhythm.beats.source !== 'preset' ||
      rhythm.beatsPerRead.value !== 1 ||
      rhythm.beatsPerRead.source !== 'preset'
    )
      entry.chorus = { beats: { ...rhythm.beats }, beatsPerRead: { ...rhythm.beatsPerRead } };
  }
  compileWordBeat(next, assets);
  return next;
}

/** 仅投影旧格式明确拥有的字段，旧 schema 不接受 v5 词表或练习参数偷渡。 */
function version4Settings(settings: ClassroomSettings): z.infer<typeof version4SettingsSchema> {
  return version4SettingsSchema.parse(
    Object.fromEntries(
      Object.entries(settings).filter(([key]) => key !== 'segments' && key !== 'practice'),
    ),
  );
}

/**
 * 将课堂词表和适用参数恢复到独立副本，再复用原来的文字、声音、轮数及编排门禁。
 * 原组及锁定位置不可借本地记录改写；新增词不拥有录音、锁定或材料来源注入权限。
 * @param original 当前文件携带的原课件，不是已修改的课堂副本。
 * @param value 本轮 v5 内存设置或不可信本地数据，字段不完整时拒绝。
 * @param assets 本课真实素材，用于声音匹配和正式编排验证。
 * @returns 可直接编排的独立课堂副本，不修改原课件、素材或浏览器存储。
 * @throws Error 词表、分组、锁定、隐藏参数不合法，或整课不能正式运行。
 */
export function applyClassroomSettings(
  original: WordBeatLesson,
  value: unknown,
  assets: AssetMap,
): WordBeatLesson {
  const result = settingsSchema.safeParse(value);
  if (!result.success) throw new Error('本地课堂设置的数据不完整或超出允许范围。');
  const settings = result.data;
  const originalEntries = getEntries(original);
  const originals = new Map(originalEntries.map((entry) => [entry.id, entry]));
  const texts = new Map(settings.entries.map((entry) => [entry.id, entry]));
  const practice = new Map(settings.practice.map((entry) => [entry.id, entry]));
  const orderedIds = settings.segments.flatMap((segment) => segment.entryIds);
  if (
    orderedIds.length < 1 ||
    orderedIds.length > 100 ||
    new Set(orderedIds).size !== orderedIds.length ||
    texts.size !== settings.entries.length ||
    practice.size !== settings.practice.length ||
    orderedIds.length !== settings.entries.length ||
    orderedIds.length !== settings.practice.length ||
    orderedIds.some((id, index) => settings.entries[index].id !== id || !practice.has(id))
  )
    throw new Error('课堂词表需有1～100个唯一词条，文字、练习参数与显示顺序必须一致。');
  if (
    settings.segments.length !== original.gameData.segments.length ||
    settings.segments.some((segment, index) => segment.id !== original.gameData.segments[index].id)
  )
    throw new Error('课堂只调整现有分组内的词语，不能改变分组集合或顺序。');

  const reserved = new Set([
    original.id,
    ...original.gameData.segments.map((segment) => segment.id),
    ...Object.values(original.gameData.slogans).map((slogan) => slogan.id),
  ]);
  const next = structuredClone(original);
  for (const [segmentIndex, segment] of original.gameData.segments.entries()) {
    const targetIds = settings.segments[segmentIndex].entryIds;
    const sourceIds = new Set(segment.entries.map((entry) => entry.id));
    const sourcePositions = new Map(segment.entries.map((entry, index) => [entry.id, index]));
    const lockedPositions = segment.entries.flatMap((entry, index) =>
      entry.positionLocked ? [index] : [],
    );
    for (const [index, entry] of segment.entries.entries()) {
      if (entry.positionLocked && targetIds[index] !== entry.id)
        throw new Error(`${entry.english}的位置已锁定，不能删除、移动或跨越该位置。`);
    }
    next.gameData.segments[segmentIndex].entries = targetIds.map((id, targetIndex) => {
      if (reserved.has(id) || (originals.has(id) && !sourceIds.has(id)))
        throw new Error('课堂词条不能跨组移动或复用其他课件对象的标识。');
      const sourceIndex = sourcePositions.get(id);
      // 锁定词自己原位不动仍不足够：不能交换锁定词两侧的条目绕过移动边界。
      if (
        sourceIndex !== undefined &&
        lockedPositions.some((index) => sourceIndex < index !== targetIndex < index)
      )
        throw new Error('课堂词条不能跨越已锁定的位置。');
      const source = originals.get(id);
      const saved = practice.get(id)!;
      const text = texts.get(id)!;
      const entry = source
        ? structuredClone(source)
        : createWordBeatEntry(
            {
              id,
              english: '',
              meaning: '',
              priority: false,
              entryType: saved.entryType,
            },
            original.gameData.preset,
            () => id,
          );
      const sameModel =
        entry.modelBeats.value === saved.modelBeats.value &&
        entry.modelBeats.source === saved.modelBeats.source;
      const sameFollow =
        entry.follow.mode === saved.follow.mode &&
        entry.follow.beats === saved.follow.beats &&
        entry.follow.preset === saved.follow.preset;
      if (
        saved.modelBeats.locked !== entry.modelBeats.locked ||
        (entry.modelBeats.locked && !sameModel) ||
        saved.follow.locked !== entry.follow.locked ||
        (entry.follow.locked && !sameFollow)
      )
        throw new Error('课堂拍数不能改写示范或跟读的锁定值。');
      if (settings.soundMode === 'chorus' && (!sameModel || !sameFollow))
        throw new Error('自主齐读只能保留原有示范和跟读参数，隐藏参数不能参与课堂修改。');
      if (settings.soundMode === 'voiced' && !sameModel)
        throw new Error('配音跟读的示范时长由录音决定，不能修改教师示范拍数。');
      if (source && saved.entryType !== source.entryType && saved.entryTypeSource !== 'manual')
        throw new Error('课堂修改词语类型需明确记录为教师手动值。');
      Object.assign(entry, {
        entryType: saved.entryType,
        entryTypeSource: saved.entryTypeSource,
        priority: saved.priority,
        modelBeats: { ...saved.modelBeats },
        follow: { ...saved.follow },
      });
      // 原英文暂不覆盖，让旧门禁继续判断配音与新文字是否真正匹配；
      // 新词本身没有声音，因此配音模式必须由教师明确处理后才能提交。
      if (!source) Object.assign(entry, { english: text.english, meaning: text.meaning });
      return entry;
    });
  }
  return applyLegacyClassroomSettings(next, version4Settings(settings), assets);
}

/**
 * 读取结果区分无记录、成功恢复和异常回退，供提示选择短显或持续警告。
 * noticeKind 仅为本次读取的内部结果，不写入本地 v5；损坏记录不静默清除。
 */
export function loadClassroomSettings(
  lesson: WordBeatLesson,
  assets: AssetMap,
): {
  lesson: WordBeatLesson;
  settings: ClassroomSettings;
  notice: string;
  noticeKind: 'none' | 'restored' | 'fallback';
} {
  const fallback = {
    lesson: structuredClone(lesson),
    settings: captureClassroomSettings(lesson),
    notice: '',
    noticeKind: 'none' as const,
  };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(classroomStorageKey(lesson));
  } catch {
    return {
      ...fallback,
      noticeKind: 'fallback',
      notice: '浏览器无法读取本地设置，当前使用课件原始设置。完成时可重试保存，或仅本次使用。',
    };
  }
  if (raw === null) return fallback;
  try {
    // 先限制字符数，再按与写入一致的 UTF-8 字节数核验，中文记录不放宽体积上限。
    if (raw.length > maximumLength || new TextEncoder().encode(raw).byteLength > maximumLength)
      throw new Error('记录过大');
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    if (
      envelope.lessonId !== lesson.id ||
      envelope.identity !== identity(lesson, assets, envelope.version === 1)
    )
      return {
        ...fallback,
        noticeKind: 'fallback',
        notice:
          envelope.version === 1
            ? '旧版本地设置无法与当前课件及素材库核对，未套用且保留原记录，当前使用课件原始设置。可检查后重新完成设置。'
            : '课件内容或版本已变化，未套用旧的本地设置，当前使用课件原始设置。',
      };
    // 旧记录缺失的文字／模式及拍数偏好只继承原课件真实配置，
    // 不从已恢复的草稿反推来源。旧 schema 先独立严格解析，读取不写，完成才升级 v5。
    const settings =
      envelope.version >= 4
        ? envelope.settings
        : { ...version4Settings(captureClassroomSettings(lesson)), ...envelope.settings };
    const restored =
      envelope.version === 5
        ? applyClassroomSettings(lesson, settings, assets)
        : applyLegacyClassroomSettings(lesson, settings, assets);
    return {
      lesson: restored,
      // Zod 按 schema 顺序重建对象；统一捕获恢复快照，避免仅键顺序不同就
      // 被课堂的 JSON 快照比较误认为未保存草稿。读取仍不写入或升级旧记录。
      settings: captureClassroomSettings(restored, {
        stageEffects: settings.stageEffects,
        showWordTrack: settings.showWordTrack,
      }),
      notice: '已恢复本课在当前浏览器保存的设置，播放从头开始。',
      noticeKind: 'restored',
    };
  } catch {
    return {
      ...fallback,
      noticeKind: 'fallback',
      notice:
        '本地课堂设置损坏、版本不支持或安排不可用，当前使用课件原始设置。可重新设置并完成，或恢复课件原始设置。',
    };
  }
}

/**
 * 校验成功后单键写入；localStorage.setItem 失败保留旧记录，调用方不得先应用。
 * @throws Error 配置非法、超过 256 KiB 或浏览器禁止／无法完成保存。
 */
export function saveClassroomSettings(
  lesson: WordBeatLesson,
  assets: AssetMap,
  settings: ClassroomSettings,
): void {
  applyClassroomSettings(lesson, settings, assets);
  const raw = JSON.stringify({
    version: 5,
    lessonId: lesson.id,
    identity: identity(lesson, assets),
    settings,
  });
  if (new TextEncoder().encode(raw).byteLength > maximumLength)
    throw new Error('课堂设置超过本地记录的 256 KiB 上限，尚未保存。');
  try {
    window.localStorage.setItem(classroomStorageKey(lesson), raw);
  } catch {
    throw new Error(
      '浏览器未能保存设置（存储被禁用或空间不足）。请重试，或明确选择「仅本次使用」。',
    );
  }
}

/** 仅清除当前课件的偏好，失败时保留现有课堂并允许重试。 */
export function clearClassroomSettings(lesson: WordBeatLesson): void {
  try {
    window.localStorage.removeItem(classroomStorageKey(lesson));
  } catch {
    throw new Error('浏览器未能清除本课本地设置，请重试；当前设置保持不变。');
  }
}
