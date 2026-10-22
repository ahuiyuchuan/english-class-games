/** 单词节拍的新课默认值；不影响已有课件或其它游戏。 @author ahui */
import { z } from 'zod';

/** 仅给新课缺省项选择随安装包提供的音色；教师已有选择不被覆盖。 */
const preferencesSchema = z
  .object({
    englishVoiceId: z.string().trim().min(1).max(512).default('builtin:melo-zh-en-v1:en'),
    chineseVoiceId: z.string().trim().min(1).max(512).default('builtin:melo-zh-en-v1:zh'),
    englishRate: z.number().min(0.75).max(1.25).default(1),
    chineseRate: z.number().min(0.75).max(1.25).default(1),
    preset: z.enum(['regular', 'focus', 'quick']).default('regular'),
    soundMode: z.enum(['voiced', 'teacher', 'chorus']).default('voiced'),
    displayMode: z.enum(['centered', 'blocks']).default('blocks'),
    progression: z.enum(['auto', 'step']).default('auto'),
    targetDurationMs: z.number().int().min(60_000).max(1_800_000).default(300_000),
  })
  .strict();

/** 模块自己的类型，平台和后续游戏不依赖此结构。 */
export type WordBeatPreferences = z.infer<typeof preferencesSchema>;

/** 为新课件补齐缺省配置，错误必须在保存前显示，不能吞掉教师的非法输入。 */
export function validateWordBeatPreferences(value: unknown): WordBeatPreferences {
  const result = preferencesSchema.safeParse(value);
  if (!result.success) throw new Error('单词节拍的新课默认值不合法，请检查音色、语速和目标时长。');
  return result.data;
}

/** 每次返回独立默认对象，设置页编辑不能改变模块基准。 */
export function getDefaultWordBeatPreferences(): WordBeatPreferences {
  return validateWordBeatPreferences({});
}

/** 兼容旧开发版平铺配置；仅认领自己已知的教学设置。 */
export function migrateLegacyWordBeatPreferences(value: unknown): WordBeatPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const fields = Object.keys(preferencesSchema.shape);
  const known = Object.fromEntries(Object.entries(input).filter(([key]) => fields.includes(key)));
  return Object.keys(known).length ? validateWordBeatPreferences(known) : undefined;
}
