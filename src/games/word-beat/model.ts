/** 单词节拍独有的练习模型；规则来源、锁定及声音依赖都随修订保存。 @author ahui */
import type { AudioBinding, LessonDocument, RuleValue, TeachingEntry } from '../../platform/types';

/** 三种预设对应高中课堂的普通巩固、重点强化与限时回顾。 */
export type PresetId = 'regular' | 'focus' | 'quick';
export type SoundMode = 'voiced' | 'teacher' | 'chorus';
export type DisplayMode = 'centered' | 'blocks';
export type ProgressionMode = 'auto' | 'step';

/** 逐字段省略表示继承本课默认，指定音色不会同时冻结语速。 */
export interface VoiceOverrides {
  voiceId?: string;
  rate?: number;
}

/** 跟读为预设公式或教师固定拍数，拍数不是音节数。 */
export interface FollowRule {
  mode: 'preset' | 'manual';
  beats: number;
  locked: boolean;
  /** 公式所属预设独立保存，锁定后切全课预设不暗换公式。 */
  preset?: PresetId;
}

/** 每次出现均有独立ID；录音不因另一个同词条目存在而自动换绑。 */
export interface WordBeatEntry extends TeachingEntry {
  entryType: 'word' | 'phrase';
  entryTypeSource: 'preset' | 'manual';
  rounds: RuleValue<number>;
  follow: FollowRule;
  modelBeats: RuleValue<number>;
  /** 自主齐读独立参数；缺失表示旧课件默认 4／1，不覆盖其他模式。 */
  chorus?: { beats: RuleValue<number>; beatsPerRead: RuleValue<number> };
  positionLocked: boolean;
  soundLocked: boolean;
  voiceOverrides?: VoiceOverrides;
  audio?: AudioBinding;
}

/** 空段可留在草稿，但运行编排完全跳过。 */
export interface WordBeatSegment {
  id: string;
  name: string;
  entries: WordBeatEntry[];
}

/** 口号处于独立阶段，文本可含明确允许的课件名/词数占位符。 */
export interface WordBeatSlogan {
  id: string;
  text: string;
  language: 'en-US' | 'zh-CN';
  enabled: boolean;
  locked: boolean;
  templateId?: string;
  /** 字段分别记录教师决定；旧数据缺失时不推断启用开关仍可智能覆盖。 */
  textSource?: 'template' | 'manual';
  enabledSource?: 'preset' | 'manual';
  audio?: AudioBinding;
}

/** 游戏配置是课堂会话的初始值；课堂调节不反写课件。 */
export interface WordBeatData {
  preset: PresetId;
  bpm: RuleValue<number>;
  targetDurationMs: number;
  soundMode: SoundMode;
  displayMode: DisplayMode;
  showMeaning: boolean;
  progression: ProgressionMode;
  loop: boolean;
  resumePreparationBeats: 0 | 2;
  beatEnabled: boolean;
  volumes: { voice: number; beat: number; music: number };
  /** 仅自主齐读使用的词间空拍，缺失为 0。 */
  chorusGapBeats?: number;
  music: {
    /** 普通伴奏倍率；对拍时由课堂 BPM／原始音乐 BPM 推导，不覆盖原始校准。 */
    playbackRate?: number;
    /** 默认保音高；false 明确允许音高随速度变化。 */
    preservePitch?: boolean;
    syncEnabled?: boolean;
    sync?: { bpm: number; firstBeatMs: number; loopStartMs: number; loopEndMs: number };
    enabled: boolean;
    assetId?: string;
    loop: boolean;
  };
  voices: {
    englishVoiceId?: string;
    chineseVoiceId?: string;
    englishRate: number;
    chineseRate: number;
  };
  segments: WordBeatSegment[];
  slogans: { opening: WordBeatSlogan; transition: WordBeatSlogan; closing: WordBeatSlogan };
  ruleVersion: number;
  templateVersion: number;
  seed: number;
  /** 建议依据及教师决定随课件保存；历史项不参与课堂计时。 */
  suggestionHistory?: WordBeatSuggestion[];
}

export type WordBeatLesson = LessonDocument<WordBeatData>;

/** 默认值创建选项；声音首次默认开启，不为省事将产品默认为无配音。 */
export interface CreateWordBeatOptions {
  name?: string;
  preset?: PresetId;
  soundMode?: SoundMode;
  progression?: ProgressionMode;
  seed?: number;
  now?: string;
  idFactory?: () => string;
}

/** 按稳定路径定位差异，应用时逐项比较旧值与依赖，保护并发编辑。 */
export interface WordBeatChange {
  path: string;
  before: unknown;
  after: unknown;
  objectId?: string;
  reason: string;
}

/** 建议不是自动编辑；只有显式应用且依赖未变时才能修改草稿。 */
export interface WordBeatSuggestion {
  id: string;
  ruleId: string;
  inputRevision: number;
  kind: 'time' | 'remix' | 'preset';
  title: string;
  reason: string;
  changes: WordBeatChange[];
  dependencies: Record<string, string>;
  beforeDurationMs?: number;
  afterDurationMs?: number;
  state: 'available' | 'applied' | 'ignored' | 'stale';
}
