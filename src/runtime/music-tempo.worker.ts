/** 独立 Worker 保持预处理期间 UI 可取消；不持有素材或跨会话缓存。 @author ahui */
import { stretchMusic } from './music-stretch';
self.onmessage = (
  event: MessageEvent<{
    channels: Float32Array[];
    sampleRate: number;
    rate: number;
    preservePitch: boolean;
  }>,
) => {
  try {
    const { channels, sampleRate, rate, preservePitch } = event.data;
    const result = stretchMusic(channels, sampleRate, rate, preservePitch);
    self.postMessage({ channels: result }, { transfer: result.map((channel) => channel.buffer) });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : '音乐预处理失败。' });
  }
};
