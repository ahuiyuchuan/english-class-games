/**
 * 平台公共数据与游戏接口。教学内容以副本进入课件，素材保持不可变引用；
 * 平台不假定游戏使用节拍、轮数或学生评分。
 * @author ahui
 */
import type { ComponentType } from 'react';

/** 教师确认的教学条目；相同英文可以有不同义项及独立出现位置。 */
export interface TeachingEntry {
  id: string;
  english: string;
  meaning: string;
  partOfSpeech?: string;
  priority: boolean;
  tags?: string[];
  unit?: string;
  entryType?: 'word' | 'phrase';
  source?: {
    name: string;
    original?: string;
    line?: number;
    position?: number;
    /** 阅读整理使用的实际规则与词库版本；历史材料缺省，不按当前版本补造。 */
    analysis?: MaterialAnalysis;
  };
  /** 教师明确接受的词库义项来源；与原材料的位置分开，保留内容依据及版本。 */
  meaningSource?: {
    name: string;
    version: string;
    english: string;
    originalMeaning?: string;
    originalPartOfSpeech?: string;
    teacherRevised?: boolean;
    /** 原候选的词库校对快照；省略表示历史未知，不随教师接受或改写升级。 */
    reviewStatus?: 'reviewed-sense' | 'reference';
    /** 本次候选来自基础词库还是教师常用词；不替代原词库名称与版本。 */
    candidateSource?: 'dictionary' | 'common';
    /** 本次明确接受时实际写入的教学字段；旧资料省略时不得推算补全数。 */
    acceptedFields?: ('meaning' | 'partOfSpeech')[];
  };
  confirmed?: boolean;
}

/** 本地阅读整理的依据快照；仅描述候选形成方式，不代表系统已经判断词义或学情。 */
export interface MaterialAnalysis {
  ruleId: 'platform.material.match';
  ruleVersion: number;
  functionWordsVersion: number;
  dictionaryVersions: { name: string; version: string }[];
}

/** 已检查的不可变音频元信息。dataUrl 供离线/浏览器使用，path 仅供桌面适配。 */
export interface AudioAsset {
  assetId: string;
  /** 资源库用途；旧课件包可省略，不据此替代解码及引用检查。 */
  kind?: 'speech' | 'recording' | 'music';
  mimeType: string;
  byteLength: number;
  durationMs: number;
  /** 实解码采样元信息；旧包可省略，课堂仍按实际AudioBuffer复核内存预算。 */
  sampleRate?: number;
  channels?: number;
  frameCount?: number;
  sha256: string;
  dataUrl?: string;
  path?: string;
  name?: string;
}

/** 所有运行、检查与导出统一按标识获取素材，不能按文件名推断关联。 */
export type AssetMap = Record<string, AudioAsset>;

/** 游戏恢复固定修订成果所需的公共信息，不要求结果具备词数、节拍或学生评分。 */
export interface AudioTaskResult {
  lessonId?: string;
  inputRevision?: number;
  results: readonly { objectId: string; asset: AudioAsset }[];
}

/** 声音绑定保存实际合成依赖；录音仅依赖确认文本，不随系统音色变更。 */
export interface AudioBinding {
  source: 'system' | 'recording';
  assetId?: string;
  text: string;
  language: 'en-US' | 'zh-CN';
  voiceId?: string;
  rate: number;
  status: 'ready' | 'stale' | 'missing';
  environment?: string;
  generatorVersion?: number;
}

/** 规则或手工值同时保留来源和锁定，恢复预设时不能暗改教师输入。 */
export interface RuleValue<T> {
  value: T;
  source: 'preset' | 'manual';
  locked: boolean;
}

/** 未完成输入单独保存；检查时必须处理这些错误，不能退回最近合法值上课。 */
export interface DraftInput {
  raw: string;
  message: string;
  objectId?: string;
}

/** 每个课件版本是自包含内容副本。不可运行输入可保存，但不能通过准备检查。 */
export interface LessonDocument<T = unknown> {
  id: string;
  name: string;
  gameId: string;
  revision: number;
  dataVersion: number;
  gameData: T;
  createdAt: string;
  updatedAt: string;
  draftInputs?: Record<string, DraftInput>;
  sourceLesson?: { id: string; revision: number };
  preparedRevision?: number | null;
}

/** 同一检查结果用于问题定位、运行门禁及导出，不在各入口分写规则。 */
export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  objectId?: string;
  field?: string;
  kind?: 'invalid' | 'missing' | 'stale' | 'asset';
}

/** 合成请求只声明真实需要的文本与参数，不包含假音频或预计音频时长。 */
export interface AudioRequest {
  requestId: string;
  objectId: string;
  text: string;
  language: 'en-US' | 'zh-CN';
  voiceId?: string;
  rate: number;
}

/** 运行组件由具体游戏提供，桌面和 HTML 只替换素材读取适配。 */
export interface ClassroomProps<T = unknown> {
  lesson: LessonDocument<T>;
  assets: AssetMap;
  resolveAsset?: (asset: AudioAsset) => Promise<ArrayBuffer>;
  onExit?: () => void;
  /** 平台可改名旧任务只读预演的退出入口；未提供时桌面显示“返回编辑”。 */
  exitLabel?: string;
  exportedAt?: string;
}

/** 平台根据能力显示动作，不能按游戏名称给某个模块开例外。 */
export interface GameCapabilities {
  preview: boolean;
  portable: boolean;
  navigate: boolean;
  repeat: boolean;
  tempo: boolean;
  display: boolean;
}

/** 游戏自行生成列表摘要；不适用的指标省略，不由平台猜测专属数据。 */
export interface GameSummary {
  itemCount?: number;
  itemLabel?: string;
  durationMs?: number;
  preparationState?: 'draft' | 'pending' | 'stale' | 'repair' | 'ready';
}

/** 普通复制的公共选项；业务对象身份由游戏负责重建，不修改包内修订关系。 */
export interface GameCopyOptions {
  name?: string;
  idFactory?: () => string;
}

/**
 * 游戏明确声明可重建的身份与引用，路径使用 RFC 6901 JSON Pointer。
 * 教学文本与来源不声明为引用；平台不得按字符串相同猜测需要替换。
 */
export interface GameIdentityLayout {
  identities: string[];
  references: string[];
  /**
   * 建议依赖保存为 JSON 字符串，只更新其中明确声明的内部引用。
   * references 中的空指针表示整个解码后的 JSON 值；外层 path 仍须定位游戏数据字段。
   */
  encodedReferences?: { path: string; references: string[] }[];
}

/** 导入声明绑定实际包摘要和全部修订，防止预览后文件被换成另一份内容。 */
export interface PackageIdentityPlan {
  lessonSha256: string;
  revisions: { revision: number; layout: GameIdentityLayout }[];
}

/** 内置游戏的统一注册描述；unknown 输入由游戏自己的检查器验证。 */
export interface GameModule<T = unknown, R = unknown> {
  id: string;
  name: string;
  description: string;
  dataVersion: number;
  moduleVersion: string;
  minimumPlatformVersion: string;
  materialTypes: string[];
  capabilities: GameCapabilities;
  /** 新课默认只由模块解释；平台按gameId隔离存储，不强制专属字段。 */
  getDefaultPreferences: () => Record<string, unknown>;
  /** 返回独立且补齐缺省的合法值；非法输入抛出可读错误，不静默写入。 */
  validatePreferences: (value: unknown) => Record<string, unknown>;
  /** 仅模块能认领旧版平铺偏好；无可认领字段时返回undefined。 */
  migrateLegacyPreferences?: (value: unknown) => Record<string, unknown> | undefined;
  /** 导入或恢复前检查容器及版本；允许教学草稿，拒绝会令编辑器崩溃的坏结构。 */
  validateStructure: (value: unknown) => ValidationIssue[];
  summarize?: (lesson: LessonDocument<T>, assets: AssetMap) => GameSummary;
  /** 双修订共用原生层映射；本模块只声明自己理解的身份及引用位置。 */
  describeIdentities: (lesson: LessonDocument<T>) => GameIdentityLayout;
  copy: (lesson: LessonDocument<T>, options?: GameCopyOptions) => LessonDocument<T>;
  create: (entries: TeachingEntry[], options?: Record<string, unknown>) => LessonDocument<T>;
  validate: (lesson: LessonDocument<T>, assets: AssetMap) => ValidationIssue[];
  compile: (lesson: LessonDocument<T>, assets: AssetMap) => R;
  requiredAssets: (lesson: LessonDocument<T>) => string[];
  /** 按当前课件用途区分需解码语音与按需音乐；不依赖素材旧包是否声明kind。 */
  assetRole: (lesson: LessonDocument<T>, assetId: string) => 'speech' | 'music';
  /** 仅恢复任务原修订的候选副本；平台只读展示，不自动写入当前草稿。 */
  restoreAudioTask?: (
    input: LessonDocument<T>,
    assets: AssetMap,
    task: AudioTaskResult,
  ) => { lesson: LessonDocument<T>; assets: AssetMap };
  Classroom: ComponentType<ClassroomProps<T>>;
}
