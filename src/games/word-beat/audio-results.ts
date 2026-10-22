/**
 * 固定修订的纯声音绑定适配；不引入桌面任务、数据库或文件系统，浏览器注册可安全复用。
 * @author ahui
 */
import type { AssetMap, AudioTaskResult } from '../../platform/types';
import { audioRequestKey } from '../../shared/ai/audio-request';
import type { WordBeatLesson } from './model';
import { bindAudio, getAudioRequests, refreshAudioDependencies } from './rules';

/**
 * 恢复原固定修订的声音候选；按对象及需求关联，不依赖重新生成的请求UUID。
 * @param input 任务原课件和修订的完整快照，不修改传入数据。
 * @param assets 当前登记素材；仅有绑定仍通过本游戏声音检查才可复用。
 * @param task 该修订的实际成功产物，失败或未完成需求不补造声音。
 * @returns 独立候选课件及合并素材，只供只读检查或原制作调用方明确采用。
 * @throws Error 任务的课件或修订不对应输入，不能把其他版本声音放进课件。
 */
export function restoreWordBeatAudioTask(
  input: WordBeatLesson,
  assets: AssetMap,
  task: AudioTaskResult,
): { lesson: WordBeatLesson; assets: AssetMap } {
  if (task.lessonId !== input.id || task.inputRevision !== input.revision)
    throw new Error('声音成果与课件版本不一致，请查看任务原版本。');
  let lesson = refreshAudioDependencies(structuredClone(input));
  const requests = getAudioRequests(lesson, assets);
  const nextAssets = { ...assets };
  for (const result of task.results) {
    const request = requests.find((item) => item.objectId === result.objectId);
    if (!request) continue;
    nextAssets[result.asset.assetId] = result.asset;
    const key = audioRequestKey(request);
    for (const item of requests.filter((candidate) => audioRequestKey(candidate) === key))
      lesson = bindAudio(lesson, item.objectId, result.asset, item);
  }
  return { lesson, assets: nextAssets };
}
