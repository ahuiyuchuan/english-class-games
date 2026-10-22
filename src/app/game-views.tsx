/**
 * 游戏页面的组合边界。平台只传通用课件与材料，具体游戏适配器检查结构后
 * 才接入专属编辑页；课堂导出不导入本文件，避免携带桌面编辑器依赖。
 * @author ahui
 */
import type { ComponentType } from 'react';
import type { AssetMap, LessonDocument, TeachingEntry } from '../platform/types';
import type { DictionaryEntry } from '../platform/materials/types';
import type { TeacherPreferences } from '../platform/repository';
import type { WordBeatLesson } from '../games/word-beat/model';
import { validateWordBeatStructure } from '../games/word-beat/structure';
import { wordBeatGame } from '../platform/games';
import { Notice } from '../shared/ui';
import { Editor } from './Editor';
import { Wizard } from './Wizard';
import type { VoiceInfo } from '../platform/native';
import { WordBeatPreferencesEditor } from './WordBeatPreferencesEditor';
import { WordBeatReadOnlyResult } from '../games/word-beat/ReadOnlyResult';

/** 默认表单由游戏提供；公共设置只提交对应gameId的对象，不读取玩法专属字段。 */
export interface GamePreferencesEditorProps {
  /** 隐藏时保留编辑输入，但停止试听并拒绝迟到声音；默认可见。 */
  active?: boolean;
  value: Record<string, unknown>;
  voices: VoiceInfo[];
  /** 保存前由对应模块再次校验；成功保存才解决，失败拒绝并由公共设置页显示原因。 */
  onSave: (value: Record<string, unknown>) => Promise<void>;
  /** 当前输入与最近成功保存值是否不同；平台只处理离开保护，不读取游戏字段。 */
  onDraftChange?: (dirty: boolean) => void;
  busy: boolean;
}

/** 任务成果的公共只读入口；课件字段只由对应游戏适配器解释。 */
export interface GameReadonlyProps {
  lesson: LessonDocument;
  assets: AssetMap;
  onListen: (assetId: string) => void;
}

/** 所有编辑页共享的资料与导航；不要求游戏具备词数、BPM或时间轴。 */
export interface GameEditorProps {
  /** 默认可交互；公共任务课堂覆盖编辑器时为 false，保留草稿但停用编辑热键。 */
  active?: boolean;
  initial: LessonDocument;
  /** 列表快捷动作在编辑器完成加载后只消费一次，仍执行完整检查。 */
  initialAction?: 'preview' | 'export' | 'replace-materials';
  dictionary: DictionaryEntry[];
  commonWords: TeachingEntry[];
  assets: AssetMap;
  onAssets: (assets: AssetMap) => void;
  onExit: () => void;
  onRegisterFlush: (flush: (() => Promise<LessonDocument>) | null) => void;
  onSaveCommon: (entries: TeachingEntry[]) => void;
}

/** 制作入口的公共资料；具体设置和生成规则由注册页面处理。 */
export interface GameWizardProps {
  /** 页面离开时保留制作输入，隐藏的试听不得继续占用音频会话。 */
  active?: boolean;
  dictionary: DictionaryEntry[];
  commonWords: TeachingEntry[];
  preferences: TeacherPreferences;
  assets: AssetMap;
  initialEntries?: TeachingEntry[];
  onAssets: (assets: AssetMap) => void;
  onBack: () => void;
  onEdit: (lesson: LessonDocument) => void;
  onMaterial: (
    entries: TeachingEntry[],
    source: { name: string; original: string },
  ) => Promise<void>;
}

/** 类型收窄只发生在具体游戏适配器，坏结构不传给编辑器。 */
function WordBeatEditorView(props: GameEditorProps) {
  const problems = validateWordBeatStructure(props.initial);
  if (problems.length)
    return (
      <Notice tone="error">
        课件结构无法编辑：{problems[0].message}。原资料已保留，请重新导入完整课件包。
      </Notice>
    );
  return <Editor {...props} initial={props.initial as WordBeatLesson} />;
}

/** 原修订先经过玩法结构检查；损坏资料保留原件，不借用当前草稿假装成果快照。 */
function WordBeatReadonlyView(props: GameReadonlyProps) {
  const problems = validateWordBeatStructure(props.lesson);
  if (problems.length)
    return <Notice tone="error">原课件结构无法展示：{problems[0].message}。原资料已保留。</Notice>;
  return <WordBeatReadOnlyResult {...props} lesson={props.lesson as WordBeatLesson} />;
}

/** 同一游戏的编辑与制作页面一并注册，新增游戏不修改平台导航分支。 */
const views = new Map<
  string,
  {
    Editor: ComponentType<GameEditorProps>;
    Wizard: ComponentType<GameWizardProps>;
    PreferencesEditor?: ComponentType<GamePreferencesEditorProps>;
    ReadonlyLessonView?: ComponentType<GameReadonlyProps>;
  }
>([
  [
    wordBeatGame.id,
    {
      Editor: WordBeatEditorView,
      Wizard,
      PreferencesEditor: WordBeatPreferencesEditor,
      ReadonlyLessonView: WordBeatReadonlyView,
    },
  ],
]);

/** 未注册页面的模块仅能保留资料，平台不得用其他游戏的编辑器兜底。 */
export function getGameViews(gameId: string) {
  return views.get(gameId);
}
