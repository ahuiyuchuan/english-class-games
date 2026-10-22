/** 桌面和 file:// HTML 共用内嵌 Worker；不访问 CDN 或外部处理程序。 @author ahui */
import TempoWorker from './music-tempo.worker?worker&inline';

/** 会话退出立即终止 Worker；超时拒绝，不把旧结果应用到新会话。 */
export function prepareMusicTempo(
  buffer: AudioBuffer,
  rate: number,
  preservePitch: boolean,
  context: AudioContext,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  if (rate === 1) return Promise.resolve(buffer);
  if (signal.aborted) return Promise.reject(new Error('音乐预处理已取消。'));
  const frames = Math.ceil(buffer.length / rate);
  if (
    frames * buffer.numberOfChannels * 4 > 64_000_000 ||
    (buffer.length + frames) * 8 > 192_000_000
  )
    return Promise.reject(new Error('变速音乐超过解码预算，请使用较短素材或1倍速。'));
  return new Promise((resolve, reject) => {
    const worker = new TempoWorker();
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new Error('音乐预处理已取消。'));
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('音乐预处理超过60秒，请使用较短音乐后重试。'));
    }, 60_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      finish();
      reject(new Error('音乐处理组件无法运行，请检查当前浏览器。'));
    };
    worker.onmessage = (event: MessageEvent<{ channels?: Float32Array[]; error?: string }>) => {
      finish();
      if (signal.aborted || !event.data.channels) {
        reject(new Error(event.data.error ?? '音乐预处理已取消。'));
        return;
      }
      try {
        const result = context.createBuffer(event.data.channels.length, frames, buffer.sampleRate);
        event.data.channels.forEach((channel, index) =>
          result.copyToChannel(new Float32Array(channel), index),
        );
        resolve(result);
      } catch (cause) {
        // 内存分配失败也必须结束准备态，不能让已释放 Worker 的任务永久等待。
        reject(cause);
      }
    };
    // 复制后 transfer，不分离仍由 AudioContext 持有的原始 PCM。
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index).slice(),
    );
    worker.postMessage(
      { channels, sampleRate: buffer.sampleRate, rate, preservePitch },
      channels.map((channel) => channel.buffer),
    );
  });
}
