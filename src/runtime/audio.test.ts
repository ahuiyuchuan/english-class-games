/** 内嵌解码与声源生命周期回归；受控设备不替代教室音箱实测。 @author ahui */
import { describe, expect, it, vi } from 'vitest';
import type { AudioAsset } from '../platform/types';
import { DECODED_AUDIO_BUDGET, readEmbeddedAudio, WebAudioSession } from './audio';
import type { RuntimeTimeline } from './types';

function asset(assetId: string): AudioAsset {
  return {
    sampleRate: 48_000,
    assetId,
    mimeType: 'audio/wav',
    durationMs: 1000,
    byteLength: 3,
    sha256: 'a'.repeat(64),
    dataUrl: 'data:audio/wav;base64,AQID',
  };
}

/** 最小Web Audio设备替身，验证排程依赖，不伪造系统语音成功。 */
function context() {
  const parameter = () => ({
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const source = () => ({
    buffer: null,
    loop: false,
    onended: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  });
  return {
    sampleRate: 48_000,
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createGain: vi.fn(() => ({ gain: parameter(), connect: vi.fn(), disconnect: vi.fn() })),
    createBufferSource: vi.fn(source),
    createMediaElementSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    decodeAudioData: vi.fn(async () => ({ duration: 1, length: 48_000, numberOfChannels: 1 })),
  };
}

/** 媒体测试替身只记录按需播放，不把音乐变成AudioBuffer。 */
function musicElement() {
  const element = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(element, {
    duration: 1,
    currentTime: 0,
    paused: true,
    ended: false,
    load: vi.fn(() => {
      // 与真实媒体加载算法一致，防止测试替身遗漏倍率复位而产生假通过。
      element.playbackRate = element.defaultPlaybackRate ?? 1;
      queueMicrotask(() => element.dispatchEvent(new Event('canplay')));
    }),
    play: vi.fn(async () => {
      element.paused = false;
    }),
    pause: vi.fn(() => {
      element.paused = true;
    }),
    removeAttribute: vi.fn(),
  });
  return element as unknown as HTMLAudioElement;
}

describe('离线内嵌音频', () => {
  it('只用内存解码base64，不依赖被CSP禁止的fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止网络'));
    expect([...new Uint8Array(await readEmbeddedAudio(asset('sample')))]).toEqual([1, 2, 3]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('拒绝远程、错误编码或大小不匹配的数据', async () => {
    await expect(
      readEmbeddedAudio({ ...asset('bad'), dataUrl: 'https://example.com/a.wav' }),
    ).rejects.toThrow();
    await expect(
      readEmbeddedAudio({ ...asset('bad'), dataUrl: 'data:audio/wav;base64,!' }),
    ).rejects.toThrow();
    await expect(readEmbeddedAudio({ ...asset('bad'), byteLength: 5 })).rejects.toThrow(/大小/);
  });
});

describe('逐词预载和解码预算', () => {
  /** 三词同段也只能预载当前/下一词，不允许退回整段解码。 */
  function timeline(): RuntimeTimeline<number> {
    return {
      durationMs: 3000,
      items: ['a', 'b', 'c'].map((id, index) => ({
        id,
        firstCue: index,
        lastCue: index,
        sectionIndex: 0,
      })),
      cues: ['a', 'b', 'c'].map((id, index) => ({
        id,
        kind: 'model',
        startMs: index * 1000,
        durationMs: 1000,
        itemIndex: index,
        sectionIndex: 0,
        audioAssetId: id,
        data: index,
        navigation: {
          previous: index > 0 ? index - 1 : null,
          next: index < 2 ? index + 1 : null,
          repeat: index,
        },
      })),
    };
  }

  it('多词同段只解码当前和下一词，前进释放旧窗口且可回切重载', async () => {
    const device = context();
    const data = { a: asset('a'), b: asset('b'), c: asset('c') };
    const session = new WebAudioSession(
      data,
      { beatEnabled: false, volumes: { voice: 1, beat: 0, music: 0 } },
      device as unknown as AudioContext,
    );
    const plan = timeline();
    await session.prepare(plan, 0);
    await vi.waitFor(() => expect(device.decodeAudioData).toHaveBeenCalledTimes(2));
    expect(session.isPrepared(plan.cues[2])).toBe(false);
    await session.prepare(plan, 1);
    await vi.waitFor(() => expect(device.decodeAudioData).toHaveBeenCalledTimes(3));
    expect(session.isPrepared(plan.cues[0])).toBe(false);
    await session.prepare(plan, 0);
    expect(session.isPrepared(plan.cues[0])).toBe(true);
    session.dispose();
  });

  it('末条练习期间预载后续非条目声音，自动收尾不产生人为等待', async () => {
    const device = context();
    const session = new WebAudioSession(
      { a: asset('a'), b: asset('b'), c: asset('c'), closing: asset('closing') },
      { beatEnabled: false, volumes: { voice: 1, beat: 0, music: 0 } },
      device as unknown as AudioContext,
    );
    const plan = timeline();
    plan.cues.push({
      ...plan.cues[2],
      id: 'closing',
      kind: 'closing',
      startMs: 3000,
      itemIndex: null,
      audioAssetId: 'closing',
      navigation: { previous: 2, next: null, repeat: null },
    });
    plan.durationMs += 1000;
    await session.prepare(plan, 2);
    await vi.waitFor(() => expect(session.isPrepared(plan.cues[3])).toBe(true));
    expect(session.isPrepared(plan.cues[2])).toBe(true);
    expect(session.isPrepared(plan.cues[0])).toBe(false);
    expect(device.decodeAudioData).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('单项真实解码超过64MB阻止播放，即使压缩文件很小', async () => {
    const device = context();
    device.decodeAudioData.mockResolvedValue({
      duration: 1,
      length: DECODED_AUDIO_BUDGET / 4 + 1,
      numberOfChannels: 1,
    });
    const session = new WebAudioSession(
      { a: asset('a') },
      { beatEnabled: false, volumes: { voice: 1, beat: 0, music: 0 } },
      device as unknown as AudioContext,
    );
    await expect(session.prepare(timeline(), 0)).rejects.toThrow(/超过64 MB/);
    expect(session.isPrepared(timeline().cues[0])).toBe(false);
    expect(device.createBufferSource).not.toHaveBeenCalled();
    session.dispose();
  });

  it.each([
    { frames: 16_000_000, accepted: true },
    { frames: 16_000_001, accepted: false },
  ])('64,000,000字节十进制边界：$frames个单声道采样点', async ({ frames, accepted }) => {
    const device = context();
    // 不分配大缓冲；设备替身报告采样点数，测试实际字节判定而非只比较常量。
    device.decodeAudioData.mockResolvedValue({
      duration: 1,
      length: frames,
      numberOfChannels: 1,
    });
    const session = new WebAudioSession(
      { a: asset('a') },
      { beatEnabled: false, volumes: { voice: 1, beat: 0, music: 0 } },
      device as unknown as AudioContext,
    );
    const plan = timeline();
    if (accepted) {
      await session.prepare(plan, 0);
      expect(session.isPrepared(plan.cues[0])).toBe(true);
    } else {
      await expect(session.prepare(plan, 0)).rejects.toThrow(/超过64 MB/);
      expect(session.isPrepared(plan.cues[0])).toBe(false);
    }
    session.dispose();
  });

  it('当前与下一项合计超限时延后下一项，进入下一项再释放并准备', async () => {
    const device = context();
    // 每项30秒、48kHz、8声道约44MB，均合法；只有一项能留在64MB缓存中。
    device.sampleRate = 48_000;
    device.decodeAudioData.mockResolvedValue({
      duration: 30,
      length: 1_440_000,
      numberOfChannels: 8,
    });
    const recording = (id: string) => ({
      ...asset(id),
      durationMs: 30_000,
      channels: 8,
      frameCount: 1_440_000,
    });
    const session = new WebAudioSession(
      { a: recording('a'), b: recording('b'), c: recording('c') },
      { beatEnabled: false, volumes: { voice: 1, beat: 0, music: 0 } },
      device as unknown as AudioContext,
    );
    const plan = timeline();
    await session.prepare(plan, 0);
    await vi.waitFor(() => expect(session.isPrepared(plan.cues[0])).toBe(true));
    expect(device.decodeAudioData).toHaveBeenCalledOnce();
    expect(session.isPrepared(plan.cues[0])).toBe(true);
    expect(session.isPrepared(plan.cues[1])).toBe(false);
    await session.prepare(plan, 1);
    expect(session.isPrepared(plan.cues[1])).toBe(true);
    expect(session.isPrepared(plan.cues[0])).toBe(false);
    session.dispose();
  });

  it('音乐加载后仍保音高变速，混音暂停保留位置，退出回收地址', async () => {
    const device = context();
    const element = musicElement();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const session = new WebAudioSession(
      { a: asset('a'), music: asset('music') },
      {
        beatEnabled: false,
        musicAssetId: 'music',
        musicRate: 1.2,
        volumes: { voice: 1, beat: 0, music: 0.15 },
      },
      device as unknown as AudioContext,
      () => element,
    );
    const plan = timeline();
    await session.prepare(plan, 0);
    session.play(plan.cues[0], 0);
    expect(device.createMediaElementSource).toHaveBeenCalledWith(element);
    expect(element.play).toHaveBeenCalledOnce();
    expect(element.playbackRate).toBe(1.2);
    expect(element.preservesPitch).toBe(true);
    element.currentTime = 0.6;
    session.pause();
    expect(element.currentTime).toBe(0.6);
    expect(element.pause).toHaveBeenCalled();
    // 音乐未进入decodeAudioData；另一个词缺失只留为预载错误。
    expect(device.decodeAudioData).toHaveBeenCalledOnce();
    session.dispose();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('音乐首次读取临时失败后可主动重试，成功示范仍只解码一次', async () => {
    const device = context();
    let failMusic = true;
    const session = new WebAudioSession(
      { a: asset('a'), music: asset('music') },
      {
        beatEnabled: false,
        musicAssetId: 'music',
        volumes: { voice: 1, beat: 0, music: 0.15 },
        resolveAsset: async (item) => {
          if (item.assetId === 'music' && failMusic) {
            failMusic = false;
            throw new Error('外置音频暂不可读');
          }
          return new ArrayBuffer(3);
        },
      },
      device as unknown as AudioContext,
      musicElement,
    );
    const plan = timeline();
    await expect(session.prepare(plan, 0)).rejects.toThrow('外置音频暂不可读');
    await session.prepare(plan, 0);
    expect(session.isPrepared(plan.cues[0])).toBe(true);
    await session.prepare(plan, 0);
    expect(device.decodeAudioData).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('音乐元数据失败释放旧地址与节点，修复后重试新媒体且退出不重复释放', async () => {
    const device = context();
    const failed = musicElement();
    Object.defineProperty(failed, 'duration', { value: 9, configurable: true });
    const recovered = musicElement();
    const createMusic = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(recovered);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const before = revoke.mock.calls.length;
    const session = new WebAudioSession(
      { a: asset('a'), music: asset('music') },
      { beatEnabled: false, musicAssetId: 'music', volumes: { voice: 1, beat: 0, music: 0.15 } },
      device as unknown as AudioContext,
      createMusic,
    );
    const plan = timeline();
    await expect(session.prepare(plan, 0)).rejects.toThrow(/实际时长/);
    expect(device.createMediaElementSource.mock.results[0].value.disconnect).toHaveBeenCalledOnce();
    expect(revoke.mock.calls.length - before).toBe(1);
    await session.prepare(plan, 0);
    session.play(plan.cues[0], 0);
    expect(recovered.play).toHaveBeenCalledOnce();
    session.dispose();
    expect(revoke.mock.calls.length - before).toBe(2);
    expect(device.createMediaElementSource.mock.results[1].value.disconnect).toHaveBeenCalledOnce();
  });

  it('音乐没有就绪或失败事件时明确超时，迟到事件不复活旧资源且仍可重试', async () => {
    vi.useFakeTimers();
    const stalled = musicElement();
    vi.mocked(stalled.load).mockImplementation(() => undefined);
    const recovered = musicElement();
    const createMusic = vi.fn().mockReturnValueOnce(stalled).mockReturnValueOnce(recovered);
    const session = new WebAudioSession(
      { a: asset('a'), music: asset('music') },
      { beatEnabled: false, musicAssetId: 'music', volumes: { voice: 1, beat: 0, music: 0.15 } },
      context() as unknown as AudioContext,
      createMusic,
    );
    try {
      const pending = session.prepare(timeline(), 0);
      const rejected = expect(pending).rejects.toThrow(/超过30秒/);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      stalled.dispatchEvent(new Event('canplay'));
      expect(session.isPrepared(timeline().cues[0])).toBe(false);
      const retry = session.prepare(timeline(), 0);
      await vi.advanceTimersByTimeAsync(0);
      await retry;
      expect(session.isPrepared(timeline().cues[0])).toBe(true);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });
});

describe('异步预加载生命周期', () => {
  it('迟到的旧段解码不逐出最新目标资源，导航后仍能播放', async () => {
    const device = context();
    const deferred = new Map<string, (value: ArrayBuffer) => void>();
    const session = new WebAudioSession(
      { a: asset('a'), b: asset('b'), c: asset('c') },
      {
        beatEnabled: false,
        volumes: { voice: 1, beat: 0.2, music: 0.15 },
        resolveAsset: (item) =>
          item.assetId === 'c'
            ? Promise.resolve(new ArrayBuffer(3))
            : new Promise((resolve) => deferred.set(item.assetId, resolve)),
      },
      device as unknown as AudioContext,
    );
    const timeline: RuntimeTimeline<number> = {
      items: [],
      durationMs: 3000,
      cues: ['a', 'b', 'c'].map((id, index) => ({
        id,
        kind: 'show',
        startMs: index * 1000,
        durationMs: 1000,
        itemIndex: null,
        sectionIndex: index,
        audioAssetId: id,
        data: index,
        navigation: { previous: null, next: null, repeat: null },
      })),
    };
    const obsolete = session.prepare(timeline, 0);
    await vi.waitFor(() => expect(deferred.has('a')).toBe(true));
    await session.prepare(timeline, 2);
    deferred.get('a')!(new ArrayBuffer(3));
    deferred.get('b')?.(new ArrayBuffer(3));
    await obsolete;
    expect(() => session.play(timeline.cues[2], 0)).not.toThrow();
    expect(device.createBufferSource).toHaveBeenCalledOnce();
    session.dispose();
    expect(device.close).toHaveBeenCalledOnce();
  });

  it('恢复到配音结束后的留白不压低音乐，实际配音期间按新音量压低并恢复', async () => {
    const device = context();
    const session = new WebAudioSession(
      { voice: asset('voice'), music: asset('music') },
      {
        beatEnabled: false,
        musicAssetId: 'music',
        musicLoop: true,
        volumes: { voice: 1, beat: 0.2, music: 0.15 },
      },
      device as unknown as AudioContext,
      musicElement,
    );
    const cue = {
      id: 'model',
      kind: 'model',
      startMs: 0,
      durationMs: 1800,
      itemIndex: 0,
      sectionIndex: 0,
      audioAssetId: 'voice',
      data: 0,
      navigation: { previous: null, next: null, repeat: 0 },
    };
    await session.prepare(
      {
        cues: [cue],
        items: [{ id: 'a', firstCue: 0, lastCue: 0, sectionIndex: 0 }],
        durationMs: 1800,
      },
      0,
    );
    const musicGain = device.createGain.mock.results[2].value.gain;
    session.play(cue, 1200);
    expect(device.createBufferSource).not.toHaveBeenCalled();
    expect(musicGain.setTargetAtTime).toHaveBeenLastCalledWith(0.15, 0, 0.05);
    session.pause();
    device.currentTime = 2;
    session.play(cue, 400);
    expect(musicGain.setTargetAtTime).toHaveBeenCalledWith(0.045, 2, 0.05);
    expect(musicGain.setTargetAtTime).toHaveBeenLastCalledWith(0.15, 2.6, 0.05);
    session.setVolumes({ voice: 0.5, beat: 0, music: 0.5 });
    expect(musicGain.setValueAtTime).toHaveBeenLastCalledWith(0.15, 2);
    expect(musicGain.setTargetAtTime).toHaveBeenLastCalledWith(0.5, 2.6, 0.05);
    session.dispose();
  });

  it('真实解码虽在元信息容差内但超出阶段时，阻止播放以免截断示范', async () => {
    const device = context();
    device.decodeAudioData.mockResolvedValue({
      duration: 1.2,
      length: 57_600,
      numberOfChannels: 1,
    });
    const session = new WebAudioSession(
      { voice: asset('voice') },
      { beatEnabled: false, volumes: { voice: 1, beat: 0.2, music: 0 } },
      device as unknown as AudioContext,
    );
    const cue = {
      id: 'voice',
      kind: 'model',
      startMs: 0,
      durationMs: 1100,
      itemIndex: 0,
      sectionIndex: 0,
      audioAssetId: 'voice',
      data: 0,
      navigation: { previous: null, next: null, repeat: 0 },
    };
    await session.prepare(
      {
        cues: [cue],
        items: [{ id: 'a', firstCue: 0, lastCue: 0, sectionIndex: 0 }],
        durationMs: 1100,
      },
      0,
    );
    expect(() => session.play(cue, 0)).toThrow(/实际声音超出编排阶段/);
    expect(device.createBufferSource).not.toHaveBeenCalled();
    session.dispose();
  });
});
