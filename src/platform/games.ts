/** 内置游戏能力注册，不根据游戏标识为平台添加业务例外。 @author ahui */
import { WordBeatClassroom } from '../games/word-beat/Classroom';
import {
  compileWordBeat,
  createWordBeatLesson,
  requiredAssets,
  getWordBeatAssetRole,
  getEntries,
  getPreparationState,
  validateWordBeat,
} from '../games/word-beat/rules';
import type { WordBeatData } from '../games/word-beat/model';
import type { WordBeatPlan } from '../games/word-beat/timeline';
import type { GameModule } from './types';
import { validateWordBeatStructure } from '../games/word-beat/structure';
import { copyLesson } from '../games/word-beat/suggestions';
import { restoreWordBeatAudioTask } from '../games/word-beat/audio-results';
import { describeWordBeatIdentities } from '../games/word-beat/identities';
import {
  getDefaultWordBeatPreferences,
  migrateLegacyWordBeatPreferences,
  validateWordBeatPreferences,
} from '../games/word-beat/preferences';

/** 当前首版只注册一个真实游戏，不创建第二游戏占位实现。 */
export const wordBeatGame: GameModule<WordBeatData, WordBeatPlan> = {
  id: 'word-beat',
  name: '单词节拍',
  description: '整理高中词汇，支持配音跟读、教师文字领读和学生自主齐读。',
  dataVersion: 1,
  moduleVersion: '1.0.0',
  minimumPlatformVersion: '1.0.0',
  materialTypes: ['vocabulary', 'reading'],
  capabilities: {
    preview: true,
    portable: true,
    navigate: true,
    repeat: true,
    tempo: true,
    display: true,
  },
  getDefaultPreferences: getDefaultWordBeatPreferences,
  validatePreferences: validateWordBeatPreferences,
  migrateLegacyPreferences: migrateLegacyWordBeatPreferences,
  validateStructure: validateWordBeatStructure,
  summarize: (lesson, assets) => {
    if (validateWordBeatStructure(lesson).length) return { preparationState: 'repair' };
    let durationMs: number | undefined;
    try {
      durationMs = compileWordBeat(lesson, assets).durationMs;
    } catch {
      /* 未就绪时省略时长，不制造零秒或估算结果。 */
    }
    return {
      itemCount: getEntries(lesson).length,
      itemLabel: '词语',
      durationMs,
      preparationState: getPreparationState(lesson, assets),
    };
  },
  copy: (lesson, options) => copyLesson(lesson, options?.name, options?.idFactory),
  describeIdentities: describeWordBeatIdentities,
  create: (entries, options) => createWordBeatLesson(entries, options),
  validate: validateWordBeat,
  compile: compileWordBeat,
  requiredAssets,
  assetRole: getWordBeatAssetRole,
  restoreAudioTask: restoreWordBeatAudioTask,
  Classroom: WordBeatClassroom,
};

/** 擦除具体游戏类型仅发生在注册边界，组件和检查仍由模块自己提供。 */
const registry = new Map<string, GameModule>([
  [wordBeatGame.id, wordBeatGame as unknown as GameModule],
]);

/** 查找已安装的内置模块；未知游戏不给单词节拍默认结构。 */
export function getGame(id: string): GameModule | undefined {
  return registry.get(id);
}

/** 返回真实已安装模块，用于游戏库及按能力显示操作。 */
export function getGames(): GameModule[] {
  return [...registry.values()];
}
