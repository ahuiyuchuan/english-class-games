/** 试听所有权回归：旧异步失败不能中断后来启动的语音或音乐；受控媒体不替代实机声音检查。 @author ahui */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioAsset } from './types';
import { previewAudio, stopPreview } from './audio-preview';
import { sha256Bytes } from '../portable/media';

const api = vi.hoisted(() => ({ readAssetData: vi.fn() }));
vi.mock('./repository', () => ({ readAssetData: api.readAssetData }));
vi.mock('./games', () => ({ getGame: vi.fn() }));

/** 受控异步点用于稳定重现“切换后才失败”，不依赖真实音频设备或墙上时钟。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const contexts: FakeAudioContext[] = [];
const mediaElements: FakeMedia[] = [];
let decodeFirst: (() => Promise<AudioBuffer>) | undefined;
let playFirst: (() => Promise<void>) | undefined;

/** 只模拟试听用到的 AudioContext 边界，便于观察旧任务是否错误关闭新设备会话。 */
class FakeAudioContext {
  state = 'running';
  destination = {};
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  decodeAudioData = vi.fn(async (): Promise<AudioBuffer> => {
    if (contexts[0] === this && decodeFirst) return decodeFirst();
    return { length: 3, numberOfChannels: 1 } as AudioBuffer;
  });
  createBufferSource = vi.fn(() => ({
    buffer: undefined,
    connect: vi.fn(),
    start: vi.fn(),
    onended: undefined,
  }));

  constructor() {
    contexts.push(this);
  }
}

/** 音乐使用独立媒体元素；pause/load 的调用次数反映该元素是否被旧任务清理。 */
class FakeMedia {
  preload = '';
  src = '';
  onended = undefined;
  onerror = undefined;
  play = vi.fn(async () => {
    if (mediaElements[0] === this && playFirst) await playFirst();
  });
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();

  constructor() {
    mediaElements.push(this);
  }
}

beforeEach(() => {
  contexts.length = 0;
  mediaElements.length = 0;
  decodeFirst = undefined;
  playFirst = undefined;
  api.readAssetData.mockReset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('document', { createElement: vi.fn(() => new FakeMedia()) });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${crypto.randomUUID()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  stopPreview();
  vi.unstubAllGlobals();
});

describe('试听切换后的迟到失败', () => {
  it.each([
    ['speech', 'speech'],
    ['speech', 'music'],
    ['music', 'speech'],
    ['music', 'music'],
  ] as const)('旧 %s 失败不停止新 %s，也不回传过期错误', async (oldRole, newRole) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const asset: AudioAsset = {
      assetId: 'preview-fixture',
      mimeType: 'audio/wav',
      byteLength: bytes.byteLength,
      durationMs: 100,
      sha256: await sha256Bytes(bytes),
    };
    api.readAssetData.mockImplementation(async () => bytes.slice().buffer);
    const started = deferred<void>();
    const failure = deferred<AudioBuffer>();
    const lateFailure = () => {
      started.resolve(undefined);
      return failure.promise;
    };
    if (oldRole === 'speech') decodeFirst = lateFailure;
    else
      playFirst = async () => {
        await lateFailure();
      };
    const oldOperation = previewAudio(asset, oldRole);
    await started.promise;

    await previewAudio(asset, newRole);
    const activeContext = newRole === 'speech' ? contexts.at(-1) : undefined;
    const activeMedia = newRole === 'music' ? mediaElements.at(-1) : undefined;
    failure.reject(new Error('旧任务在切换后才失败'));
    await expect(oldOperation).resolves.toBeUndefined();

    if (activeContext) {
      expect(activeContext.close).not.toHaveBeenCalled();
      expect(activeContext.createBufferSource.mock.results[0].value.start).toHaveBeenCalledOnce();
    }
    if (activeMedia) {
      expect(activeMedia.pause).not.toHaveBeenCalled();
      expect(activeMedia.play).toHaveBeenCalledOnce();
    }
  });

  it('当前试听的真实错误仍向调用方报告并释放会话', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const asset: AudioAsset = {
      assetId: 'failed-preview',
      mimeType: 'audio/wav',
      byteLength: bytes.byteLength,
      durationMs: 100,
      sha256: await sha256Bytes(bytes),
    };
    api.readAssetData.mockRejectedValue(new Error('当前声音读取失败'));
    await expect(previewAudio(asset)).rejects.toThrow('当前声音读取失败');
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it('当前音乐播放失败仍向调用方报告并释放媒体和临时地址', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const asset: AudioAsset = {
      assetId: 'failed-music-preview',
      mimeType: 'audio/wav',
      byteLength: bytes.byteLength,
      durationMs: 100,
      sha256: await sha256Bytes(bytes),
    };
    api.readAssetData.mockResolvedValue(bytes.slice().buffer);
    playFirst = async () => {
      throw new Error('当前音乐播放失败');
    };
    await expect(previewAudio(asset, 'music')).rejects.toThrow('当前音乐播放失败');
    expect(mediaElements[0].pause).toHaveBeenCalledOnce();
    expect(mediaElements[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
