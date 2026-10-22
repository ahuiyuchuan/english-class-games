/**
 * 通用声音任务观察器：负责唯一需求、真实进度与本地观察生命周期；具体游戏
 * 自行将产物绑定到教学对象。停止观察不取消后台任务，教师可从任务面板继续查看。
 * @author ahui
 */
import * as native from './native';
import type { TaskRecord } from './native';
import type { AudioRequest } from './types';
import { audioRequestKey } from '../shared/ai/audio-request';

/** 等待下一次真实查询；卸载时移除计时器及监听，不让观察循环占用旧页面。 */
function nextPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('任务观察已停止', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 350);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * 启动或复用后台声音任务，并观察到终态；不解释游戏字段或修改课件。
 * @param requests 固定输入的声音需求；重复需求只向后端提交一次。
 * @param context 课件身份和修订，试听可省略；重试通过 retryOf 关联原终态任务。
 * @param onTask 每次实际任务回包的通知，不生成模拟阶段或百分比。
 * @param signal 仅停止此调用的观察；不向后端发送取消，已完成产物仍由任务保留。
 * @returns 真实终态记录；没有声音需求时不启动任务并返回 undefined。
 * @throws Error 本地服务失败或观察被取消；调用方保留原固定输入。
 */
export async function runAudioTask(
  requests: AudioRequest[],
  context: { lessonId?: string; revision?: number; retryOf?: string },
  onTask: (task: TaskRecord) => void,
  signal?: AbortSignal,
): Promise<TaskRecord | undefined> {
  signal?.throwIfAborted();
  if (!requests.length) return undefined;
  const unique = new Map<string, AudioRequest>();
  for (const request of requests) {
    const key = audioRequestKey(request);
    if (!unique.has(key)) unique.set(key, request);
  }
  let task = await native.synthesizeSpeech(
    [...unique.values()],
    context.lessonId,
    context.revision,
    context.retryOf,
  );
  signal?.throwIfAborted();
  onTask(task);
  while (['queued', 'running', 'cancelling'].includes(task.state)) {
    await nextPoll(signal);
    task = await native.getTask(task.taskId);
    signal?.throwIfAborted();
    onTask(task);
  }
  return task;
}
