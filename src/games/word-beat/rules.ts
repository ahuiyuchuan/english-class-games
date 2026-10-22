/**
 * 高中词汇节拍规则：三个预设、真实声音检查及整拍编排。
 * 所有函数返回副本，不直接覆盖教师草稿，也不在课堂实时生成声音。
 * @author ahui
 */
import templates from '../../../resources/slogan-templates.json';
import { newRandomSeed, normalizeSpeechText } from '../../shared/ai/random';
import {
  summarizeAudioProduction,
  type AudioProductionSuccess,
  type AudioProductionSummary,
} from '../../shared/ai/audio-summary';
import type {
  AssetMap,
  AudioAsset,
  AudioBinding,
  AudioRequest,
  RuleValue,
  TeachingEntry,
  ValidationIssue,
} from '../../platform/types';
import type {
  CreateWordBeatOptions,
  PresetId,
  WordBeatData,
  WordBeatEntry,
  WordBeatLesson,
  WordBeatSlogan,
  VoiceOverrides,
} from './model';
import type { WordBeatCueData, WordBeatPlan } from './timeline';
import type { RuntimeCue } from '../../runtime/types';
import { DECODED_AUDIO_BUDGET } from '../../runtime/audio-budget';
import { validateWordBeatStructure } from './structure';
import { validateTeachingEntry } from '../../platform/materials/parser';

/** 教学预设中的差异只有此表一处定义。 */
export const PRESETS = {
  regular: { name: '常规巩固', bpm: 100, normalRounds: 2, priorityRounds: 3, followExtra: 0 },
  focus: { name: '重点强化', bpm: 90, normalRounds: 3, priorityRounds: 4, followExtra: 1 },
  quick: { name: '限时复习', bpm: 110, normalRounds: 1, priorityRounds: 2, followExtra: 0 },
} as const;

/** 提供稳定UUID入口以便受控测试，不把可见英文当作业务标识。 */
export function createId(): string {
  return globalThis.crypto.randomUUID();
}

/** 预设值包装，教师手工修改应保留 source=manual。 */
export function presetValue<T>(value: T): RuleValue<T> {
  return { value, source: 'preset', locked: false };
}

/** 创建独立条目；词形和音节不凭文本长度猜测。 */
export function createWordBeatEntry(
  entry: TeachingEntry,
  preset: PresetId,
  idFactory = createId,
): WordBeatEntry {
  const phrase =
    entry.entryType === 'phrase' || normalizeSpeechText(entry.english).split(' ').length > 1;
  return {
    // 教学材料可能来自旧课件选词，只复制教学字段，不带入游戏锁定、录音或覆盖值。
    english: entry.english,
    meaning: entry.meaning,
    partOfSpeech: entry.partOfSpeech,
    priority: entry.priority,
    tags: structuredClone(entry.tags),
    unit: entry.unit,
    source: structuredClone(entry.source),
    meaningSource: structuredClone(entry.meaningSource),
    confirmed: entry.confirmed,
    id: idFactory(),
    entryType: phrase ? 'phrase' : 'word',
    entryTypeSource: 'preset',
    // 新建／新增词条先完整练习一轮；主动应用教学预设仍可按保护规则调整。
    rounds: presetValue(1),
    follow: { mode: 'preset', beats: phrase ? 3 : 2, locked: false, preset },
    modelBeats: presetValue(phrase ? 3 : 2),
    positionLocked: false,
    soundLocked: false,
  };
}

/** 创建首版完整配置；无音色时保留待制作状态，由教师主动选择文字领读。 */
export function createWordBeatLesson(
  entries: TeachingEntry[],
  options: CreateWordBeatOptions = {},
): WordBeatLesson {
  const id = options.idFactory ?? createId;
  const now = options.now ?? new Date().toISOString();
  const preset = options.preset ?? 'regular';
  const local = new Date(now);
  const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const slogan = (purpose: 'opening' | 'transition' | 'closing'): WordBeatSlogan => {
    const template = templates.templates.find((item) => item.purpose === purpose)!;
    return {
      id: id(),
      text: template.text,
      language: template.language as 'zh-CN',
      enabled: purpose !== 'transition',
      locked: false,
      templateId: template.id,
      textSource: 'template',
      enabledSource: 'preset',
    };
  };
  const gameData: WordBeatData = {
    preset,
    bpm: presetValue(PRESETS[preset].bpm),
    targetDurationMs: 300_000,
    soundMode: options.soundMode ?? 'voiced',
    displayMode: 'blocks',
    showMeaning: true,
    progression: options.progression ?? 'auto',
    loop: false,
    resumePreparationBeats: 0,
    beatEnabled: true,
    volumes: { voice: 1, beat: 0.2, music: 0.15 },
    music: { enabled: false, loop: true },
    voices: { englishRate: 1, chineseRate: 1 },
    segments: [],
    slogans: {
      opening: slogan('opening'),
      transition: slogan('transition'),
      closing: slogan('closing'),
    },
    ruleVersion: 1,
    templateVersion: 1,
    seed: options.seed ?? newRandomSeed(),
  };
  const words = entries.map((entry) => createWordBeatEntry(entry, preset, id));
  for (let start = 0; start < words.length; start += 10) {
    gameData.segments.push({
      id: id(),
      name: `第 ${gameData.segments.length + 1} 组`,
      entries: words.slice(start, start + 10),
    });
  }
  if (!gameData.segments.length) gameData.segments.push({ id: id(), name: '第 1 组', entries: [] });
  return {
    id: id(),
    name: options.name ?? `单词节拍_${date}`,
    gameId: 'word-beat',
    revision: 0,
    dataVersion: 1,
    gameData,
    createdAt: now,
    updatedAt: now,
  };
}

/** 按当前教学副本展开词条，保留段落与出现顺序。 */
export function getEntries(lesson: WordBeatLesson): WordBeatEntry[] {
  return lesson.gameData.segments.flatMap((segment) => segment.entries);
}

/**
 * 判断口号文本是否属于教师编辑。明确手改后即使改回模板原句仍保护；
 * 旧版本没有来源字段时仅用当时模板的一致性识别，未知模板保守保留。
 * @param slogan 当前课件保存的口号，不修改原对象。
 * @returns true 表示默认智能改编不得替换该文本。
 */
export function isSloganManual(slogan: WordBeatSlogan): boolean {
  const template = templates.templates.find((item) => item.id === slogan.templateId);
  return (
    slogan.textSource === 'manual' ||
    !template ||
    template.text !== slogan.text ||
    template.language !== slogan.language
  );
}

/** 展开明确允许的占位符；扩展后才按60个Unicode码点限制。 */
export function resolveSloganText(lesson: WordBeatLesson, slogan: WordBeatSlogan): string {
  return slogan.text.replace(/\{\{([^{}]+)\}\}/gu, (_match, field: string) => {
    if (field === 'lessonName') return lesson.name;
    if (field === 'wordCount') return String(getEntries(lesson).length);
    throw new Error(`不支持的口号占位符：${field}`);
  });
}

/** 当前系统声音参数，与录音来源无关；口号依自身语言选择音色。 */
export function getVoiceSettings(
  lesson: WordBeatLesson,
  language: 'en-US' | 'zh-CN',
  overrides?: VoiceOverrides,
) {
  const voices = lesson.gameData.voices;
  const defaults =
    language === 'en-US'
      ? { voiceId: voices.englishVoiceId, rate: voices.englishRate }
      : { voiceId: voices.chineseVoiceId, rate: voices.chineseRate };
  return {
    voiceId: overrides?.voiceId ?? defaults.voiceId,
    rate: overrides?.rate ?? defaults.rate,
  };
}

/** 判断声音与当前文本/合成参数是否匹配，大小写变化不可复用旧声音。 */
export function audioMatches(
  binding: AudioBinding | undefined,
  text: string,
  voiceId?: string,
  rate = 1,
): boolean {
  if (
    !binding ||
    binding.status !== 'ready' ||
    !binding.assetId ||
    normalizeSpeechText(binding.text) !== normalizeSpeechText(text)
  )
    return false;
  return binding.source === 'recording' || (binding.voiceId === voiceId && binding.rate === rate);
}

/** 获取当前真正启用的声音对象；空段的转场口号不会产生无用途任务。 */
function voiceObjects(lesson: WordBeatLesson, allowInvalidDraft = false) {
  const entries =
    lesson.gameData.soundMode === 'voiced'
      ? getEntries(lesson).map((entry) => ({
          object: entry,
          text: entry.english,
          language: 'en-US' as const,
        }))
      : [];
  const nonEmpty = lesson.gameData.segments.filter((segment) => segment.entries.length);
  const slogans = Object.entries(lesson.gameData.slogans)
    .filter(([kind, slogan]) => slogan.enabled && (kind !== 'transition' || nonEmpty.length > 1))
    .map(([, slogan]) => ({
      object: slogan,
      text: (() => {
        try {
          return resolveSloganText(lesson, slogan);
        } catch (error) {
          // 草稿的无效占位符必须保留，不能使逐字编辑或保存中断。
          // 严格检查/制作仍抛出该错误，原始文本只用于保留素材依赖。
          if (allowInvalidDraft) return null;
          throw error;
        }
      })(),
      language: slogan.language,
    }));
  return [...entries, ...slogans];
}

/** 尚未就绪的真实合成需求；匹配录音与缓存不重复制作。 */
export function getAudioRequests(lesson: WordBeatLesson, assets: AssetMap): AudioRequest[] {
  return voiceObjects(lesson, true).flatMap(({ object, text, language }) => {
    if (text === null) return [];
    // 逐项保留草稿错误，但非法文本永远不送去合成；其他合法项仍可制作。
    if (
      !text.trim() ||
      /[\u0000-\u001f\u007f]/u.test(text) ||
      [...('english' in object ? text.trim() : text)].length > ('english' in object ? 120 : 60) ||
      (!('english' in object) && /\{\{|\}\}/u.test(text))
    )
      return [];
    const settings = getVoiceSettings(
      lesson,
      language,
      'english' in object ? object.voiceOverrides : undefined,
    );
    if (!Number.isFinite(settings.rate) || settings.rate < 0.75 || settings.rate > 1.25) return [];
    if (
      audioMatches(object.audio, text, settings.voiceId, settings.rate) &&
      object.audio?.language === language &&
      assets[object.audio!.assetId!]
    )
      return [];
    // 手工录音失效后必须由教师明确改用系统配音，不能悄悄换来源。
    if (object.audio?.source === 'recording') return [];
    return [
      {
        requestId: `${lesson.id}:${lesson.revision}:${object.id}`,
        objectId: object.id,
        text: normalizeSpeechText(text),
        language,
        ...settings,
      },
    ];
  });
}

/**
 * 以本次制作固定输入统计声音，不能把教师后续编辑或其他任务混入成果。
 * 系统需求按实际合成参数归并；录音按明确素材引用归并，不能按同词任意换绑。
 * @param input 本次制作固定的单词节拍快照，非持续变化的编辑对象。
 * @param initialAssets 制作启动时已登记的素材副本，用于判断已有声音复用。
 * @param successes 同一任务已实际成功的声音结果；缺省表示尚无完成产物。
 * @returns 唯一需求总量及新制作、复用、未完成数量。
 */
export function getAudioProductionSummary(
  input: WordBeatLesson,
  initialAssets: AssetMap,
  successes: AudioProductionSuccess[] = [],
): AudioProductionSummary {
  const requirements = voiceObjects(input, true).map(({ object, text, language }) => {
    const settings = getVoiceSettings(
      input,
      language,
      'english' in object ? object.voiceOverrides : undefined,
    );
    const recording = object.audio?.source === 'recording';
    return {
      key: JSON.stringify(
        recording
          ? [
              'recording',
              object.audio?.assetId ?? object.id,
              normalizeSpeechText(text ?? ''),
              language,
            ]
          : ['system', normalizeSpeechText(text ?? ''), language, settings.voiceId, settings.rate],
      ),
      objectId: object.id,
      ready:
        text !== null &&
        audioMatches(object.audio, text, settings.voiceId, settings.rate) &&
        object.audio?.language === language &&
        !!initialAssets[object.audio.assetId!],
    };
  });
  return summarizeAudioProduction(requirements, successes);
}

/** 绑定合成结果前再次比较任务文本及当前设置，拒绝旧任务覆盖新编辑。 */
export function bindAudio(
  lesson: WordBeatLesson,
  objectId: string,
  asset: AudioAsset,
  request: AudioRequest,
): WordBeatLesson {
  const result = structuredClone(lesson);
  const item = voiceObjects(result, true).find(({ object }) => object.id === objectId);
  if (
    !item ||
    item.text === null ||
    normalizeSpeechText(item.text) !== normalizeSpeechText(request.text)
  )
    throw new Error('内容已变化，请基于当前内容重新制作。');
  if (request.language !== item.language || request.objectId !== objectId)
    throw new Error('声音任务与当前对象或语言不匹配。');
  // 任务启动后教师可能明确导入了录音；旧合成结果即使文本相同也不能换掉新来源。
  // 改回系统配音须先由编辑器明确解除录音绑定，再创建新的制作请求。
  if (item.object.audio?.source === 'recording')
    throw new Error('当前已使用教师录音，请明确改用系统配音后重新制作。');
  const current = getVoiceSettings(
    result,
    item.language,
    'english' in item.object ? item.object.voiceOverrides : undefined,
  );
  if (current.voiceId !== request.voiceId || current.rate !== request.rate)
    throw new Error('声音设置已变化，请重新制作。');
  if (
    !(asset.durationMs > 0) ||
    !(asset.byteLength > 0) ||
    !Number.isFinite(asset.durationMs) ||
    !Number.isFinite(asset.byteLength)
  )
    throw new Error('声音为空或时长无效。');
  item.object.audio = {
    source: 'system',
    assetId: asset.assetId,
    text: request.text,
    language: request.language,
    voiceId: request.voiceId,
    rate: request.rate,
    status: 'ready',
    generatorVersion: 1,
  };
  return result;
}

/** 明确绑定教师录音；不进行语音识别，也不推断其他同词录音。 */
export function bindRecording(
  lesson: WordBeatLesson,
  objectId: string,
  asset: AudioAsset,
): WordBeatLesson {
  const result = structuredClone(lesson);
  const entry = getEntries(result).find((item) => item.id === objectId);
  const slogan = Object.values(result.gameData.slogans).find((item) => item.id === objectId);
  const item = entry ?? slogan;
  if (
    !item ||
    !(asset.durationMs > 0) ||
    !Number.isFinite(asset.durationMs) ||
    !(asset.byteLength > 0) ||
    !Number.isFinite(asset.byteLength) ||
    asset.durationMs > 30_000 ||
    asset.byteLength > 20_000_000
  )
    throw new Error('录音对象或文件不符合要求。');
  const text = entry ? entry.english : resolveSloganText(result, slogan!);
  if (
    !text.trim() ||
    /[\u0000-\u001f\u007f]/u.test(text) ||
    [...text.trim()].length > (entry ? 120 : 60) ||
    (!entry && /\{\{|\}\}/u.test(text))
  )
    throw new Error('请先修正录音对应的文本，再导入录音。');
  item.audio = {
    source: 'recording',
    assetId: asset.assetId,
    text: normalizeSpeechText(text),
    language: slogan?.language ?? 'en-US',
    rate: 1,
    status: 'ready',
  };
  return result;
}

/** 将实际依赖变化标为过期；保留旧引用，撤销后仍能重新匹配。 */
export function refreshAudioDependencies(lesson: WordBeatLesson): WordBeatLesson {
  const result = structuredClone(lesson);
  for (const { object, text, language } of voiceObjects(result, true)) {
    const settings = getVoiceSettings(
      result,
      language,
      'english' in object ? object.voiceOverrides : undefined,
    );
    if (object.audio) {
      const matched =
        text !== null &&
        normalizeSpeechText(object.audio.text) === normalizeSpeechText(text) &&
        object.audio.language === language &&
        (object.audio.source === 'recording' ||
          (object.audio.voiceId === settings.voiceId && object.audio.rate === settings.rate));
      object.audio.status = matched && object.audio.assetId ? 'ready' : 'stale';
    }
  }
  return result;
}

/** 切预设只修改由预设管理且未锁定的值，教师手动值继续保留。 */
export function applyPreset(lesson: WordBeatLesson, preset: PresetId): WordBeatLesson {
  const result = structuredClone(lesson);
  result.gameData.preset = preset;
  const bpm = result.gameData.bpm;
  if (!bpm.locked && bpm.source === 'preset') bpm.value = PRESETS[preset].bpm;
  for (const entry of getEntries(result)) {
    if (!entry.rounds.locked && entry.rounds.source === 'preset')
      entry.rounds.value = entry.priority
        ? PRESETS[preset].priorityRounds
        : PRESETS[preset].normalRounds;
    if (!entry.follow.locked && entry.follow.mode === 'preset') entry.follow.preset = preset;
    if (!entry.modelBeats.locked && entry.modelBeats.source === 'preset')
      entry.modelBeats.value = entry.entryType === 'phrase' ? 3 : 2;
  }
  return result;
}

/** 重点仅影响预设管理的轮数，不能覆盖手工练习安排。 */
export function setEntryPriority(
  lesson: WordBeatLesson,
  entryId: string,
  priority: boolean,
): WordBeatLesson {
  const result = structuredClone(lesson);
  const entry = getEntries(result).find((item) => item.id === entryId);
  if (!entry) throw new Error('词条不存在。');
  entry.priority = priority;
  if (!entry.rounds.locked && entry.rounds.source === 'preset')
    entry.rounds.value = priority
      ? PRESETS[result.gameData.preset].priorityRounds
      : PRESETS[result.gameData.preset].normalRounds;
  return result;
}

/**
 * 更改教学类型时只联动仍由规则管理的文字示范空间，保留手动及锁定拍数。
 * source 用于区分教师指定和词表自动识别；不改变其他练习、声音或词序。
 */
export function setEntryType(
  lesson: WordBeatLesson,
  entryId: string,
  entryType: 'word' | 'phrase',
  source: 'preset' | 'manual' = 'manual',
): WordBeatLesson {
  const result = structuredClone(lesson);
  const entry = getEntries(result).find((item) => item.id === entryId);
  if (!entry) throw new Error('词条不存在。');
  entry.entryType = entryType;
  entry.entryTypeSource = source;
  if (!entry.modelBeats.locked && entry.modelBeats.source === 'preset')
    entry.modelBeats.value = entryType === 'phrase' ? 3 : 2;
  return result;
}

/** 当前模式所需资源引用；关闭资源不打包，转场不存在时不要求其声音。 */
export function requiredAssets(lesson: WordBeatLesson): string[] {
  const ids = voiceObjects(lesson, true)
    .map(({ object }) => object.audio?.assetId)
    .filter((id): id is string => Boolean(id));
  if (lesson.gameData.music.enabled && lesson.gameData.music.assetId)
    ids.push(lesson.gameData.music.assetId);
  return [...new Set(ids)];
}

/** 同一素材也用于语音时优先语音预算，防止把超限示范伪装为背景音乐绕过检查。 */
export function getWordBeatAssetRole(lesson: WordBeatLesson, assetId: string): 'speech' | 'music' {
  if (voiceObjects(lesson, true).some(({ object }) => object.audio?.assetId === assetId))
    return 'speech';
  if (lesson.gameData.music.enabled && lesson.gameData.music.assetId === assetId) return 'music';
  throw new Error('此素材不属于当前课件启用的声音。');
}

/** 按规则取得真实示范和跟读拍数；不将非法值夹到允许范围。 */
export function getEntryTiming(lesson: WordBeatLesson, entry: WordBeatEntry, assets: AssetMap) {
  const data = lesson.gameData;
  const beatMs = 60_000 / data.bpm.value;
  if (data.soundMode === 'chorus') {
    const chorusBeats = entry.chorus?.beats.value ?? 4;
    return {
      beatMs,
      modelBeats: 0,
      followBeats: 0,
      chorusBeats,
      roundMs: chorusBeats * beatMs,
      durationMs: entry.rounds.value * chorusBeats * beatMs,
    };
  }
  const duration = entry.audio?.assetId ? assets[entry.audio.assetId]?.durationMs : undefined;
  const modelBeats =
    data.soundMode === 'teacher'
      ? entry.modelBeats.value
      : duration === undefined
        ? NaN
        : Math.ceil((duration + 150) / beatMs);
  const preset = PRESETS[entry.follow.preset ?? data.preset];
  const followBeats =
    entry.follow.mode === 'manual'
      ? entry.follow.beats
      : preset
        ? modelBeats + preset.followExtra + (entry.entryType === 'phrase' ? 1 : 0)
        : NaN;
  return {
    beatMs,
    modelBeats,
    followBeats,
    roundMs: (modelBeats + followBeats) * beatMs,
    durationMs: entry.rounds.value * (modelBeats + followBeats) * beatMs,
  };
}

/** 所有入口共用的完整检查；缺释义只提醒，缺启用声音则阻止运行。 */
export function validateWordBeat(lesson: WordBeatLesson, assets: AssetMap): ValidationIssue[] {
  const structureIssues = validateWordBeatStructure(lesson);
  if (structureIssues.length) return structureIssues;
  const issues: ValidationIssue[] = [];
  const add = (
    code: string,
    message: string,
    objectId?: string,
    field?: string,
    kind: ValidationIssue['kind'] = 'invalid',
    severity: ValidationIssue['severity'] = 'error',
  ) => issues.push({ code, message, objectId, field, kind, severity });
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  const data = lesson.gameData;
  if (
    !lesson.name.trim() ||
    [...lesson.name.trim()].length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(lesson.name)
  )
    add('NAME_INVALID', '课件名需为1～80个字符。', lesson.id, 'name');
  if (lesson.dataVersion !== 1 || data.ruleVersion !== 1 || data.templateVersion !== 1)
    add('UNSUPPORTED_VERSION', '当前课件版本不受支持，不能静默换用其他规则。');
  for (const [field, input] of Object.entries(lesson.draftInputs ?? {})) {
    // 隐藏模式参数保留原始输入，只有实际使用的字段阻止运行。
    if (data.soundMode === 'chorus' && /\.(model|follow)$/.test(field)) continue;
    if (
      data.soundMode !== 'chorus' &&
      (/\.(chorusBeats|chorusPerRead)$/.test(field) ||
        field === 'chorusGapBeats' ||
        field.startsWith('musicSync.'))
    )
      continue;
    if (field.startsWith('musicSync.') && (!data.music.enabled || !data.music.syncEnabled))
      continue;
    if (
      field === 'musicRate' &&
      (!data.music.enabled || (data.soundMode === 'chorus' && data.music.syncEnabled))
    )
      continue;
    add('DRAFT_INVALID', input.message, input.objectId, field);
  }
  if (!PRESETS[data.preset]) {
    add('PRESET_INVALID', '练习预设无效。');
    return issues;
  }
  if (!Number.isFinite(data.bpm.value) || data.bpm.value < 50 || data.bpm.value > 180)
    add('BPM_INVALID', '节奏需为50～180 BPM。', lesson.id, 'bpm');
  if (
    !Number.isFinite(data.targetDurationMs) ||
    data.targetDurationMs < 60_000 ||
    data.targetDurationMs > 1_800_000
  )
    add('TARGET_INVALID', '目标时长需为1～30分钟。', lesson.id, 'targetDurationMs');
  if (!integer(data.seed, 1, 0xffffffff)) add('SEED_INVALID', '随机选择标记无效。');
  if (
    !['voiced', 'teacher', 'chorus'].includes(data.soundMode) ||
    !['centered', 'blocks'].includes(data.displayMode) ||
    !['auto', 'step'].includes(data.progression)
  )
    add('MODE_INVALID', '课堂模式无效。');
  for (const [field, rate] of [
    ['englishRate', data.voices.englishRate],
    ['chineseRate', data.voices.chineseRate],
  ] as const) {
    const language = field === 'englishRate' ? 'en-US' : 'zh-CN';
    if (
      !(field === 'englishRate' && data.soundMode === 'voiced') &&
      !Object.values(data.slogans).some((slogan) => slogan.enabled && slogan.language === language)
    )
      continue;
    if (!Number.isFinite(rate) || rate < 0.75 || rate > 1.25)
      add('RATE_INVALID', '语速需为0.75～1.25倍。', lesson.id, field);
  }
  for (const volume of Object.values(data.volumes))
    if (!Number.isFinite(volume) || volume < 0 || volume > 1)
      add('VOLUME_INVALID', '音量需在0～100%之间。');
  if (data.soundMode === 'chorus' && !integer(data.chorusGapBeats ?? 0, 0, 4))
    add('CHORUS_GAP_INVALID', '词间间隔需为0～4拍。', lesson.id, 'chorusGapBeats');
  const sync =
    data.soundMode === 'chorus' && data.music.enabled && data.music.syncEnabled
      ? data.music.sync
      : undefined;
  if (data.music.enabled) {
    const rate = sync ? data.bpm.value / sync.bpm : (data.music.playbackRate ?? 1);
    if (!Number.isFinite(rate) || rate < 0.75 || rate > 1.25)
      add(
        'MUSIC_RATE_INVALID',
        '音乐变速需为0.75～1.25倍；对拍时目标课堂BPM须在原始音乐BPM的该范围内。',
        lesson.id,
        'music',
      );
    if (sync) {
      const duration = assets[data.music.assetId ?? '']?.durationMs ?? 0;
      if (((duration / 1000) * 48000 * 8) / rate > DECODED_AUDIO_BUDGET)
        add(
          'MUSIC_RATE_BUDGET',
          '变速后音乐超过64 MB解码预算，请使用较短音乐或提高倍率。',
          lesson.id,
          'music',
        );
    }
  }
  if (data.soundMode === 'chorus' && data.music.enabled && data.music.syncEnabled && !sync)
    add('MUSIC_SYNC_INVALID', '请先设置音乐节拍校准。', lesson.id, 'music');
  if (sync) {
    const duration = assets[data.music.assetId ?? '']?.durationMs ?? 0;
    const beatMs = 60000 / sync.bpm;
    if (Math.ceil((duration / 1000) * 48000) * 8 > DECODED_AUDIO_BUDGET)
      add(
        'MUSIC_SYNC_BUDGET',
        '对拍音乐解码预算超过64 MB，请使用较短音乐或普通伴奏。',
        lesson.id,
        'music',
      );
    if (!data.music.loop) {
      const longest =
        Math.max(
          0,
          ...data.segments.map(
            (segment) =>
              segment.entries.reduce(
                (sum, entry) => sum + (entry.chorus?.beats.value ?? 4) * entry.rounds.value,
                0,
              ) +
              Math.max(0, segment.entries.length - 1) * (data.chorusGapBeats ?? 0),
          ),
        ) * beatMs;
      if (sync.firstBeatMs + longest > duration)
        add(
          'MUSIC_SYNC_SHORT',
          '音乐不足以覆盖完整段落，请设置整拍循环或换用更长音乐。',
          lesson.id,
          'music',
        );
    }
    const aligned = (ms: number) => Math.abs(ms / beatMs - Math.round(ms / beatMs)) < 0.0001;
    if (
      sync.bpm < 50 ||
      sync.bpm > 180 ||
      sync.firstBeatMs < 0 ||
      sync.firstBeatMs >= duration ||
      (data.music.loop &&
        (sync.loopStartMs < sync.firstBeatMs ||
          sync.loopEndMs > duration ||
          sync.loopEndMs <= sync.loopStartMs ||
          !aligned(sync.loopStartMs - sync.firstBeatMs) ||
          !aligned(sync.loopEndMs - sync.firstBeatMs)))
    )
      add(
        'MUSIC_SYNC_INVALID',
        '请校准原始音乐BPM、首拍和整拍循环区间；变速倍率由目标课堂BPM计算。',
        lesson.id,
        'music',
      );
  }
  const entries = getEntries(lesson);
  if (entries.length < 1 || entries.length > 100)
    add('ENTRY_COUNT_INVALID', '每课需有1～100条词语；空段不会进入课堂。', lesson.id, 'entries');
  const uniqueIds = new Set<string>();
  for (const entry of entries) {
    // 材料属性也是可携带内容的一部分；与导入/常用词共用边界，不能借草稿绕过发布检查。
    for (const issue of validateTeachingEntry(entry)) {
      if (
        issue.severity === 'error' &&
        ['partOfSpeech', 'unit', 'tags'].includes(issue.field ?? '')
      )
        add(issue.code, issue.message, entry.id, issue.field);
    }
    if (uniqueIds.has(entry.id)) add('DUPLICATE_ID', '词条标识重复，每个位置须独立。', entry.id);
    else uniqueIds.add(entry.id);
    if (
      !entry.english.trim() ||
      [...entry.english.trim()].length > 120 ||
      /[\u0000-\u001f\u007f]/u.test(entry.english)
    )
      add('ENGLISH_INVALID', '英文需为1～120个字符，不能含控制字符。', entry.id, 'english');
    if ([...entry.meaning.trim()].length > 200 || /[\u0000-\u001f\u007f]/u.test(entry.meaning))
      add('MEANING_INVALID', '释义不能超过200个字符或含控制字符。', entry.id, 'meaning');
    if (!entry.meaning.trim())
      add(
        'MEANING_EMPTY',
        '可补充教学释义，也可仅练习英文。',
        entry.id,
        'meaning',
        'invalid',
        'warning',
      );
    if (!integer(entry.rounds.value, 1, 8))
      add('ROUNDS_INVALID', '练习轮数需为1～8轮。', entry.id, 'rounds');
    if (data.soundMode !== 'chorus' && !integer(entry.modelBeats.value, 1, 32))
      add('MODEL_BEATS_INVALID', '教师示范需为1～32拍。', entry.id, 'modelBeats');
    if (
      data.soundMode !== 'chorus' &&
      entry.follow.mode === 'manual' &&
      !integer(entry.follow.beats, 1, 32)
    )
      add('FOLLOW_INVALID', '跟读需为1～32拍。', entry.id, 'follow');
    if (
      data.soundMode !== 'chorus' &&
      (!['manual', 'preset'].includes(entry.follow.mode) ||
        (entry.follow.preset && !PRESETS[entry.follow.preset]))
    )
      add('FOLLOW_INVALID', '跟读公式无效。', entry.id, 'follow');
    if (!['word', 'phrase'].includes(entry.entryType))
      add('ENTRY_TYPE_INVALID', '请选择单词或短语。', entry.id, 'entryType');
    if (
      data.soundMode === 'voiced' &&
      entry.voiceOverrides?.rate !== undefined &&
      (!Number.isFinite(entry.voiceOverrides.rate) ||
        entry.voiceOverrides.rate < 0.75 ||
        entry.voiceOverrides.rate > 1.25)
    )
      add('RATE_INVALID', '条目语速需为0.75～1.25倍。', entry.id, 'voiceOverrides.rate');
    if (
      data.soundMode === 'voiced' &&
      entry.voiceOverrides?.voiceId !== undefined &&
      !entry.voiceOverrides.voiceId.trim()
    )
      add(
        'VOICE_INVALID',
        '条目音色不能为空；继承本课默认请清除覆盖值。',
        entry.id,
        'voiceOverrides.voiceId',
      );
    if (data.soundMode === 'chorus') {
      const beats = entry.chorus?.beats.value ?? 4;
      const perRead = entry.chorus?.beatsPerRead.value ?? 1;
      if (!integer(beats, 1, 32) || ![1, 2].includes(perRead) || beats % perRead !== 0)
        add(
          'CHORUS_BEATS_INVALID',
          '每轮需为1～32拍，每次占1或2拍，总拍数必须能整除每次占用拍数。',
          entry.id,
          'chorus',
        );
    }
    const timing = getEntryTiming(lesson, entry, assets);
    if (
      data.soundMode !== 'chorus' &&
      Number.isFinite(timing.followBeats) &&
      !integer(timing.followBeats, 1, 32)
    )
      add('FOLLOW_OVERFLOW', '跟读超过32拍，请调整声音、内容或手动跟读拍数。', entry.id, 'follow');
  }
  try {
    for (const { object, text, language } of voiceObjects(lesson, true)) {
      if (text === null) {
        add(
          'SLOGAN_INVALID',
          '口号占位符无效，仅支持{{lessonName}}与{{wordCount}}。',
          object.id,
          'text',
        );
        continue;
      }
      if (
        !text.trim() ||
        (!('english' in object) &&
          ([...text].length > 60 || /\{\{|\}\}/u.test(text) || /[\u0000-\u001f\u007f]/u.test(text)))
      )
        add('SLOGAN_INVALID', '口号需为展开后1～60个字符，且占位符有效。', object.id, 'text');
      const binding = object.audio;
      const settings = getVoiceSettings(
        lesson,
        language,
        'english' in object ? object.voiceOverrides : undefined,
      );
      if (!binding?.assetId) {
        add(
          'SOUND_PENDING',
          '声音待制作，或导入录音 / 明确关闭该声音。',
          object.id,
          'audio',
          'missing',
        );
        continue;
      }
      const asset = assets[binding.assetId];
      if (
        !asset ||
        asset.durationMs <= 0 ||
        asset.byteLength <= 0 ||
        !Number.isFinite(asset.durationMs) ||
        !Number.isFinite(asset.byteLength) ||
        !asset.mimeType.startsWith('audio/')
      ) {
        add('ASSET_INVALID', '已引用声音丢失或无效，请修复。', object.id, 'audio', 'asset');
        continue;
      }
      if (
        !audioMatches(binding, text, settings.voiceId, settings.rate) ||
        binding.language !== language
      )
        add('SOUND_STALE', '声音与当前内容 / 设置不同，需要更新。', object.id, 'audio', 'stale');
      if (
        asset.frameCount !== undefined &&
        asset.channels !== undefined &&
        (!Number.isSafeInteger(asset.frameCount) ||
          !Number.isSafeInteger(asset.channels) ||
          asset.frameCount <= 0 ||
          asset.channels <= 0 ||
          asset.frameCount * asset.channels * 4 > DECODED_AUDIO_BUDGET)
      )
        add(
          'SOUND_DECODE_BUDGET',
          '此声音解码后超过64 MB或采样信息无效，请换用较小音频。',
          object.id,
          'audio',
          'asset',
        );
    }
  } catch (error) {
    add(
      'SLOGAN_INVALID',
      error instanceof Error ? error.message : '口号占位符无效。',
      lesson.id,
      'slogans',
    );
  }
  if (data.music.enabled) {
    const music = data.music.assetId ? assets[data.music.assetId] : undefined;
    if (
      !music ||
      !Number.isFinite(music.durationMs) ||
      !Number.isFinite(music.byteLength) ||
      music.durationMs <= 0 ||
      music.byteLength <= 0 ||
      music.durationMs > 600_000 ||
      music.byteLength > 50_000_000 ||
      !music.mimeType.startsWith('audio/')
    )
      add(
        'MUSIC_INVALID',
        '启用音乐需为有效的10分钟 / 50 MB以内音频。',
        lesson.id,
        'music',
        'asset',
      );
  }
  return issues;
}

/** 编排拒绝任何当前错误；使用真实时长向上取整，空段不产生准备或口号。 */
export function compileWordBeat(lesson: WordBeatLesson, assets: AssetMap): WordBeatPlan {
  const errors = validateWordBeat(lesson, assets).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join('\n'));
  const data = lesson.gameData;
  const beatMs = 60_000 / data.bpm.value;
  const cues: RuntimeCue<WordBeatCueData>[] = [];
  const items: WordBeatPlan['items'] = [];
  let position = 0;
  const segments = data.segments.filter((segment) => segment.entries.length);
  const push = (
    kind: string,
    durationMs: number,
    itemIndex: number | null,
    sectionIndex: number | null,
    payload: WordBeatCueData,
    audioAssetId?: string,
    round?: number,
  ) => {
    cues.push({
      id: `${kind}:${cues.length}`,
      kind,
      startMs: position,
      durationMs,
      itemIndex,
      sectionIndex,
      round,
      audioAssetId,
      pulseIntervalMs: beatMs,
      navigation: { previous: null, next: null, repeat: null },
      data: payload,
    });
    position += durationMs;
  };
  const slogan = (kind: 'opening' | 'transition' | 'closing', sectionIndex: number | null) => {
    const item = data.slogans[kind];
    if (!item.enabled) return;
    const assetId = item.audio!.assetId!;
    push(
      kind,
      Math.ceil((assets[assetId].durationMs + 150) / beatMs) * beatMs,
      null,
      sectionIndex,
      { label: '口号', english: resolveSloganText(lesson, item), meaning: '' },
      assetId,
    );
  };
  slogan('opening', 0);
  segments.forEach((segment, sectionIndex) => {
    if (sectionIndex > 0) slogan('transition', sectionIndex);
    push('preparation', (sectionIndex === 0 ? 4 : 2) * beatMs, null, sectionIndex, {
      label: '准备',
      english: segment.name,
      meaning: '',
      segmentName: segment.name,
    });
    segment.entries.forEach((entry, entryIndex) => {
      const index = items.length;
      const timing = getEntryTiming(lesson, entry, assets);
      const firstCue = cues.length;
      for (let round = 1; round <= entry.rounds.value; round += 1) {
        const payload = {
          english: entry.english,
          meaning: entry.meaning,
          entryId: entry.id,
          segmentName: segment.name,
          roundCount: entry.rounds.value,
        };
        if (data.soundMode === 'chorus') {
          push(
            'chorus',
            timing.roundMs,
            index,
            sectionIndex,
            {
              ...payload,
              label: '自主齐读',
              totalBeats: entry.chorus?.beats.value ?? 4,
              beatsPerRead: entry.chorus?.beatsPerRead.value ?? 1,
            },
            undefined,
            round,
          );
          continue;
        }
        push(
          'model',
          timing.modelBeats * beatMs,
          index,
          sectionIndex,
          { ...payload, label: data.soundMode === 'teacher' ? '教师示范' : '示范' },
          data.soundMode === 'voiced' ? entry.audio!.assetId : undefined,
          round,
        );
        push(
          'follow',
          timing.followBeats * beatMs,
          index,
          sectionIndex,
          { ...payload, label: '跟读' },
          undefined,
          round,
        );
      }
      items.push({ id: entry.id, sectionIndex, firstCue, lastCue: cues.length - 1 });
      const gap = data.soundMode === 'chorus' ? (data.chorusGapBeats ?? 0) : 1;
      if (entryIndex < segment.entries.length - 1 && gap > 0)
        push('transition', gap * beatMs, null, sectionIndex, {
          label: '转场',
          english: '',
          meaning: '',
          segmentName: segment.name,
        });
    });
  });
  slogan('closing', segments.length - 1);
  if (
    data.soundMode === 'chorus' &&
    data.music.enabled &&
    data.music.syncEnabled &&
    data.music.sync
  ) {
    let section: number | null = null;
    let origin = 0;
    for (const cue of cues) {
      if (cue.kind === 'preparation') {
        // 准备阶段预排首个音乐采样，第一拍不受下一次画面帧到达时间影响。
        cue.musicPositionMs = -cue.durationMs;
      } else if (cue.kind === 'chorus') {
        if (section !== cue.sectionIndex) {
          section = cue.sectionIndex;
          origin = cue.startMs;
        }
        cue.musicPositionMs = cue.startMs - origin;
      } else if (cue.kind === 'transition' && !cue.audioAssetId && section === cue.sectionIndex) {
        cue.musicPositionMs = cue.startMs - origin;
      }
    }
  }
  cues.forEach((cue, index) => {
    if (cue.itemIndex !== null) {
      cue.navigation = {
        previous: cue.itemIndex > 0 ? cue.itemIndex - 1 : null,
        next: cue.itemIndex < items.length - 1 ? cue.itemIndex + 1 : null,
        repeat: cue.itemIndex,
      };
    } else if (cue.kind === 'opening' || (cue.kind === 'preparation' && cue.sectionIndex === 0)) {
      cue.navigation = { previous: null, next: 0, repeat: null };
    } else if (cue.kind === 'closing') {
      cue.navigation = { previous: items.length - 1, next: null, repeat: null };
    } else {
      let before = -1;
      items.forEach((item, itemIndex) => {
        if (item.lastCue < index) before = itemIndex;
      });
      const after = items.findIndex((item) => item.firstCue > index);
      cue.navigation = {
        previous: before < 0 ? null : before,
        next: after < 0 ? null : after,
        repeat: null,
      };
    }
  });
  return {
    cues,
    items,
    durationMs: position,
    resumeCue:
      data.resumePreparationBeats === 2
        ? {
            id: 'resume-preparation',
            kind: 'resume-preparation',
            startMs: 0,
            durationMs: 2 * beatMs,
            itemIndex: null,
            sectionIndex: null,
            pulseIntervalMs: beatMs,
            navigation: { previous: null, next: null, repeat: null },
            data: { label: '恢复准备', english: '跟上节拍', meaning: '' },
          }
        : undefined,
    bpm: data.bpm.value,
    lessonId: lesson.id,
    lessonRevision: lesson.revision,
    assetIds: requiredAssets(lesson),
  };
}

/** 当前内容聚合状态；多个问题仍保留在完整问题面板。 */
export function getPreparationState(
  lesson: WordBeatLesson,
  assets: AssetMap,
): 'draft' | 'pending' | 'stale' | 'repair' | 'ready' {
  const errors = validateWordBeat(lesson, assets).filter((issue) => issue.severity === 'error');
  if (errors.some((issue) => issue.kind === 'invalid' || issue.kind === 'asset')) return 'repair';
  if (errors.some((issue) => issue.kind === 'stale')) return 'stale';
  if (errors.length) return 'pending';
  return lesson.preparedRevision === lesson.revision ? 'ready' : 'draft';
}
