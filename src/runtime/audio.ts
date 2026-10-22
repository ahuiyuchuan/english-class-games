/**
 * Web Audio 会话适配。只读取已准备的真实音频，桌面和便携端共用；
 * 按当前及下一条目滑动预载，64MB解码预算不含按需播放的背景音乐。
 * @author ahui
 */
import type { AssetMap, AudioAsset } from '../platform/types';
import type { RuntimeAudioDriver, RuntimeCue, RuntimeTimeline } from './types';
import { DECODED_AUDIO_BUDGET } from './audio-budget';
import { prepareMusicTempo } from './music-tempo';
export { DECODED_AUDIO_BUDGET } from './audio-budget';

/** 声部可用性由导出版本确定，课堂音量不能启用未打包声部。 */
export interface AudioSessionOptions {
  beatEnabled: boolean;
  musicAssetId?: string;
  musicLoop?: boolean;
  /** 已核验倍率；普通伴奏独立，对拍为目标 BPM／原始 BPM。 */
  musicRate?: number;
  musicPreservePitch?: boolean;
  /** 恒速音乐网格，单位毫秒；仅由通过检查的自主齐读课件提供。 */
  musicSync?: { bpm: number; firstBeatMs: number; loopStartMs: number; loopEndMs: number };
  volumes: { voice: number; beat: number; music: number };
  resolveAsset?: (asset: AudioAsset) => Promise<ArrayBuffer>;
}

/** 仅内嵌data音频可由默认适配读取，不请求远程URL或任意本机路径。 */
export async function readEmbeddedAudio(asset: AudioAsset): Promise<ArrayBuffer> {
  const match = asset.dataUrl?.match(/^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || match[1] !== asset.mimeType)
    throw new Error(`声音“${asset.name ?? asset.assetId}”缺少可播放的数据。`);
  // 便携成品禁止连接网络；直接在内存解码，file://下也不依赖fetch或CORS。
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Error('内嵌声音编码已损坏。');
  }
  if (!binary.length || binary.length !== asset.byteLength)
    throw new Error('内嵌声音大小与课件记录不符。');
  // 大声音逐字符迭代并调用映射回调会长时间占用主线程，挡住“正在准备”的绘制。
  // 直接按索引复制 atob 的单字节结果，避免迭代器开销，也兼容最低支持的 Chrome 120。
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** 同一课堂只创建一个会话，旧会话dispose后迟到解码不再发声。 */
export class WebAudioSession<T = unknown> implements RuntimeAudioDriver<T> {
  private context: AudioContext;
  private voiceGain: GainNode;
  private beatGain: GainNode;
  private musicGain: GainNode;
  private readonly assets: AssetMap;
  private options: AudioSessionOptions;
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | undefined>>();
  private voices = new Set<AudioBufferSourceNode>();
  private beats = new Set<OscillatorNode>();
  private music: HTMLAudioElement | null = null;
  private syncBuffer: AudioBuffer | null = null;
  private syncSource: AudioBufferSourceNode | null = null;
  private syncOrigin: number | null = null;
  private readonly tempoAbort = new AbortController();
  private musicSource: MediaElementAudioSourceNode | null = null;
  private musicUrl: string | null = null;
  private musicPreparation: Promise<void> | null = null;
  private musicReady = false;
  private musicError: Error | null = null;
  private cancelMusicPreparation: (() => void) | null = null;
  private disposed = false;
  private nextBeatAt = 0;
  private voiceEndsAt = 0;
  private preparation = 0;
  private wantedAssets = new Set<string>();
  private protectedAssets = new Set<string>();
  private failures = new Map<string, Error>();
  private deferredAssets = new Set<string>();
  private decoding = Promise.resolve();

  /** context可由设备适配注入，默认用Web Audio；绝不浏览器朗读代替已合成声音。 */
  constructor(
    assets: AssetMap,
    options: AudioSessionOptions,
    context = new AudioContext(),
    private readonly createMusicElement: () => HTMLAudioElement = () => new Audio(),
  ) {
    this.assets = assets;
    this.options = structuredClone({ ...options, resolveAsset: undefined });
    this.options.resolveAsset = options.resolveAsset;
    this.context = context;
    this.voiceGain = context.createGain();
    this.beatGain = context.createGain();
    this.musicGain = context.createGain();
    this.voiceGain.connect(context.destination);
    this.beatGain.connect(context.destination);
    this.musicGain.connect(context.destination);
    this.setVolumes(options.volumes);
  }

  /** 时间轴统一使用音频设备时钟，单位毫秒。 */
  now = (): number => this.context.currentTime * 1000;

  /** 当前阶段可直接播放才返回true；控制器据此识别真实资源等待。 */
  isPrepared(cue: RuntimeCue<T>): boolean {
    return (
      (!cue.audioAssetId || this.buffers.has(cue.audioAssetId)) &&
      (!this.options.musicAssetId || this.musicReady)
    );
  }

  /** 用户点击启用设备；只等待当前必需声音，下一条目在预算内后台预载。 */
  async prepare(timeline: RuntimeTimeline<T>, cueIndex: number): Promise<void> {
    if (this.disposed) throw new Error('声音会话已结束。');
    const generation = ++this.preparation;
    const current = timeline.cues[cueIndex];
    const currentItem =
      current?.itemIndex ??
      timeline.cues.slice(cueIndex).find((cue) => cue.itemIndex !== null)?.itemIndex;
    const item =
      currentItem === null || currentItem === undefined ? undefined : timeline.items[currentItem];
    const nextItem =
      currentItem === null || currentItem === undefined
        ? undefined
        : timeline.items[currentItem + 1];
    const first = current?.itemIndex !== null && item ? item.firstCue : cueIndex;
    // 最后一个教学条目之后仍可能有收尾声音。将该尾部纳入滑动窗口，
    // 避免自动课堂已完成所有词，却因从未预载收尾而要求教师再点继续。
    // 有下一条目时仍只预载到下一条目末尾，缓存预算和当前声音保护不变。
    const last = nextItem?.lastCue ?? (item ? timeline.cues.length - 1 : cueIndex);
    const ids = new Set(
      timeline.cues
        .slice(first, Math.max(cueIndex, last) + 1)
        .map((cue) => cue.audioAssetId)
        .filter((id): id is string => Boolean(id)),
    );
    if (current?.audioAssetId) ids.add(current.audioAssetId);
    this.wantedAssets = ids;
    // 当前条目已有声音必须保留；合计超限时延后下一项，不反复解码挤掉当前项。
    this.protectedAssets = new Set(
      timeline.cues
        .slice(first, item?.lastCue !== undefined ? item.lastCue + 1 : cueIndex + 1)
        .map((cue) => cue.audioAssetId)
        .filter((id): id is string => Boolean(id)),
    );
    if (current?.audioAssetId) this.protectedAssets.add(current.audioAssetId);
    this.deferredAssets.clear();
    for (const id of this.buffers.keys()) if (!ids.has(id)) this.buffers.delete(id);
    await this.context.resume();
    await this.prepareMusic();
    if (current?.audioAssetId) {
      // 文件读取/设备故障可恢复；主动重试重新核验，不能永久缓存一次临时失败。
      this.failures.delete(current.audioAssetId);
      await this.decode(current.audioAssetId, true);
    }
    if (this.disposed || generation !== this.preparation) return;
    void this.preload(ids, generation);
  }

  /** 阶段进入时重新创建不可复用的AudioBufferSource，按暂停位置恢复。 */
  play(cue: RuntimeCue<T>, offsetMs: number): void {
    if (this.disposed) return;
    this.stopVoice();
    this.stopBeat();
    const now = this.context.currentTime;
    this.voiceEndsAt = now;
    if (cue.audioAssetId) {
      const buffer = this.buffers.get(cue.audioAssetId);
      if (!buffer) throw new Error('当前声音尚未准备完成。');
      // 允许容器解码产生少量元信息差异，但绝不让误差导致声音被阶段切换截断。
      if (buffer.duration * 1000 > cue.durationMs + 0.1)
        throw new Error('实际声音超出编排阶段，请返回备课重新检查声音或调整节奏。');
      const offset = offsetMs / 1000;
      if (offset < buffer.duration) {
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.voiceGain);
        this.voices.add(source);
        source.onended = () => {
          this.voices.delete(source);
          source.disconnect();
        };
        source.start(now, offset);
        this.voiceEndsAt = now + buffer.duration - offset;
      }
    }
    // 暂停可能落在声音之后的整拍留白，恢复留白时没有配音，不持续压低音乐。
    const musicVolume = this.options.volumes.music * (this.voiceEndsAt > now ? 0.3 : 1);
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setTargetAtTime(musicVolume, now, 0.05);
    if (this.voiceEndsAt > now)
      this.musicGain.gain.setTargetAtTime(this.options.volumes.music, this.voiceEndsAt, 0.05);
    if (this.options.musicSync) this.playSyncedMusic(cue, offsetMs);
    else this.ensureMusic();
    const interval = (cue.pulseIntervalMs ?? 0) / 1000;
    this.nextBeatAt =
      interval > 0 ? now + ((interval - ((offsetMs / 1000) % interval)) % interval) : Infinity;
    this.tick(cue, offsetMs);
  }

  /** 提前150ms按绝对设备时间排节拍，画面只读取时间而不触发声音次数。 */
  tick(cue: RuntimeCue<T>, offsetMs: number): void {
    if (this.musicError) throw this.musicError;
    if (!this.options.beatEnabled || !cue.pulseIntervalMs || this.disposed) return;
    const now = this.context.currentTime;
    const interval = cue.pulseIntervalMs / 1000;
    const end = now + (cue.durationMs - offsetMs) / 1000;
    while (this.nextBeatAt < now - 0.03) this.nextBeatAt += interval;
    while (this.nextBeatAt < now + 0.15 && this.nextBeatAt < end) {
      const oscillator = this.context.createOscillator();
      const envelope = this.context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      const at = Math.max(now, this.nextBeatAt);
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(0.35, at + 0.005);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      oscillator.connect(envelope);
      envelope.connect(this.beatGain);
      this.beats.add(oscillator);
      oscillator.onended = () => {
        this.beats.delete(oscillator);
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(at);
      oscillator.stop(at + 0.055);
      this.nextBeatAt += interval;
    }
  }

  /** 设置三个独立音量，0仅静音，不改变启用状态和资源需求。 */
  setVolumes(volumes: AudioSessionOptions['volumes']): void {
    this.options.volumes = { ...volumes };
    const now = this.context.currentTime;
    this.voiceGain.gain.setValueAtTime(volumes.voice, now);
    this.beatGain.gain.setValueAtTime(volumes.beat, now);
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(volumes.music * (now < this.voiceEndsAt ? 0.3 : 1), now);
    if (now < this.voiceEndsAt)
      this.musicGain.gain.setTargetAtTime(volumes.music, this.voiceEndsAt, 0.05);
  }

  /** 媒体元素保留音乐位置，不整曲解码；暂停停止三个声部。 */
  pause(): void {
    this.stopVoice();
    this.stopBeat();
    this.music?.pause();
    this.stopSyncedMusic();
  }

  /** 会话结束重置音乐位置，重新开始不会接着旧轮次发声。 */
  stop(): void {
    this.pause();
    if (this.music && this.musicReady) this.music.currentTime = 0;
  }

  /** 释放设备与缓存，迟到异步结果仅丢弃，不重新创建声源。 */
  dispose(): void {
    this.tempoAbort.abort();
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.syncBuffer = null;
    this.buffers.clear();
    this.pending.clear();
    this.wantedAssets.clear();
    this.protectedAssets.clear();
    this.failures.clear();
    this.cancelMusicPreparation?.();
    this.musicSource?.disconnect();
    if (this.music) {
      this.music.removeAttribute('src');
      this.music.load();
      this.music = null;
    }
    if (this.musicUrl) URL.revokeObjectURL(this.musicUrl);
    this.musicUrl = null;
    this.voiceGain.disconnect();
    this.beatGain.disconnect();
    this.musicGain.disconnect();
    void this.context.close();
  }

  /** 串行解码避免后台预载无限并发，实际采样数据入缓存前再次检查预算。 */
  private async decode(id: string, required = false): Promise<AudioBuffer | undefined> {
    const existing = this.buffers.get(id);
    if (existing) return existing;
    if (this.failures.has(id)) throw this.failures.get(id);
    if (!required && this.deferredAssets.has(id)) return undefined;
    const pending = this.pending.get(id);
    if (pending) {
      const buffer = await pending;
      if (required && !this.buffers.has(id) && this.wantedAssets.has(id)) {
        if (this.pending.get(id) === pending) this.pending.delete(id);
        return this.decode(id, true);
      }
      return buffer;
    }
    const asset = this.assets[id];
    if (!asset) throw new Error('课件引用的声音已丢失。');
    const operation = (async () => {
      if (this.disposed || !this.wantedAssets.has(id)) return undefined;
      const expectedFrames =
        asset.frameCount && asset.sampleRate
          ? Math.ceil((asset.frameCount * this.context.sampleRate) / asset.sampleRate)
          : Math.ceil((asset.durationMs / 1000) * this.context.sampleRate);
      const expectedBytes = asset.channels ? expectedFrames * asset.channels * 4 : undefined;
      if (expectedBytes && expectedBytes > DECODED_AUDIO_BUDGET)
        throw new Error(`声音“${asset.name ?? id}”解码后超过64 MB，请换用较小音频。`);
      if (!required && expectedBytes && !this.makeRoom(expectedBytes)) {
        this.deferredAssets.add(id);
        return undefined;
      }
      const bytes = await (this.options.resolveAsset ?? readEmbeddedAudio)(asset);
      // 文件读取可以并行，只有真实解码串行；旧读取慢不能阻塞教师的新导航。
      const decoding = this.decoding.then(async () => {
        if (this.disposed || !this.wantedAssets.has(id)) return undefined;
        const buffer = await this.context.decodeAudioData(bytes.slice(0));
        if (!buffer.duration || Math.abs(buffer.duration * 1000 - asset.durationMs) > 250)
          throw new Error(`声音“${asset.name ?? id}”实际时长与课件记录不符。`);
        const size = buffer.length * buffer.numberOfChannels * 4;
        if (!Number.isSafeInteger(size) || size <= 0)
          throw new Error(`声音“${asset.name ?? id}”的实际采样数据无效。`);
        if (size > DECODED_AUDIO_BUDGET)
          throw new Error(`声音“${asset.name ?? id}”解码后超过64 MB，请换用较小音频。`);
        if (!this.disposed && this.wantedAssets.has(id)) {
          if (!this.makeRoom(size)) {
            this.deferredAssets.add(id);
            if (required) throw new Error('当前声音缓存无法就绪，请停止并重新进入课堂。');
            return undefined;
          }
          this.buffers.set(id, buffer);
        }
        return buffer;
      });
      this.decoding = decoding.then(
        () => undefined,
        () => undefined,
      );
      return decoding;
    })();
    const guarded = operation.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error('声音解码失败。');
      if (!this.disposed) this.failures.set(id, failure);
      throw failure;
    });
    this.pending.set(id, guarded);
    try {
      return await guarded;
    } finally {
      if (this.pending.get(id) === guarded) this.pending.delete(id);
    }
  }

  /** 只逐项处理当前窗口；失败留给该声音真正进入前显示，不影响当前已就绪声音。 */
  private async preload(ids: Set<string>, generation: number): Promise<void> {
    for (const id of ids) {
      if (this.disposed || generation !== this.preparation) return;
      try {
        await this.decode(id);
      } catch {
        /* 当前声音准备会报告准确错误，预载阶段不能产生未处理拒绝或偷偷降级。 */
      }
    }
  }

  /** 先回收非当前条目缓存；仍放不下就延后预载，绝不突破64MB。 */
  private makeRoom(bytes: number): boolean {
    const used = () =>
      (this.syncBuffer ? this.syncBuffer.length * this.syncBuffer.numberOfChannels * 4 : 0) +
      [...this.buffers.values()].reduce(
        (sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4,
        0,
      );
    for (const id of this.buffers.keys()) {
      if (used() + bytes <= DECODED_AUDIO_BUDGET) return true;
      if (!this.protectedAssets.has(id)) this.buffers.delete(id);
    }
    return used() + bytes <= DECODED_AUDIO_BUDGET;
  }

  /** 音乐经媒体元素按需读取，连接同一混音节点，禁止decodeAudioData整曲预解码。 */
  private prepareMusic(): Promise<void> {
    if (!this.options.musicAssetId || this.musicReady) {
      this.musicError = null;
      return Promise.resolve();
    }
    if (this.musicPreparation) return this.musicPreparation;
    // 这里只由教师开始/继续/重试触发。上次读取或设备失败不应永久封锁本次会话，
    // 清掉旧失败并重新检查；已完成的语音缓存仍可复用。
    this.musicError = null;
    const asset = this.assets[this.options.musicAssetId];
    if (!asset) return Promise.reject(new Error('背景音乐已丢失。'));
    this.musicPreparation = (async () => {
      const bytes = await (this.options.resolveAsset ?? readEmbeddedAudio)(asset);
      if (this.disposed) return;
      if (this.options.musicSync) {
        // 对拍用可精确定位的音频源，按最多双声道先限制解码预算，避免长音乐无界占用。
        if (
          Math.ceil((asset.durationMs / 1000) * this.context.sampleRate) * 8 >
          DECODED_AUDIO_BUDGET
        )
          throw new Error('此音乐对拍解码预算超过64 MB，请选用较短音乐或普通伴奏。');
        const buffer = await this.context.decodeAudioData(bytes.slice(0));
        if (this.disposed) return;
        if (
          Math.abs(buffer.duration * 1000 - asset.durationMs) > 250 ||
          buffer.length * buffer.numberOfChannels * 4 > DECODED_AUDIO_BUDGET
        )
          throw new Error('音乐实际时长或对拍解码预算不符合要求。');
        this.syncBuffer = await prepareMusicTempo(
          buffer,
          this.options.musicRate ?? 1,
          this.options.musicPreservePitch ?? true,
          this.context,
          this.tempoAbort.signal,
        );
        if (this.disposed) {
          this.syncBuffer = null;
          return;
        }
        this.musicReady = true;
        return;
      }
      const element = this.createMusicElement();
      this.music = element;
      element.preload = 'metadata';
      element.loop = this.options.musicLoop ?? true;
      // 普通伴奏保持独立流式播放，Chromium 的 preservesPitch 提供原生保音高。
      element.preservesPitch = this.options.musicPreservePitch ?? true;
      // HTMLMediaElement.load() 会把当前倍率复位到默认倍率；两者一致才能真正变速。
      element.defaultPlaybackRate = this.options.musicRate ?? 1;
      element.playbackRate = this.options.musicRate ?? 1;
      this.musicSource = this.context.createMediaElementSource(element);
      this.musicSource.connect(this.musicGain);
      await new Promise<void>((resolve, reject) => {
        // 损坏文件或设备可能既不报 error 也不完成 canplay；限制一次准备等待，
        // 失败停在原阶段，由教师重试，不能把永不结束的加载当成可上课。
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('背景音乐准备超过30秒，请检查声音设备后重试。'));
        }, 30_000);
        const cleanup = () => {
          clearTimeout(timeout);
          element.removeEventListener('canplay', ready);
          element.removeEventListener('error', failed);
          this.cancelMusicPreparation = null;
        };
        const ready = () => {
          cleanup();
          if (
            !Number.isFinite(element.duration) ||
            element.duration <= 0 ||
            Math.abs(element.duration * 1000 - asset.durationMs) > 250
          ) {
            reject(new Error('背景音乐实际时长与课件记录不符。'));
            return;
          }
          element.playbackRate = this.options.musicRate ?? 1;
          this.musicReady = true;
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error('背景音乐无法播放，请返回编辑检查音频。'));
        };
        this.cancelMusicPreparation = () => {
          cleanup();
          resolve();
        };
        element.addEventListener('canplay', ready);
        element.addEventListener('error', failed);
        this.musicUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
        element.src = this.musicUrl;
        element.load();
      });
    })()
      .catch((error: unknown) => {
        this.musicReady = false;
        this.musicError = error instanceof Error ? error : new Error('背景音乐准备失败。');
        // 元数据/解码失败也可能已经建好媒体节点与内存地址，重试前释放，防止
        // 一次次重试积累旧音乐或对象 URL；不影响同会话已经就绪的示范声音。
        this.musicSource?.disconnect();
        this.musicSource = null;
        this.music?.pause();
        this.music?.removeAttribute('src');
        this.music?.load();
        this.music = null;
        if (this.musicUrl) URL.revokeObjectURL(this.musicUrl);
        this.musicUrl = null;
        throw this.musicError;
      })
      .finally(() => {
        this.musicPreparation = null;
      });
    return this.musicPreparation;
  }

  /** 同一段自然推进复用源；导航／暂停后的源已停止，按目标拍位重建，无独立音乐计时器。 */
  private playSyncedMusic(cue: RuntimeCue<T>, offsetMs: number): void {
    const sync = this.options.musicSync;
    if (!sync || !this.syncBuffer || cue.musicPositionMs === undefined) {
      this.stopSyncedMusic();
      return;
    }
    const position = (cue.musicPositionMs + offsetMs) / 1000;
    const origin = this.context.currentTime - position;
    // 连续阶段的绝对映射保持不变，容忍一次 JS 阶段交接的亚毫秒时差。
    if (this.syncSource && this.syncOrigin !== null && Math.abs(origin - this.syncOrigin) < 0.03)
      return;
    this.stopSyncedMusic();
    const rate = this.options.musicRate ?? 1;
    // 校准始终保留原素材坐标；处理后的时间按倍率换算，课堂仍用同一设备时钟。
    let offset = sync.firstBeatMs / 1000 / rate + Math.max(0, position);
    const start = sync.loopStartMs / 1000 / rate,
      end = sync.loopEndMs / 1000 / rate;
    if (this.options.musicLoop && offset >= end)
      offset = start + ((offset - start) % (end - start));
    if (offset >= this.syncBuffer.duration)
      throw new Error('对拍音乐已用完，请设置有效循环区间或选择更长音乐。');
    const source = this.context.createBufferSource();
    source.buffer = this.syncBuffer;
    source.loop = this.options.musicLoop ?? true;
    if (source.loop) {
      source.loopStart = start;
      source.loopEnd = end;
    }
    source.connect(this.musicGain);
    source.onended = () => {
      source.disconnect();
      if (this.syncSource === source) {
        this.syncSource = null;
        this.syncOrigin = null;
      }
    };
    source.start(this.context.currentTime + Math.max(0, -position), offset);
    this.syncSource = source;
    this.syncOrigin = origin;
  }

  /** 停止一次性音源并断开节点；旧 onended 不能清除后来创建的新源。 */
  private stopSyncedMusic(): void {
    const source = this.syncSource;
    this.syncSource = null;
    this.syncOrigin = null;
    if (source) {
      source.stop();
      source.disconnect();
    }
  }

  private ensureMusic(): void {
    if (!this.music || !this.musicReady || !this.music.paused || this.music.ended) return;
    void this.music.play().catch(() => {
      if (!this.disposed) this.musicError = new Error('背景音乐被设备阻止，请检查后重试。');
    });
  }

  private stopVoice(): void {
    this.voices.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* 声源可能刚刚自然结束。 */
      }
      source.disconnect();
    });
    this.voices.clear();
  }

  private stopBeat(): void {
    this.beats.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* 已结束振荡器不再调度。 */
      }
      source.disconnect();
    });
    this.beats.clear();
  }
}
