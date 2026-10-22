/**
 * 单词节拍制作适配：固定教学输入，把真实声音结果绑定回独立的条目位置。
 * 平台任务观察器不读取本游戏字段；旧成果只生成候选副本，不覆盖当前草稿。
 * @author ahui
 */
import type { TaskRecord } from '../../platform/native';
import type { AssetMap } from '../../platform/types';
import { runAudioTask } from '../../platform/production';
import type { WordBeatLesson } from './model';
import { getAudioRequests, refreshAudioDependencies } from './rules';
import { restoreWordBeatAudioTask } from './audio-results';

/** 制作与重试只绑定成功产物；卸载可停止观察，后台任务依然保留真实成果。 */
export async function produceLesson(
  input: WordBeatLesson,
  assets: AssetMap,
  onTask: (task: TaskRecord) => void,
  retryOf?: string,
  signal?: AbortSignal,
): Promise<{ lesson: WordBeatLesson; assets: AssetMap; task?: TaskRecord }> {
  const lesson = refreshAudioDependencies(structuredClone(input));
  const requests = getAudioRequests(lesson, assets);
  const task = await runAudioTask(
    requests,
    { lessonId: lesson.id, revision: lesson.revision, retryOf },
    onTask,
    signal,
  );
  if (!task) return { lesson, assets };
  return {
    ...restoreWordBeatAudioTask(lesson, assets, {
      lessonId: task.lessonId ?? lesson.id,
      inputRevision: task.inputRevision ?? lesson.revision,
      results: task.results,
    }),
    task,
  };
}

/**
 * JSON课件不依赖对象插入顺序；Rust/serde保存会重排对象键。
 * replacer逐层排序对象，数组保持教师安排的顺序；undefined仍按JSON规则省略。
 * 不在此修正非法数值或删除声音字段，非法原文仍由draftInputs参与比较。
 */
function stableProductionJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}

/**
 * 固定制作的教学输入；保存修订、准备指针和时间不属于教学变化。
 * @param lesson 当前完整草稿，含声音依赖、手动／锁定及未完成输入。
 * @returns 对象键顺序无关、数组顺序敏感的JSON指纹，不是安全摘要。
 */
export function productionFingerprint(lesson: WordBeatLesson): string {
  return stableProductionJson({
    name: lesson.name,
    data: lesson.gameData,
    inputs: lesson.draftInputs,
  });
}

/**
 * 用教学语言解释真实差异；调用方以输入快照比较教师编辑，以采用成果比较后续编辑。
 * @param before 对应制作的原输入或已采用成果；不能把未采用的自动声音绑定当作教师编辑。
 * @param current 当前教师草稿；不修改任一参数。
 * @returns 已变化的类别；空数组表示教学输入一致。
 */
export function productionChanges(before: WordBeatLesson, current: WordBeatLesson): string[] {
  const {
    segments: oldWords,
    voices: oldVoices,
    slogans: oldSlogans,
    music: oldMusic,
    ...oldSettings
  } = before.gameData;
  const { segments, voices, slogans, music, ...settings } = current.gameData;
  const groups: [string, unknown, unknown][] = [
    ['课件名称', before.name, current.name],
    ['词语、释义或每词练习安排', oldWords, segments],
    ['示范配音或口号', { voices: oldVoices, slogans: oldSlogans }, { voices, slogans }],
    ['背景音乐或对拍设置', oldMusic, music],
    ['练习模式、节奏或课堂设置', oldSettings, settings],
    ['尚未完成的参数输入', before.draftInputs, current.draftInputs],
  ];
  return groups
    .filter(([, oldValue, value]) => stableProductionJson(oldValue) !== stableProductionJson(value))
    .map(([label]) => label);
}
