/**
 * 游戏无关的时间轴控制器。阶段时间由音频驱动的单调时钟读取，
 * 不依靠 setInterval 次数累加；所有异步准备均有代次保护。
 * @author ahui
 */
import type { RuntimeAudioDriver, RuntimeCue, RuntimeState, RuntimeTimeline } from './types';

/** 控制器事件返回独立状态，订阅者不能直接修改内部进度。 */
export type RuntimeListener = (state: RuntimeState) => void;

/** 课堂时间轴状态机，具体阶段名称与导航目标由游戏编排给出。 */
export class TimelineController<T = unknown> {
  private timeline: RuntimeTimeline<T>;
  private readonly audio: RuntimeAudioDriver<T>;
  private listeners = new Set<RuntimeListener>();
  private state: RuntimeState;
  private cueStartedAt = 0;
  private startedAt: number | null = null;
  private generation = 0;
  private disposed = false;
  private requestedMode: 'auto' | 'step';
  private pausedOrigin: 'running' | 'waiting' | 'preparing' = 'running';
  private pendingTimeline: RuntimeTimeline<T> | null = null;
  private completedIds = new Set<string>();
  private resumeCue: RuntimeCue<T> | null = null;
  private resumeTarget: { index: number; offsetMs: number } | null = null;
  private readonly wallNow: () => number;

  /**
   * @param timeline 已检查的安排；空安排不能开始。
   * @param audio 真正的声音适配或测试时钟，生命周期独占于此会话。
   * @param options 初始控制参数；wallNow 为包括暂停/等待的实际时间时钟。
   */
  constructor(
    timeline: RuntimeTimeline<T>,
    audio: RuntimeAudioDriver<T>,
    options: { mode?: 'auto' | 'step'; loop?: boolean; wallNow?: () => number } = {},
  ) {
    this.timeline = timeline;
    this.audio = audio;
    this.requestedMode = options.mode ?? 'auto';
    this.wallNow = options.wallNow ?? (() => performance.now());
    this.state = {
      status: 'idle',
      hasStarted: false,
      cueIndex: 0,
      elapsedInCueMs: 0,
      actualElapsedMs: 0,
      mode: this.requestedMode,
      loop: options.loop ?? false,
      repeats: 0,
      completedItems: 0,
    };
  }

  /** 获取独立的当前会话状态，不含学生评分。 */
  getState(): RuntimeState {
    return { ...this.state };
  }

  /** 取得当前固定时间轴；用于画面读取，不允许调用方修改。 */
  getTimeline(): RuntimeTimeline<T> {
    return this.timeline;
  }

  /** 当前显示/播放的阶段；可选恢复提示不改动固定课件时间轴。 */
  getActiveCue(): RuntimeCue<T> | undefined {
    return this.resumeCue ?? this.timeline.cues[this.state.cueIndex];
  }

  /** 订阅后立即接收当前状态，返回释放函数，避免重复进入课堂积累订阅。 */
  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 由用户手势触发；重复开始不叠加会话，重播清空本次计数。 */
  async start(): Promise<void> {
    if (this.disposed || !this.timeline.items.length || !this.timeline.cues.length) {
      if (!this.disposed) this.fail('当前没有可运行条目。');
      return;
    }
    if (['running', 'preparing', 'waiting', 'paused'].includes(this.state.status)) return;
    this.installPending();
    // 第一次资源准备不是课堂用时；只有首个阶段实际开播后才启动计时。
    this.startedAt = null;
    this.completedIds.clear();
    this.resumeCue = null;
    this.resumeTarget = null;
    this.state = {
      ...this.state,
      hasStarted: false,
      repeats: 0,
      completedItems: 0,
      actualElapsedMs: 0,
      error: undefined,
      completionReason: undefined,
      resourceReady: false,
    };
    await this.enter(0, 0, false);
  }

  /** 同步暂停所有声部；等待时也保留等待来源，恢复不多推进一次。 */
  pause(): void {
    if (!['running', 'waiting', 'preparing'].includes(this.state.status)) return;
    if (!this.state.hasStarted) {
      // 初次准备被失焦/隐藏打断时回到开始页。迟到的资源不会偷偷开播，
      // 教师再次点击开始即可重试，不产生尚未开课的“已暂停”会话。
      this.generation += 1;
      this.audio.pause();
      this.state.status = 'idle';
      this.state.elapsedInCueMs = 0;
      this.emit();
      return;
    }
    if (this.state.status === 'running')
      this.state.elapsedInCueMs = Math.max(0, this.audio.now() - this.cueStartedAt);
    this.pausedOrigin =
      this.state.status === 'waiting'
        ? 'waiting'
        : this.state.status === 'preparing'
          ? 'preparing'
          : 'running';
    this.generation += 1;
    this.audio.pause();
    this.state.status = 'paused';
    this.emit();
  }

  /** 继续按当前模式恢复；等待后切自动仍沿原编排播放转场与准备。 */
  async resume(): Promise<void> {
    if (this.state.status !== 'paused') return;
    if (this.state.resourceReady) {
      this.state.resourceReady = false;
      await this.enter(this.state.cueIndex, 0, false);
      return;
    }
    // 资源等待不是教学练习，恢复该等待不插入“恢复两拍”或重播之前的声音。
    if (this.pausedOrigin === 'preparing') {
      this.pausedOrigin = 'running';
      await this.enter(this.state.cueIndex, 0, false);
      return;
    }
    if (this.pausedOrigin === 'waiting') {
      if (this.requestedMode === 'step') {
        this.state.status = 'waiting';
        this.emit();
        return;
      }
      this.state.status = 'waiting';
      await this.continueAfterItem();
      return;
    }
    // 恢复准备期间再次暂停，只续完剩余提示，不无限重复插入两拍。
    if (this.resumeCue) {
      await this.activateCue(this.resumeCue, this.state.elapsedInCueMs, false);
      return;
    }
    const template = this.timeline.resumeCue;
    if (template && template.durationMs > 0) {
      this.resumeTarget = { index: this.state.cueIndex, offsetMs: this.state.elapsedInCueMs };
      this.resumeCue = {
        ...template,
        navigation: { ...this.timeline.cues[this.state.cueIndex].navigation },
      };
      await this.activateCue(this.resumeCue, 0, false);
      return;
    }
    await this.enter(this.state.cueIndex, this.state.elapsedInCueMs, false);
  }

  /** 主动作与空格共用：暂停优先恢复；等待推进；播放则暂停。 */
  async toggle(): Promise<void> {
    if (this.state.status === 'paused') await this.resume();
    else if (this.state.status === 'waiting') await this.continueAfterItem();
    else if (this.state.status === 'running' || this.state.status === 'preparing') this.pause();
    else if (this.state.status === 'error') await this.retry();
    else await this.start();
  }

  /** 播放中的模式变化到本条结束生效；暂停仅记录，不自行发声。 */
  setMode(mode: 'auto' | 'step'): void {
    this.requestedMode = mode;
    this.state.mode = mode;
    if (this.state.status === 'waiting' && mode === 'auto') void this.continueAfterItem();
    else this.emit();
  }

  /** 整课循环由首尾阶段自然完成后执行，不叠加旧声源。 */
  setLoop(loop: boolean): void {
    this.state.loop = loop;
    this.emit();
  }

  /** 上一条遵循当前阶段声明的目标，暂停定位后保持暂停。 */
  async previous(): Promise<void> {
    await this.navigate('previous');
  }

  /** 下一条遵循当前阶段声明的目标；等待时立即开始目标条目。 */
  async next(): Promise<void> {
    await this.navigate('next');
  }

  /** 重读仅对阶段允许的条目可用；非条目阶段无重读动作。 */
  async repeat(): Promise<void> {
    if (this.disposed || !this.state.hasStarted || this.state.status === 'completed') return;
    const cue = this.timeline.cues[this.state.cueIndex];
    if (cue?.navigation.repeat === null || cue?.navigation.repeat === undefined) return;
    this.state.repeats += 1;
    await this.navigate('repeat');
  }

  /**
   * 安装由具体游戏校验的新时间轴。播放、准备和逐项等待均到另一条目才切换，
   * 重读当前条目仍沿用原安排；暂停则保留条目、轮次和阶段并定位阶段开头。
   * @param timeline 同一条目集合、已由游戏校验的新编排，不能改变条目顺序。
   * @param atNextItem 内容／结构调整设为 true，暂停时也等到另一条目或重玩再安装，保留当前条目。
   */
  replaceTimeline(timeline: RuntimeTimeline<T>, atNextItem = false): void {
    if (
      timeline.items.length !== this.timeline.items.length ||
      !timeline.items.every((item, index) => item.id === this.timeline.items[index].id)
    )
      throw new Error('运行中不能替换教学条目。');
    // 轮数等结构调整不能在暂停时删除当前阶段。显式要求条目边界时保留当前词，
    // 下一词、跨词导航或重玩再安装；默认行为仍兼容原先的暂停调速。
    if (
      ['running', 'preparing', 'waiting'].includes(this.state.status) ||
      (atNextItem && this.state.hasStarted && this.state.status !== 'completed')
    ) {
      this.pendingTimeline = timeline;
      this.emit();
      return;
    }
    const previous = this.timeline.cues[this.state.cueIndex];
    this.timeline = timeline;
    this.pendingTimeline = null;
    this.resumeCue = null;
    this.resumeTarget = null;
    const index = timeline.cues.findIndex((cue) => cue.id === previous?.id);
    this.state.cueIndex = Math.max(0, index);
    this.state.elapsedInCueMs = 0;
    this.emit();
  }

  /** 立即释放声音和待执行准备；结束结果包括暂停与逐词等待。 */
  end(reason: 'finished' | 'ended' = 'ended'): void {
    this.generation += 1;
    this.audio.stop();
    this.resumeCue = null;
    this.resumeTarget = null;
    this.updateActual();
    this.state.status = 'completed';
    this.state.completionReason = reason;
    this.emit();
  }

  /** 音画错误暂停于当前位置，重试由教师主动发起。 */
  fail(message: string): void {
    if (this.state.status === 'running')
      this.state.elapsedInCueMs = Math.max(0, this.audio.now() - this.cueStartedAt);
    this.generation += 1;
    this.audio.pause();
    this.state.status = 'error';
    this.state.error = message;
    this.emit();
  }

  /** 主动修复后从失败阶段起点重试；不重播已完成阶段或自动恢复声音。 */
  async retry(): Promise<void> {
    if (this.state.status !== 'error') return;
    if (!this.state.hasStarted) {
      await this.start();
      return;
    }
    this.state.error = undefined;
    if (this.resumeCue) await this.activateCue(this.resumeCue, 0, false);
    else await this.enter(this.state.cueIndex, 0, false);
  }

  /**
   * 画面帧调用时读取同一音频时钟；即使某帧延后也按实际位置推进，
   * 不把漏掉的定时器次数当作教学进度。
   */
  tick(): void {
    this.updateActual();
    if (this.state.status !== 'running') {
      if (['waiting', 'paused', 'error'].includes(this.state.status)) this.emit();
      return;
    }
    const cue = this.getActiveCue();
    if (!cue) {
      this.end('finished');
      return;
    }
    const offset = Math.max(0, this.audio.now() - this.cueStartedAt);
    this.state.elapsedInCueMs = Math.min(offset, cue.durationMs);
    try {
      this.audio.tick?.(cue, this.state.elapsedInCueMs);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '声音调度失败，请检查后重试。');
      return;
    }
    if (offset >= cue.durationMs) {
      if (this.resumeCue && this.resumeTarget) {
        const target = this.resumeTarget;
        // 这是课堂临时提示，完成后恢复原偏移，不计完成词数或编排时长。
        this.resumeCue = null;
        this.resumeTarget = null;
        void this.enter(target.index, target.offsetMs, false);
        return;
      }
      const item = cue.itemIndex === null ? undefined : this.timeline.items[cue.itemIndex];
      const itemFinished = item?.lastCue === this.state.cueIndex;
      if (itemFinished && item) {
        this.completedIds.add(item.id);
        this.state.completedItems = this.completedIds.size;
        if (this.requestedMode === 'step' && cue.itemIndex! < this.timeline.items.length - 1) {
          this.audio.pause();
          this.state.status = 'waiting';
          this.emit();
          return;
        }
      }
      if (this.state.cueIndex + 1 >= this.timeline.cues.length) {
        if (this.state.loop) {
          this.audio.stop();
          this.installPending();
          void this.enter(0, 0, false);
          return;
        }
        this.end('finished');
        return;
      }
      const nextIndex = this.state.cueIndex + 1;
      // 计划边界处只提前解码；阶段切换重新读取音频时钟，声音与画面同步。
      void this.enter(nextIndex, Math.max(0, offset - cue.durationMs), false, true);
      return;
    }
    this.emit();
  }

  /** 离开课堂必须调用，终止异步结果及设备资源。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.audio.stop();
    this.audio.dispose?.();
    this.listeners.clear();
  }

  private installPending(): void {
    if (!this.pendingTimeline) return;
    const id = this.timeline.cues[this.state.cueIndex]?.id;
    this.timeline = this.pendingTimeline;
    this.pendingTimeline = null;
    const found = this.timeline.cues.findIndex((cue) => cue.id === id);
    if (found >= 0) this.state.cueIndex = found;
  }

  private async navigate(action: 'previous' | 'next' | 'repeat'): Promise<void> {
    if (this.disposed || !this.state.hasStarted || this.state.status === 'completed') return;
    const cue = this.timeline.cues[this.state.cueIndex];
    const target = cue?.navigation[action];
    if (target === null || target === undefined) return;
    const paused = this.state.status === 'paused';
    // 待生效安排属于下一条目；重读或导航回当前条目不能改变本条时间。
    if (target !== cue.itemIndex) this.installPending();
    const index = this.timeline.items[target]?.firstCue;
    if (index !== undefined) {
      this.pausedOrigin = 'running';
      this.resumeCue = null;
      this.resumeTarget = null;
      await this.enter(index, 0, paused);
    }
  }

  /**
   * 等待后的自然继续与直接导航分别处理：只进入紧邻阶段，保留已经确认的
   * 转场、段间口号和后续段准备；next() 则按游戏声明直接定位下一条首轮。
   */
  private async continueAfterItem(): Promise<void> {
    if (this.disposed || this.state.status !== 'waiting') return;
    await this.enter(this.state.cueIndex + 1, 0, false);
  }

  private async enter(
    index: number,
    offsetMs: number,
    paused: boolean,
    continuous = false,
  ): Promise<void> {
    if (this.disposed) return;
    const target = this.timeline.cues[index];
    if (
      this.pendingTimeline &&
      target?.itemIndex !== null &&
      target?.itemIndex !== undefined &&
      target.itemIndex !== this.timeline.cues[this.state.cueIndex]?.itemIndex &&
      this.timeline.items[target.itemIndex]?.firstCue === index
    ) {
      // 前项轮数改变后，全局阶段序号会移位，相同 cue ID 可能已属于另一轮或条目。
      // replaceTimeline 已约束条目 ID 与顺序不变，因此按目标条目索引进入新首阶段；
      // 只在正式条目边界安装，之前已走过的空拍、段间口号和准备不会重播或跳过。
      const itemIndex = target.itemIndex;
      this.installPending();
      index = this.timeline.items[itemIndex].firstCue;
    }
    const cue = this.timeline.cues[index];
    if (!cue) {
      this.end('finished');
      return;
    }
    this.state.cueIndex = index;
    await this.activateCue(cue, offsetMs, paused, continuous);
  }

  /** 固定阶段与临时恢复提示共用一套代次和音频准备，避免抢播。 */
  private async activateCue(
    cue: RuntimeCue<T>,
    offsetMs: number,
    paused: boolean,
    continuous = false,
  ): Promise<void> {
    const generation = ++this.generation;
    const continuousStart = continuous ? this.audio.now() - offsetMs : null;
    // 首次点击开始允许准备后开播；课堂中缺资源则停在待播阶段，由教师确认继续。
    const initial = !this.state.hasStarted;
    const waitForTeacher = !initial && !paused && this.audio.isPrepared?.(cue) === false;
    if (waitForTeacher) offsetMs = 0;
    // 已就绪的自然边界不能等待 resume()/微任务再切画面，否则首拍会因设备响应而迟到。
    // 当前声音已经验证可播；下一窗口仍后台准备，失败只允许当前代次报告。
    if (continuous && !paused && this.audio.isPrepared?.(cue) === true) {
      try {
        this.cueStartedAt = continuousStart!;
        this.audio.play(cue, Math.max(0, this.audio.now() - this.cueStartedAt));
        this.state.elapsedInCueMs = offsetMs;
        this.state.status = 'running';
        void this.audio.prepare(this.timeline, this.state.cueIndex).catch((error: unknown) => {
          if (generation === this.generation && !this.disposed)
            this.fail(error instanceof Error ? error.message : '声音准备失败。');
        });
        this.emit();
      } catch (error) {
        this.fail(error instanceof Error ? error.message : '声音调度失败。');
      }
      return;
    }
    // 自然且资源就绪的边界不暂停音乐；导航与真实资源等待仍同步停止所有声部。
    if (!continuous || this.audio.isPrepared?.(cue) !== true) this.audio.pause();
    this.state.elapsedInCueMs = offsetMs;
    this.state.error = undefined;
    this.state.resourceReady = false;
    this.state.status = paused ? 'paused' : 'preparing';
    this.emit();
    try {
      await this.audio.prepare(this.timeline, this.state.cueIndex);
      if (generation !== this.generation || this.disposed) return;
      if (paused || waitForTeacher) {
        this.state.status = 'paused';
        this.state.resourceReady = waitForTeacher;
        this.emit();
        return;
      }
      this.cueStartedAt = continuousStart ?? this.audio.now() - offsetMs;
      this.audio.play(cue, Math.max(0, this.audio.now() - this.cueStartedAt));
      if (this.startedAt === null) this.startedAt = this.wallNow();
      this.state.hasStarted = true;
      this.state.status = 'running';
      this.emit();
    } catch (error) {
      if (generation === this.generation && !this.disposed)
        this.fail(error instanceof Error ? error.message : '声音准备失败，请检查后重试。');
    }
  }

  private updateActual(): void {
    if (this.startedAt !== null && this.state.status !== 'completed')
      this.state.actualElapsedMs = Math.max(0, this.wallNow() - this.startedAt);
  }

  private emit(): void {
    this.updateActual();
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }
}
