/** 编辑试听采用单会话，后一次试听、预演或课堂开始前必须停止旧声音。 @author ahui */
import type { AudioAsset, AssetMap, LessonDocument } from './types';
import { readAssetData } from './repository';
import { getGame } from './games';
import { sha256Bytes } from '../portable/media';

/** 语音按解码后的 Float32 PCM 计算，避免压缩文件尺寸低估内存。 */
const DECODED_AUDIO_BUDGET = 64_000_000;
const PREVIEW_TIMEOUT_MS = 30_000;

let previewContext: AudioContext | undefined;
let previewElement: HTMLAudioElement | undefined;
let previewObjectUrl: string | undefined;
let generation = 0;
let externalStop: (() => void) | undefined;

/** 校准试听共用独占权；返回函数只释放本次占用，不得停止后来开始的试听。 */
export function claimPreview(stop: () => void): () => void {
  stopPreview();
  externalStop = stop;
  return () => {
    if (externalStop === stop) externalStop = undefined;
  };
}

/** 停止并释放试听资源，迟到的异步解码结果也不能发声。 */
export function stopPreview(): void {
  const stop = externalStop;
  externalStop = undefined;
  stop?.();
  generation += 1;
  if (previewContext && previewContext.state !== 'closed') void previewContext.close();
  previewContext = undefined;
  if (previewElement) {
    previewElement.pause();
    previewElement.removeAttribute('src');
    previewElement.load();
    previewElement = undefined;
  }
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = undefined;
  }
}

/** 只播放已匹配真实素材，调用方负责阻止失效绑定进入此入口。 */
export async function previewAudio(
  asset: AudioAsset,
  role: 'speech' | 'music' = 'speech',
): Promise<void> {
  if (role === 'speech') assertSpeechAssetSize(asset);
  stopPreview();
  const activeGeneration = generation;
  let context: AudioContext | undefined;
  try {
    const resumeContext = role === 'speech' ? new AudioContext() : undefined;
    if (resumeContext) {
      context = resumeContext;
      previewContext = resumeContext;
    }
    const resumePromise = resumeContext?.resume();
    const bytes = await readAssetData(asset);
    if (
      bytes.byteLength !== asset.byteLength ||
      (await sha256Bytes(new Uint8Array(bytes))) !== asset.sha256
    )
      throw new Error(`声音校验失败：${asset.name ?? asset.assetId}`);
    if (activeGeneration !== generation) return;
    if (role === 'music') {
      await playMusicPreview(asset, bytes, activeGeneration);
      return;
    }
    if (!context) throw new Error('语音试听无法启动音频设备。');
    const buffer = await decodeWithTimeout(context, bytes, asset.name ?? asset.assetId);
    assertDecodedSpeechSize(buffer, asset.name ?? asset.assetId);
    if (activeGeneration !== generation || context.state === 'closed') return;
    await resumePromise;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (previewContext === context) stopPreview();
    };
    source.start();
  } catch (error) {
    // 旧试听的读取、解码或 play() 可能在切换后才失败。只有当前代次拥有清理权；
    // 过期调用与前面的取消分支一样直接结束，不能停止新声音或给新试听展示旧错误。
    if (activeGeneration !== generation) return;
    stopPreview();
    throw error;
  }
}

/** 当前版本所有启用素材逐项验真并解码；不一次保留整个声音库的解码缓冲。 */
export async function validatePlayableAssets(
  lesson: LessonDocument,
  assets: AssetMap,
): Promise<void> {
  const game = getGame(lesson.gameId);
  if (!game) throw new Error('缺少此课件所需的游戏模块。');
  const errors = game.validate(lesson, assets).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join('；'));
  game.compile(lesson, assets);
  const roles = game.requiredAssets(lesson).map((id) => {
    const role = game.assetRole?.(lesson, id) ?? 'speech';
    if (role !== 'speech' && role !== 'music')
      throw new Error(`游戏“${game.name}”声明了未知声音用途。`);
    return { id, role };
  });
  const context = roles.some(({ role }) => role === 'speech') ? new AudioContext() : undefined;
  try {
    for (const { id, role } of roles) {
      const asset = assets[id];
      if (!asset) throw new Error('所需声音缺失，请重新制作。');
      if (role === 'speech') assertSpeechAssetSize(asset);
      const bytes = await readAssetData(asset);
      if (
        bytes.byteLength !== asset.byteLength ||
        (await sha256Bytes(new Uint8Array(bytes))) !== asset.sha256
      )
        throw new Error(`声音校验失败：${asset.name ?? id}`);
      if (role === 'music') {
        await validateMusicPlayback(asset, bytes);
        continue;
      }
      if (!context) throw new Error('当前环境无法检查语音资源。');
      const decoded = await decodeWithTimeout(context, bytes, asset.name ?? id);
      assertDecodedSpeechSize(decoded, asset.name ?? id);
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0)
        throw new Error(`声音时长无效：${asset.name ?? id}。请重新导入或制作。`);
    }
  } finally {
    if (context && context.state !== 'closed') await context.close();
  }
}

/** 音乐试听保留媒体流语义，与课堂音乐一样不创建整曲 PCM 缓冲。 */
async function playMusicPreview(
  asset: AudioAsset,
  bytes: ArrayBuffer,
  activeGeneration: number,
): Promise<void> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function')
    throw new Error(`当前环境无法试听背景音乐“${asset.name ?? asset.assetId}”。`);
  const url = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
  const media = document.createElement('audio');
  previewElement = media;
  previewObjectUrl = url;
  media.preload = 'metadata';
  media.src = url;
  media.onended = () => {
    if (previewElement === media) stopPreview();
  };
  media.onerror = () => {
    if (previewElement === media) stopPreview();
  };
  try {
    await media.play();
    if (activeGeneration !== generation && previewElement === media) stopPreview();
  } catch (error) {
    // 当前代次的资源由外层统一释放；这里先停会改变代次，导致真实播放错误被当成旧任务吞掉。
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`背景音乐“${asset.name ?? asset.assetId}”无法播放：${reason}`);
  }
}

/** 不以素材元信息替代 PCM 预算，非安全整数和乘法溢出一律阻止语音处理。 */
function assertSpeechAssetSize(asset: AudioAsset): void {
  if (asset.frameCount === undefined || asset.channels === undefined) return;
  if (
    !Number.isSafeInteger(asset.frameCount) ||
    !Number.isSafeInteger(asset.channels) ||
    asset.frameCount <= 0 ||
    asset.channels <= 0 ||
    asset.frameCount > Math.floor(DECODED_AUDIO_BUDGET / (asset.channels * 4))
  )
    throw new Error(
      `声音“${asset.name ?? asset.assetId}”解码后将超过 64 MB，请使用较短或较小的声音。`,
    );
}

/** 按解码后的 AudioBuffer 实际占用复核，涵盖不同电脑上的重采样结果。 */
function assertDecodedSpeechSize(buffer: AudioBuffer, name: string): void {
  const byteCount = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(buffer.length) ||
    !Number.isSafeInteger(buffer.numberOfChannels) ||
    buffer.length <= 0 ||
    buffer.numberOfChannels <= 0 ||
    !Number.isSafeInteger(byteCount) ||
    byteCount > DECODED_AUDIO_BUDGET
  )
    throw new Error(`声音“${name}”实际解码超过 64 MB 或无效，请使用较短或较小的声音。`);
}

/** 有限时间等待每个声音，浏览器永久挂起时返回明确错误，不继续报“正在准备”。 */
async function decodeWithTimeout(
  context: AudioContext,
  bytes: ArrayBuffer,
  name: string,
): Promise<AudioBuffer> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      context.decodeAudioData(bytes),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`声音“${name}”在 30 秒内未能解码，请重新导入或制作。`)),
          PREVIEW_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && /30 秒内未能解码/u.test(error.message)) throw error;
    throw new Error(`声音“${name}”解码失败，请重新导入或制作。`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** 音乐只校验浏览器媒体元数据和短暂可播放性，不把整曲转成 PCM。 */
async function validateMusicPlayback(asset: AudioAsset, bytes: ArrayBuffer): Promise<void> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function')
    throw new Error(`当前环境无法检查背景音乐“${asset.name ?? asset.assetId}”。`);
  const blob = new Blob([bytes], { type: asset.mimeType });
  const url = URL.createObjectURL(blob);
  const media = document.createElement('audio');
  media.preload = 'metadata';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let hasMetadata = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        media.removeEventListener('loadedmetadata', onReady);
        media.removeEventListener('canplay', onPlayable);
        media.removeEventListener('error', onError);
        if (timeout !== undefined) clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => {
        if (!Number.isFinite(media.duration) || media.duration <= 0) {
          finish(new Error(`背景音乐“${asset.name ?? asset.assetId}”时长无效。`));
          return;
        }
        hasMetadata = true;
      };
      const onPlayable = () => {
        if (hasMetadata) finish();
      };
      const onError = () =>
        finish(new Error(`背景音乐“${asset.name ?? asset.assetId}”解码或播放检查失败。`));
      media.addEventListener('loadedmetadata', onReady);
      media.addEventListener('canplay', onPlayable);
      media.addEventListener('error', onError);
      timeout = setTimeout(
        () =>
          finish(
            new Error(`背景音乐“${asset.name ?? asset.assetId}”在 30 秒内未能读取，请重新导入。`),
          ),
        PREVIEW_TIMEOUT_MS,
      );
      media.src = url;
      media.load();
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    media.pause();
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(url);
  }
}
