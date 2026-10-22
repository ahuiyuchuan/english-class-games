/** 有界音乐预处理算法；仅处理 PCM，不读取文件、不改变原素材。 @author ahui */
import { Stretch } from '@soundtouchjs/core';

/**
 * 按倍率生成等音高 PCM，关闭保音高时使用线性重采样。
 * 输入为一或双声道，输出时长为原时长／倍率；末尾补零仅冲刷算法窗口，
 * 不写入原素材。调用方必须在 Worker 中执行并负责取消和总内存预算。
 */
export function stretchMusic(
  channels: Float32Array[],
  sampleRate: number,
  rate: number,
  preservePitch: boolean,
): Float32Array[] {
  if (
    !Number.isFinite(rate) ||
    rate < 0.75 ||
    rate > 1.25 ||
    channels.length < 1 ||
    channels.length > 2
  )
    throw new Error('音乐变速仅支持0.75～1.25倍、单声道或双声道。');
  const length = channels[0].length;
  if (
    !length ||
    channels.some((channel) => channel.length !== length) ||
    sampleRate < 8000 ||
    sampleRate > 96000
  )
    throw new Error('音乐采样数据不完整或采样率不支持。');
  const outputLength = Math.ceil(length / rate);
  if ((length + outputLength) * 8 > 192_000_000)
    throw new Error('音乐预处理超过192 MB预算，请使用较短素材或1倍速。');
  if (rate === 1) return channels.map((channel) => channel.slice());
  const output = channels.map(() => new Float32Array(outputLength));
  if (!preservePitch) {
    output.forEach((channel, index) => {
      for (let frame = 0; frame < outputLength; frame++) {
        const position = frame * rate,
          before = Math.floor(position),
          fraction = position - before;
        channel[frame] =
          channels[index][Math.min(length - 1, before)] * (1 - fraction) +
          channels[index][Math.min(length - 1, before + 1)] * fraction;
      }
    });
    return output;
  }
  const processor = new Stretch({ sampleRate, createBuffers: true });
  processor.tempo = rate;
  let written = 0;
  const chunk = new Float32Array(4096 * 2);
  // 有限补零让最后一个完整处理窗口排出；输出严格限于约定时长，不能无限 flush。
  for (let offset = 0; offset < length + sampleRate && written < outputLength; offset += 4096) {
    chunk.fill(0);
    for (let i = 0; i < Math.min(4096, length - offset); i++) {
      chunk[i * 2] = channels[0][offset + i];
      chunk[i * 2 + 1] = (channels[1] ?? channels[0])[offset + i];
    }
    processor.inputBuffer!.putSamples(chunk);
    processor.process();
    const available = processor.outputBuffer!.frameCount;
    const samples = new Float32Array(available * 2);
    processor.outputBuffer!.extract(samples, 0, available);
    processor.outputBuffer!.receive(available);
    const count = Math.min(available, outputLength - written);
    for (let i = 0; i < count; i++)
      output.forEach((channel, index) => {
        channel[written + i] = samples[i * 2 + index];
      });
    written += count;
  }
  processor.clear();
  if (written < outputLength) throw new Error('音乐变速未生成完整结果，请重试或使用1倍速。');
  return output;
}
