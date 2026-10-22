/** 通用运行协议，不把BPM、英语词条或评分设为平台必填字段。 @author ahui */

/** 游戏编排出来的阶段；navigation 将非条目阶段的动作语义交给游戏。 */
export interface RuntimeCue<T = unknown> {
  id: string;
  kind: string;
  startMs: number;
  durationMs: number;
  itemIndex: number | null;
  sectionIndex: number | null;
  round?: number;
  audioAssetId?: string;
  pulseIntervalMs?: number;
  /** 可选的音乐网格位置（毫秒），缺省表示此阶段不启动对拍音乐。 */
  musicPositionMs?: number;
  navigation: { previous: number | null; next: number | null; repeat: number | null };
  data: T;
}

/** 每个条目的范围用于切换和逐项等待；时间来自游戏自己的编排器。 */
export interface RuntimeItem {
  id: string;
  sectionIndex: number;
  firstCue: number;
  lastCue: number;
}

/** 已检查的固定版本运行安排。 */
export interface RuntimeTimeline<T = unknown> {
  cues: RuntimeCue<T>[];
  items: RuntimeItem[];
  durationMs: number;
  /** 可选恢复提示模板；不计编排时长，仅从播放暂停恢复时插入。 */
  resumeCue?: RuntimeCue<T>;
}

export type RuntimeStatus =
  'idle' | 'preparing' | 'running' | 'paused' | 'waiting' | 'completed' | 'error';

/** 运行状态是当前会话，不回写原始课件或便携文件。 */
export interface RuntimeState {
  status: RuntimeStatus;
  /** 首个阶段真正发声/运行后才为真；首次资源失败与准备仍属于开始页。 */
  hasStarted: boolean;
  cueIndex: number;
  elapsedInCueMs: number;
  actualElapsedMs: number;
  mode: 'auto' | 'step';
  loop: boolean;
  repeats: number;
  completedItems: number;
  /** 正常完成与教师主动提前结束分开，不能将结束按钮包装为练习完成。 */
  completionReason?: 'finished' | 'ended';
  /** 运行中等资源后不自行发声；就绪后显示由教师继续的明确状态。 */
  resourceReady?: boolean;
  error?: string;
}

/** 声音适配与游戏逻辑隔离，测试可注入真实语义的可控时钟驱动。 */
export interface RuntimeAudioDriver<T = unknown> {
  now: () => number;
  prepare: (timeline: RuntimeTimeline<T>, cueIndex: number) => Promise<void>;
  isPrepared?: (cue: RuntimeCue<T>) => boolean;
  play: (cue: RuntimeCue<T>, offsetMs: number) => void;
  pause: () => void;
  stop: () => void;
  tick?: (cue: RuntimeCue<T>, offsetMs: number) => void;
  dispose?: () => void;
}
