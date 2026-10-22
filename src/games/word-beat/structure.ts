/**
 * 单词节拍的结构门禁。与运行检查分开：未完成英文、越界数值可作为草稿
 * 恢复并修订，但错误容器、字段类型、枚举和未知版本不能进入编辑器。
 * 不转换、不截断、不替换输入；成功校验后仍使用原快照。
 * @author ahui
 */
import { z } from 'zod';
import type { ValidationIssue } from '../../platform/types';

const number = z.number().finite();
const id = z.string().min(1);
const preset = z.enum(['regular', 'focus', 'quick']);
const language = z.enum(['en-US', 'zh-CN']);
// 导入的建议同样属于外部数据；任何实际读取/写入路径都不能触及对象原型。
const safePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.split('.').some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)),
  );
const ruleValue = z.object({
  value: number,
  source: z.enum(['preset', 'manual']),
  locked: z.boolean(),
});
const audio = z.object({
  source: z.enum(['system', 'recording']),
  assetId: id.optional(),
  text: z.string(),
  language,
  voiceId: z.string().optional(),
  rate: number,
  status: z.enum(['ready', 'stale', 'missing']),
  environment: z.string().optional(),
  generatorVersion: number.optional(),
});
const suggestion = z.object({
  id,
  ruleId: id,
  inputRevision: number,
  kind: z.enum(['time', 'remix', 'preset']),
  title: z.string(),
  reason: z.string(),
  changes: z.array(
    z.object({
      path: safePath,
      before: z.unknown().optional(),
      after: z.unknown().optional(),
      objectId: id.optional(),
      reason: z.string(),
    }),
  ),
  dependencies: z.record(safePath, z.string()),
  beforeDurationMs: number.optional(),
  afterDurationMs: number.optional(),
  state: z.enum(['available', 'applied', 'ignored', 'stale']),
});
// 整理依据是可选的历史记录：旧课件不补造依据，未来正整数版本不触发重算。
// 外部包若主动提供此记录，必须完整，避免把损坏的来源信息带进后续编辑与携带。
const materialAnalysis = z.object({
  ruleId: z.literal('platform.material.match'),
  ruleVersion: number.int().positive(),
  functionWordsVersion: number.int().positive(),
  dictionaryVersions: z.array(z.object({ name: id, version: id })),
});
const entry = z.object({
  id,
  english: z.string(),
  meaning: z.string(),
  partOfSpeech: z.string().optional(),
  priority: z.boolean(),
  tags: z.array(z.string()).optional(),
  unit: z.string().optional(),
  source: z
    .object({
      name: z.string(),
      original: z.string().optional(),
      line: number.optional(),
      position: number.optional(),
      analysis: materialAnalysis.optional(),
    })
    .optional(),
  meaningSource: z
    .object({
      name: z.string(),
      version: z.string(),
      english: z.string(),
      originalMeaning: z.string().optional(),
      originalPartOfSpeech: z.string().optional(),
      teacherRevised: z.boolean().optional(),
      reviewStatus: z.enum(['reviewed-sense', 'reference']).optional(),
      candidateSource: z.enum(['dictionary', 'common']).optional(),
      acceptedFields: z
        .array(z.enum(['meaning', 'partOfSpeech']))
        .refine((fields) => new Set(fields).size === fields.length)
        .optional(),
    })
    .optional(),
  confirmed: z.boolean().optional(),
  entryType: z.enum(['word', 'phrase']),
  entryTypeSource: z.enum(['preset', 'manual']),
  rounds: ruleValue,
  follow: z.object({
    mode: z.enum(['preset', 'manual']),
    beats: number,
    locked: z.boolean(),
    preset: preset.optional(),
  }),
  modelBeats: ruleValue,
  chorus: z.object({ beats: ruleValue, beatsPerRead: ruleValue }).optional(),
  positionLocked: z.boolean(),
  soundLocked: z.boolean(),
  voiceOverrides: z.object({ voiceId: z.string().optional(), rate: number.optional() }).optional(),
  audio: audio.optional(),
});
const slogan = z.object({
  id,
  text: z.string(),
  language,
  enabled: z.boolean(),
  locked: z.boolean(),
  templateId: z.string().optional(),
  textSource: z.enum(['template', 'manual']).optional(),
  enabledSource: z.enum(['preset', 'manual']).optional(),
  audio: audio.optional(),
});
const lessonStructure = z.object({
  id,
  name: z.string(),
  gameId: z.literal('word-beat'),
  revision: number.int().nonnegative(),
  dataVersion: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  preparedRevision: number.int().nonnegative().nullable().optional(),
  sourceLesson: z.object({ id, revision: number.int().nonnegative() }).optional(),
  draftInputs: z
    .record(z.string(), z.object({ raw: z.string(), message: z.string(), objectId: id.optional() }))
    .optional(),
  gameData: z.object({
    preset,
    bpm: ruleValue,
    targetDurationMs: number,
    soundMode: z.enum(['voiced', 'teacher', 'chorus']),
    displayMode: z.enum(['centered', 'blocks']),
    showMeaning: z.boolean(),
    progression: z.enum(['auto', 'step']),
    loop: z.boolean(),
    resumePreparationBeats: z.union([z.literal(0), z.literal(2)]),
    beatEnabled: z.boolean(),
    volumes: z.object({ voice: number, beat: number, music: number }),
    chorusGapBeats: number.optional(),
    music: z.object({
      playbackRate: number.optional(),
      preservePitch: z.boolean().optional(),
      enabled: z.boolean(),
      assetId: id.optional(),
      loop: z.boolean(),
      syncEnabled: z.boolean().optional(),
      sync: z
        .object({ bpm: number, firstBeatMs: number, loopStartMs: number, loopEndMs: number })
        .optional(),
    }),
    voices: z.object({
      englishVoiceId: z.string().optional(),
      chineseVoiceId: z.string().optional(),
      englishRate: number,
      chineseRate: number,
    }),
    segments: z.array(z.object({ id, name: z.string(), entries: z.array(entry) })),
    slogans: z.object({ opening: slogan, transition: slogan, closing: slogan }),
    ruleVersion: z.literal(1),
    templateVersion: z.literal(1),
    seed: number,
    suggestionHistory: z.array(suggestion).optional(),
  }),
});

/**
 * 检查完整快照，空数组和不合法教学值仍可编辑；错误路径用于导入诊断。
 * @param value 来自包、数据库或其他恢复入口的原始快照。
 * @returns 空数组代表结构受支持；错误不会抛出或改写原数据。
 */
export function validateWordBeatStructure(value: unknown): ValidationIssue[] {
  const result = lessonStructure.safeParse(value);
  if (result.success) {
    const parsed = result.data;
    const ids = [
      parsed.id,
      ...parsed.gameData.segments.flatMap((segment) => [
        segment.id,
        ...segment.entries.map((item) => item.id),
      ]),
      ...Object.values(parsed.gameData.slogans).map((item) => item.id),
    ];
    // 词条、段落和口号共享对象定位空间，跨类型重号同样会造成错绑声音或编辑对象。
    const seen = new Set<string>();
    return ids.flatMap((objectId) => {
      if (seen.has(objectId))
        return [
          {
            code: 'DUPLICATE_ID',
            severity: 'error' as const,
            message: '课件对象标识重复，不能可靠定位编辑或声音。',
            objectId,
            kind: 'invalid' as const,
          },
        ];
      seen.add(objectId);
      return [];
    });
  }
  return result.error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    const unsupported = [
      'dataVersion',
      'gameData.ruleVersion',
      'gameData.templateVersion',
    ].includes(field);
    return {
      code: unsupported ? 'UNSUPPORTED_VERSION' : 'STRUCTURE_INVALID',
      severity: 'error',
      message: unsupported
        ? '当前课件版本不受支持，请使用兼容版本的软件打开。'
        : `课件结构不完整或字段类型错误：${field || '课件'}。`,
      field,
      kind: 'invalid',
    };
  });
}
