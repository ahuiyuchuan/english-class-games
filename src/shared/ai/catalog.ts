/**
 * 智能规则的稳定目录。编号表示职责，版本保存在课件修订中；界面展示通俗理由，
 * 不把内部编号作为“AI能力”的宣传文案。退役编号保留历史含义，不重复分配。
 * @author ahui
 */
export const AI_RULES = {
  material: 'platform.material.match',
  meaning: 'platform.meaning.candidate',
  preset: 'word-beat.preset',
  duration: 'word-beat.duration',
  slogan: 'word-beat.slogan',
  variant: 'word-beat.variant',
  audio: 'platform.audio.dependency',
  delivery: 'platform.delivery.check',
} as const;

/** 当前规则类别；序号/算法版本不得拼进此编号。 */
export type AiRuleId = (typeof AI_RULES)[keyof typeof AI_RULES];
