import { TaskProgress } from '../shared/ui/TaskProgress';
/**
 * 首个游戏的完整备课编辑页。内容操作形成一次可撤销变更；保存、任务和准备状态
 * 分开显示，当前草稿必须通过同一检查入口才能预演、上课和导出。
 * @author ahui
 */
import { WORD_BEAT_HELP } from '../games/word-beat/settingHelp';
import { MusicCalibration } from './MusicCalibration';
import { LocalModelGoal } from './LocalModelGoal';
import { TimePlanning } from './TimePlanning';

import { MusicImportButton } from '../shared/ui/MusicImportButton';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowsDownUp,
  ArrowUDownLeft,
  ArrowUDownRight,
  DownloadSimple,
  Gear,
  Lock,
  Play,
  Plus,
  Sparkle,
  SpeakerHigh,
  Trash,
} from '@phosphor-icons/react';
import type { AssetMap, TeachingEntry } from '../platform/types';
import type { DictionaryEntry } from '../platform/materials/types';
import type {
  WordBeatData,
  WordBeatEntry,
  WordBeatLesson,
  WordBeatSuggestion,
} from '../games/word-beat/model';
import {
  audioMatches,
  bindRecording,
  compileWordBeat,
  createWordBeatEntry,
  getEntries,
  getAudioProductionSummary,
  getPreparationState,
  getVoiceSettings,
  isSloganManual,
  PRESETS,
  requiredAssets,
  resolveSloganText,
  setEntryPriority,
  setEntryType,
  validateWordBeat,
} from '../games/word-beat/rules';
import {
  applySuggestion,
  createTimeSuggestions,
  explainTimeSuggestions,
  createPresetSuggestion,
  isSuggestionCurrent,
  rememberSuggestion,
  ignoreSuggestion,
  getSuggestionHistory,
  remixLesson,
  replaceMaterials,
} from '../games/word-beat/suggestions';
import { WordBeatClassroom } from '../games/word-beat/Classroom';
import { BeatTrail, ClassroomAtmosphere } from '../games/word-beat/ClassroomVisuals';
import { WordBeatReadOnlyResult } from '../games/word-beat/ReadOnlyResult';
import {
  desktopAvailable,
  getLesson,
  markPrepared,
  readAssetData,
  saveLocalLessonCopy,
} from '../platform/repository';
import { produceLesson, productionFingerprint } from '../games/word-beat/production';
import * as native from '../platform/native';
import type { TaskRecord } from '../platform/native';
import { previewAudio, stopPreview, validatePlayableAssets } from '../platform/audio-preview';
import {
  Badge,
  Button,
  Check,
  Field,
  InputField,
  Modal,
  Notice,
  commitSingleLineOnEnter,
  errorMessage,
  useFeedback,
} from '../shared/ui';
import { useEditor } from './useEditor';
import { useDiscardGuard } from '../shared/ui/useDiscardGuard';
import { ImportPanel } from './ImportPanel';
import { LessonExportDialog } from './LessonExportDialog';
import { VoiceFields } from './Wizard';
import { applyEntryBatch } from './editor-actions';
import type { BatchInputs } from './editor-actions';
import { countConfirmedFields } from '../shared/ai/completion-summary';
import { TeachingContent } from '../shared/ui/TeachingContent';
import { validateTeachingEntry } from '../platform/materials/parser';
import { TeachingEntrySource, TeachingTagsField } from './TeachingEntryFields';
import './creation-studio.css';

const STATE_LABEL = {
  draft: '草稿',
  pending: '声音待制作',
  stale: '声音需更新',
  repair: '需修复',
  ready: '可上课',
};
const PURPOSE_LABEL = { opening: '开场口号', transition: '段间口号', closing: '收尾口号' };

/** 显示选择范围内的实际共同值；混合值返回 undefined，不将展示值当成待写入值。 */
function commonValue(entries: WordBeatEntry[], read: (entry: WordBeatEntry) => string) {
  const values = entries.map(read);
  return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/** 差异必须同时交代受保护对象，避免教师只能看到修改项却无法确认手改内容是否保留。 */
function protectedValues(lesson: WordBeatLesson, suggestion: WordBeatSuggestion): string[] {
  const values: string[] = [];
  const restoring =
    suggestion.kind === 'preset' ||
    suggestion.changes.some((change) => /\.(bpm|rounds|follow|modelBeats)$/u.test(change.path));
  const reason = (manual: boolean, locked: boolean) =>
    [manual && '教师手动', locked && '已锁定'].filter(Boolean).join('、');
  if (restoring) {
    const bpm = lesson.gameData.bpm;
    if (
      (bpm.locked || bpm.source === 'manual') &&
      !suggestion.changes.some((change) => change.path === 'gameData.bpm')
    )
      values.push(`全课节奏 ${bpm.value} BPM（${reason(bpm.source === 'manual', bpm.locked)}）`);
    for (const entry of getEntries(lesson)) {
      for (const [key, name, value, manual, locked] of [
        [
          'rounds',
          '轮数',
          `${entry.rounds.value} 轮`,
          entry.rounds.source === 'manual',
          entry.rounds.locked,
        ],
        [
          'follow',
          '跟读',
          humanValue('follow', entry.follow),
          entry.follow.mode === 'manual',
          entry.follow.locked,
        ],
        [
          'modelBeats',
          '教师示范',
          `${entry.modelBeats.value} 拍`,
          entry.modelBeats.source === 'manual',
          entry.modelBeats.locked,
        ],
      ] as const) {
        const path = suggestion.changes.some((change) => {
          if (change.objectId === entry.id && change.path.endsWith(`.${key}`)) return true;
          // 词序与参数同时改编时差异以完整段词表保存，不能把其中已改字段误报为保留。
          if (!change.path.endsWith('.entries') || !Array.isArray(change.after)) return false;
          const next = (change.after as WordBeatEntry[]).find((item) => item.id === entry.id);
          return next && JSON.stringify(next[key]) !== JSON.stringify(entry[key]);
        });
        if ((manual || locked) && !path)
          values.push(`${entry.english} · ${name} ${value}（${reason(manual, locked)}）`);
      }
    }
  }
  if (suggestion.kind === 'remix') {
    for (const [purpose, slogan] of Object.entries(lesson.gameData.slogans)) {
      if (!slogan.enabled || suggestion.changes.some((change) => change.objectId === slogan.id))
        continue;
      const manual = isSloganManual(slogan);
      if (manual || slogan.locked)
        values.push(
          `${PURPOSE_LABEL[purpose as keyof typeof PURPOSE_LABEL]}「${slogan.text}」（${reason(manual, slogan.locked)}）`,
        );
    }
    for (const entry of getEntries(lesson))
      if (entry.positionLocked) values.push(`${entry.english} · 位置已锁定`);
  }
  return values;
}

/** 将规则差异转成教师能核对的值，内部标识及随机标记不进入产品文案。 */
function humanValue(path: string, value: unknown): string {
  if (value === undefined || value === null) return '未设置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (Array.isArray(value))
    return value
      .map((item) =>
        item && typeof item === 'object' && 'english' in item ? String(item.english) : '条目',
      )
      .join(' → ');
  if (typeof value === 'object') {
    const rule = value as {
      value?: unknown;
      mode?: string;
      beats?: number;
      preset?: keyof typeof PRESETS;
    };
    if ('value' in rule) return humanValue(path, rule.value);
    if (rule.mode === 'manual') return `${rule.beats} 拍（教师固定）`;
    if (rule.mode === 'preset') return `${PRESETS[rule.preset ?? 'regular'].name}公式`;
    return '更新设置';
  }
  if (typeof value === 'number') {
    if (path.includes('rounds')) return `${value} 轮`;
    if (path.includes('bpm')) return `${value} BPM`;
    if (path.includes('Duration')) return `${(value / 1000).toFixed(1)} 秒`;
    if (path.includes('Beats') || path.includes('follow')) return `${value} 拍`;
  }
  if (path.endsWith('.preset') && typeof value === 'string' && value in PRESETS)
    return PRESETS[value as keyof typeof PRESETS].name;
  return String(value);
}

interface EditorProps {
  /** 公共成果课堂覆盖时停用编辑热键，草稿及撤销历史继续保留；默认启用。 */
  active?: boolean;
  initial: WordBeatLesson;
  initialAction?: 'preview' | 'export' | 'replace-materials';
  dictionary: DictionaryEntry[];
  commonWords: TeachingEntry[];
  assets: AssetMap;
  onAssets: (assets: AssetMap) => void;
  onExit: () => void;
  onRegisterFlush: (flush: (() => Promise<WordBeatLesson>) | null) => void;
  onSaveCommon: (entries: TeachingEntry[]) => void;
}

/** 每个字段无效原始字符串进入 draftInputs，不能借最近合法数值绕过运行检查。 */
export function Editor({
  active = true,
  initial,
  initialAction,
  dictionary,
  commonWords,
  assets,
  onAssets,
  onExit,
  onRegisterFlush,
  onSaveCommon,
}: EditorProps) {
  const editor = useEditor(initial);
  const { lesson, edit, flush, undo, redo } = editor;
  const [selectedId, setSelectedId] = useState(getEntries(initial)[0]?.id ?? '');
  const [checked, setChecked] = useState<string[]>([]);
  const [mobileTab, setMobileTab] = useState<'entries' | 'preview'>('entries');
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [wideProperties, setWideProperties] = useState(() => window.innerWidth >= 1280);
  const [compactEditor, setCompactEditor] = useState(() => window.innerWidth < 1000);
  const [assistantDrawer, setAssistantDrawer] = useState<'checks' | 'suggestions' | null>(null);
  const issueFocus = useRef<string>();
  const [issueFocusRequest, setIssueFocusRequest] = useState(0);
  const [importMode, setImportMode] = useState<'append' | 'replace' | null>(null);
  const [importDirty, setImportDirty] = useState(false);
  const [importApplying, setImportApplying] = useState(false);
  const importApplyOperation = useRef(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [classroom, setClassroom] = useState<WordBeatLesson | null>(null);
  const [task, setTask] = useState<TaskRecord>();
  const [oldResult, setOldResult] = useState<WordBeatLesson>();
  const [oldResultOpen, setOldResultOpen] = useState(false);
  const [usePreparedVersion, setUsePreparedVersion] = useState(false);
  const [deleteSegmentId, setDeleteSegmentId] = useState<string | null>(null);
  const [segmentDestination, setSegmentDestination] = useState('delete');
  const [draggedEntry, setDraggedEntry] = useState<string | null>(null);
  const focusNewEntry = useRef(false);
  const actionInFlight = useRef(false);
  const splitSaving = useRef(false);
  const navigationAction = useRef(initialAction);
  const mounted = useRef(true);
  const productionObserver = useRef<AbortController>();
  const [productionInput, setProductionInput] = useState<{
    lesson: WordBeatLesson;
    assets: AssetMap;
  }>();
  const [presetPreview, setPresetPreview] = useState<WordBeatSuggestion | null>(null);
  const [suggestions, setSuggestions] = useState<WordBeatSuggestion[]>([]);
  const [remixOpen, setRemixOpen] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [restore, setRestore] = useState(false);
  const [overrideManual, setOverrideManual] = useState(false);
  const [overrideManualSlogans, setOverrideManualSlogans] = useState(false);
  const [invalidRemixPreviews, setInvalidRemixPreviews] = useState<Set<string>>(() => new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState<BatchInputs>({});
  const [savedView, setSavedView] = useState<WordBeatLesson | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyName, setCopyName] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportKind, setExportKind] = useState<'html' | 'package'>('html');
  const lessonRef = useRef(lesson);
  lessonRef.current = lesson;
  const { confirm, notify } = useFeedback();
  const canDiscardImport = useDiscardGuard({
    dirty: !!importMode && importDirty,
    busy: importApplying,
    subject: '导入材料',
  });
  const canDiscardBatch = useDiscardGuard({
    dirty: batchOpen && Object.keys(batch).length > 0,
    subject: '批量参数',
  });
  const closeImport = async () => {
    if (importApplyOperation.current || !(await canDiscardImport())) return;
    setImportMode(null);
    setImportDirty(false);
  };
  const closeBatch = async () => {
    if (!(await canDiscardBatch())) return;
    setBatchOpen(false);
    setBatch({});
  };
  const queryClient = useQueryClient();
  const voices = useQuery({
    queryKey: ['voices'],
    queryFn: native.listVoices,
    enabled: desktopAvailable,
  });
  const entries = useMemo(() => getEntries(lesson), [lesson]);
  const selectedEntries = entries.filter((entry) => checked.includes(entry.id));
  // 展示当前共同值与本次教师指定值分离，未动过的字段绝不随整批应用被改成手动来源。
  const batchCurrent: BatchInputs = {
    rounds: commonValue(selectedEntries, (entry) =>
      rawBatchNumber(entry.id, 'rounds', entry.rounds.value),
    ),
    priority: commonValue(selectedEntries, (entry) => (entry.priority ? 'yes' : 'no')),
    entryType: commonValue(selectedEntries, (entry) => entry.entryType),
    followMode: commonValue(selectedEntries, (entry) => entry.follow.mode),
    followBeats: commonValue(selectedEntries, (entry) =>
      entry.follow.mode === 'manual' ? rawBatchNumber(entry.id, 'follow', entry.follow.beats) : '',
    ),
    chorusBeats: commonValue(selectedEntries, (entry) =>
      rawBatchNumber(entry.id, 'chorusBeats', entry.chorus?.beats.value ?? 4),
    ),
    chorusPerRead: commonValue(selectedEntries, (entry) =>
      rawBatchNumber(entry.id, 'chorusPerRead', entry.chorus?.beatsPerRead.value ?? 1),
    ),
    modelBeats: commonValue(selectedEntries, (entry) =>
      rawBatchNumber(entry.id, 'model', entry.modelBeats.value),
    ),
    voiceId: commonValue(
      selectedEntries.filter((entry) => entry.audio?.source !== 'recording'),
      (entry) => entry.voiceOverrides?.voiceId ?? 'inherit',
    ),
    rate: commonValue(
      selectedEntries.filter((entry) => entry.audio?.source !== 'recording'),
      (entry) =>
        entry.voiceOverrides?.rate === undefined ? 'inherit' : String(entry.voiceOverrides.rate),
    ),
    lockPosition: commonValue(selectedEntries, (entry) =>
      entry.positionLocked ? 'lock' : 'unlock',
    ),
    lockRounds: commonValue(selectedEntries, (entry) => (entry.rounds.locked ? 'lock' : 'unlock')),
    lockFollow: commonValue(selectedEntries, (entry) => (entry.follow.locked ? 'lock' : 'unlock')),
    lockModel: commonValue(selectedEntries, (entry) =>
      entry.modelBeats.locked ? 'lock' : 'unlock',
    ),
    lockChorusBeats: commonValue(selectedEntries, (entry) =>
      entry.chorus?.beats.locked ? 'lock' : 'unlock',
    ),
    lockChorusRead: commonValue(selectedEntries, (entry) =>
      entry.chorus?.beatsPerRead.locked ? 'lock' : 'unlock',
    ),
    lockSound: commonValue(selectedEntries, (entry) => (entry.soundLocked ? 'lock' : 'unlock')),
  };
  function rawBatchNumber(id: string, field: string, value: number) {
    return lesson.draftInputs?.[`${id}.${field}`]?.raw ?? String(value);
  }
  const current = entries.find((entry) => entry.id === selectedId);
  const contentError = (field: string) =>
    current
      ? validateTeachingEntry(current).find(
          (issue) => issue.severity === 'error' && issue.field === field,
        )?.message
      : undefined;
  const issues = validateWordBeat(lesson, assets);
  const state = getPreparationState(lesson, assets);
  let duration: number | undefined;
  try {
    duration = compileWordBeat(lesson, assets).durationMs;
  } catch {
    /* 未准备完整时不编造精确时长。 */
  }
  // 建议保存检查时的依赖快照。后续编辑只改变其有效性，不能每次渲染生成新建议。
  const [timeSuggestions, setTimeSuggestions] = useState(() =>
    createTimeSuggestions(initial, assets),
  );
  const suggestionHistory = getSuggestionHistory(lesson);
  const productionSummary = productionInput
    ? getAudioProductionSummary(productionInput.lesson, productionInput.assets, task?.results)
    : undefined;
  // 忽略只屏蔽依赖相同的建议；已处理历史继续可查看，但不重复提供应用按钮。
  const visibleSuggestions = [...suggestionHistory, ...suggestions, ...timeSuggestions].filter(
    (suggestion, index, all) =>
      all.findIndex(
        (other) =>
          other.id === suggestion.id ||
          (other.ruleId === suggestion.ruleId &&
            JSON.stringify(other.dependencies) === JSON.stringify(suggestion.dependencies)),
      ) === index,
  );

  useEffect(() => {
    if (selectedId && !entries.some((entry) => entry.id === selectedId))
      setSelectedId(entries[0]?.id ?? '');
    setChecked((previous) => previous.filter((id) => entries.some((entry) => entry.id === id)));
    if (focusNewEntry.current) {
      focusNewEntry.current = false;
      setPropertiesOpen(window.innerWidth < 1280);
      requestAnimationFrame(() => {
        const inputs = [
          ...document.querySelectorAll<HTMLInputElement>('input[aria-label="词条英文"]'),
        ];
        inputs.find((input) => input.getClientRects().length > 0)?.focus();
      });
    }
  }, [entries, selectedId]);

  useEffect(() => {
    const resize = () => {
      setWideProperties(window.innerWidth >= 1280);
      setCompactEditor(window.innerWidth < 1000);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!issueFocus.current) return;
    const target = issueFocus.current;
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById(target);
      input?.closest('details')?.setAttribute('open', '');
      input?.scrollIntoView?.({ block: 'nearest' });
      input?.focus();
      issueFocus.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, propertiesOpen, wideProperties, mobileTab, issueFocusRequest, lesson]);

  useEffect(() => {
    onRegisterFlush(async () => {
      if (splitSaving.current) throw new Error('正在保存拆分课件，请等待本次创建完成后离开。');
      // 保存课件不等于接受导入或批改表单，窗口关闭必须先保护这些尚未应用的输入。
      if ((importMode && !(await canDiscardImport())) || (batchOpen && !(await canDiscardBatch())))
        throw new DOMException('已保留未应用的输入。', 'AbortError');
      return flush();
    });
    return () => onRegisterFlush(null);
  }, [flush, onRegisterFlush, importMode, batchOpen, canDiscardImport, canDiscardBatch]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      productionObserver.current?.abort();
      stopPreview();
    };
  }, []);
  useEffect(() => {
    if (!classroom) return;
    const shell = document.querySelector<HTMLElement>('.shell');
    if (!shell) return;
    shell.inert = true;
    return () => {
      shell.inert = false;
    };
  }, [classroom]);
  useEffect(() => {
    // 课堂通过 portal 覆盖编辑器，但不会卸载编辑会话。进入课堂时移除编辑热键，
    // 防止游戏里的 Ctrl+Z/Y/S 穿透并修改后台草稿；退出后按原输入与弹窗规则恢复。
    if (!active || classroom) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || document.querySelector('[role="dialog"]')) return;
      const target = event.target as HTMLElement;
      const input = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void flush()
          .then(() => notify('课件已保存'))
          .catch((cause) => setError(errorMessage(cause)));
      }
      if (!input && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      }
      if (!input && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [active, classroom, undo, redo, flush, notify]);

  const attempt = async (label: string, action: () => Promise<void>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (mounted.current) {
        setError(errorMessage(cause));
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.error-summary')?.focus());
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy('');
    }
  };
  const patchData = (patch: Partial<WordBeatData>) =>
    edit((previous) => ({ ...previous, gameData: { ...previous.gameData, ...patch } }));
  const patchEntry = (id: string, change: (entry: WordBeatEntry) => void) =>
    edit((previous) => {
      const entry = getEntries(previous).find((item) => item.id === id);
      if (entry) change(entry);
      return previous;
    });
  const rawNumber = (key: string, value: number) => lesson.draftInputs?.[key]?.raw ?? String(value);
  const setNumber = (
    key: string,
    raw: string,
    min: number,
    max: number,
    setter: (document: WordBeatLesson, value: number) => void,
    objectId?: string,
    integer = true,
  ) =>
    edit((previous) => {
      const value = Number(raw);
      previous.draftInputs ??= {};
      if (
        !raw.trim() ||
        !Number.isFinite(value) ||
        (integer && !Number.isInteger(value)) ||
        value < min ||
        value > max
      )
        previous.draftInputs[key] = {
          raw,
          message: `请输入 ${min}～${max} 的${integer ? '整数' : '数值'}。`,
          objectId,
        };
      else {
        delete previous.draftInputs[key];
        setter(previous, value);
      }
      return previous;
    });

  const selectIssue = (id?: string, field?: string) => {
    // 从检查抽屉转入属性抽屉时只保留一个焦点范围，避免两层抽屉争抢目标字段。
    setAssistantDrawer(null);
    const suffix = field?.split('.').at(-1);
    const aliases: Record<string, string> = { modelBeats: 'model', targetDurationMs: 'target' };
    let key = aliases[suffix ?? ''] ?? suffix;
    const entry = entries.find((item) => item.id === id);
    if (key === 'follow' && entry?.follow.mode !== 'manual') key = 'followMode';
    issueFocus.current =
      id && entries.some((entry) => entry.id === id)
        ? `entry-${id}-${key ?? 'english'}`
        : id && Object.values(lesson.gameData.slogans).some((slogan) => slogan.id === id)
          ? `slogan-${id}`
          : `lesson-${key ?? 'bpm'}`;
    if (id && entries.some((entry) => entry.id === id)) {
      setSelectedId(id);
      setMobileTab('entries');
      if (!wideProperties) setPropertiesOpen(true);
    } else setMobileTab('preview');
    // 先让目标区域及抽屉完成渲染，再由 effect 聚焦；重复定位也产生独立请求。
    setIssueFocusRequest((value) => value + 1);
  };
  const removeEntries = async (ids: string[]) => {
    if (
      !(await confirm({
        title: '删除所选词条',
        message: `将从本课删除 ${ids.length} 条词汇，可在本次编辑会话中撤销。`,
        danger: true,
      }))
    )
      return;
    edit((previous) => {
      previous.gameData.segments.forEach((segment) => {
        segment.entries = segment.entries.filter((entry) => !ids.includes(entry.id));
      });
      if (previous.draftInputs)
        previous.draftInputs = Object.fromEntries(
          Object.entries(previous.draftInputs).filter(
            ([, input]) => !input.objectId || !ids.includes(input.objectId),
          ),
        );
      return previous;
    });
    setChecked([]);
  };

  const moveEntry = (id: string, direction: -1 | 1) =>
    edit((previous) => {
      for (const segment of previous.gameData.segments) {
        const position = segment.entries.findIndex((entry) => entry.id === id);
        if (position < 0) continue;
        const next = position + direction;
        if (next < 0 || next >= segment.entries.length) return previous;
        [segment.entries[position], segment.entries[next]] = [
          segment.entries[next],
          segment.entries[position],
        ];
      }
      return previous;
    });

  const importAudio = (objectId: string) =>
    attempt('导入录音', async () => {
      stopPreview();
      const file = await native.selectFile('audio');
      if (!file || !mounted.current) return;
      const asset = await native.importAudio(file.token, 'recording');
      if (!mounted.current) return;
      onAssets({ [asset.assetId]: asset });
      edit((previous) => bindRecording(previous, objectId, asset), 'separate');
    });

  const produce = () =>
    attempt('声音制作', async () => {
      stopPreview();
      const snapshot = await flush();
      if (!mounted.current) return;
      setProductionInput({ lesson: snapshot, assets: structuredClone(assets) });
      const fingerprint = productionFingerprint(snapshot);
      const retryOf =
        task && !['queued', 'running', 'cancelling'].includes(task.state) ? task.taskId : undefined;
      setTask(undefined);
      productionObserver.current?.abort();
      const observer = new AbortController();
      productionObserver.current = observer;
      const result = await produceLesson(
        snapshot,
        assets,
        (next) => {
          if (mounted.current) setTask(next);
        },
        retryOf,
        observer.signal,
      );
      if (!mounted.current) return;
      onAssets(result.assets);
      if (productionFingerprint(lessonRef.current) === fingerprint)
        edit({ ...result.lesson, revision: lessonRef.current.revision }, 'separate');
      else {
        setOldResult(result.lesson);
        notify('制作已结束，结果属于原版本；当前修改已保留。');
      }
      if (result.task?.failures.length)
        setError(`有 ${result.task.failures.length} 项声音未完成，请查看问题并重试。`);
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
    });

  const prepare = async (): Promise<{ prepared: WordBeatLesson; draft: WordBeatLesson }> => {
    stopPreview();
    const currentSnapshot = await flush();
    let snapshot = currentSnapshot;
    if (usePreparedVersion) {
      if (!currentSnapshot.preparedRevision) throw new Error('尚无已准备版本，请检查当前草稿。');
      snapshot = await getLesson<WordBeatData>(
        currentSnapshot.id,
        currentSnapshot.preparedRevision,
      );
      const previousEntries = getEntries(snapshot);
      const currentEntries = getEntries(currentSnapshot);
      const changed = currentEntries.filter(
        (entry) =>
          JSON.stringify(entry) !==
          JSON.stringify(previousEntries.find((old) => old.id === entry.id)),
      ).length;
      const removed = previousEntries.filter(
        (entry) => !currentEntries.some((current) => current.id === entry.id),
      ).length;
      const configChanged =
        JSON.stringify({
          ...snapshot.gameData,
          segments: undefined,
          suggestionHistory: undefined,
        }) !==
        JSON.stringify({
          ...currentSnapshot.gameData,
          segments: undefined,
          suggestionHistory: undefined,
        });
      // 词条内容相同仍可能改变词序、段名或段落归属，历史版确认必须独立提示这些差异。
      const structureOf = (document: WordBeatLesson) =>
        document.gameData.segments.map((segment) => ({
          id: segment.id,
          name: segment.name,
          entries: segment.entries.map((entry) => entry.id),
        }));
      const organizationChanged =
        JSON.stringify(structureOf(snapshot)) !== JSON.stringify(structureOf(currentSnapshot));
      if (
        !(await confirm({
          title: '使用上次已准备版本',
          message: `将使用 v${snapshot.revision}，当前草稿为 v${currentSnapshot.revision}。词条 ${previousEntries.length} → ${currentEntries.length} 条，其中新增或修改 ${changed} 条、移除 ${removed} 条；段落与词序${organizationChanged ? '已有变化' : '相同'}；全课设置${configChanged ? '已有变化' : '相同'}${snapshot.name !== currentSnapshot.name ? '，课件名已有变化' : ''}。上课与导出仅包含旧版本，草稿仍保留。`,
          confirmLabel: '检查并使用此版本',
        }))
      )
        throw new Error('已保留当前草稿，未启动旧版本。');
    }
    await validatePlayableAssets(snapshot, assets);
    const prepared = await markPrepared(snapshot, requiredAssets(snapshot), usePreparedVersion);
    if (mounted.current) editor.acceptPrepared(prepared.revision, prepared.id);
    return { prepared, draft: currentSnapshot };
  };
  const start = () =>
    attempt('检查课件', async () => {
      const { prepared } = await prepare();
      if (mounted.current) setClassroom(prepared);
    });
  const exportHtml = () => {
    setExportKind('html');
    setExportOpen(true);
  };

  // 列表快捷入口只消费一次，StrictMode 重执行也不重复预演或导出。
  // 不固定旧渲染闭包；后续编辑只更新处理函数，不再次消费导航动作。
  const navigationHandlers = useRef({ start, exportHtml });
  navigationHandlers.current = { start, exportHtml };
  useEffect(() => {
    const requested = navigationAction.current;
    navigationAction.current = undefined;
    if (requested === 'preview') void navigationHandlers.current.start();
    if (requested === 'export') void navigationHandlers.current.exportHtml();
    if (requested === 'replace-materials') setImportMode('replace');
  }, []);

  const applyBatch = () => {
    try {
      const next = applyEntryBatch(lesson, checked, batch);
      edit(next, 'separate');
      setBatchOpen(false);
      setBatch({});
      setError('');
      notify(`已更新 ${checked.length} 条，可一次撤销。`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  /** 勾选才授权写入，共同值只为本次字段提供初值；取消勾选彻底移出提交对象。 */
  const chooseBatchField = (key: keyof BatchInputs, chosen: boolean) => {
    setBatch((previous) => {
      const next = { ...previous };
      if (chosen) next[key] = batchCurrent[key] ?? '';
      else delete next[key];
      if (key === 'followMode' && next.followMode === 'preset') delete next.followBeats;
      if (key === 'followBeats' && chosen && next.followMode === 'preset')
        next.followMode = 'manual';
      return next;
    });
  };

  /** 每次进入重新授权，旧预览只失效、不改词表；取消不会产生课件编辑或撤销记录。 */
  const openRemix = () => {
    setShuffle(false);
    setRestore(false);
    setOverrideManual(false);
    setOverrideManualSlogans(false);
    setInvalidRemixPreviews(
      (previous) =>
        new Set([
          ...previous,
          ...visibleSuggestions
            .filter((item) => item.kind === 'remix' && item.state === 'available')
            .map((item) => item.id),
        ]),
    );
    setAssistantDrawer(null);
    setRemixOpen(true);
  };

  /** 读取、确认期间继续输入也不能被覆盖；切换只接受发起操作时捕获的同一份本地草稿。 */
  const reloadSaved = () =>
    attempt('重载已保存版本', async () => {
      const expected = structuredClone(lessonRef.current);
      const saved = await getLesson<WordBeatData>(expected.id);
      if (
        !(await confirm({
          title: '放弃本地输入并重载',
          message: `将放弃当前尚未保存的输入，打开已保存的 v${saved.revision}。建议先另存副本保留当前内容。`,
          confirmLabel: '放弃本地输入并重载',
          danger: true,
        }))
      )
        return;
      editor.replaceWithSaved(saved, expected);
      setSuggestions([]);
      setTimeSuggestions(createTimeSuggestions(saved, assets));
      setInvalidRemixPreviews(new Set());
      setSavedView(null);
      setError('');
      notify('已重载已保存版本。');
    });

  /** 教师明确重查后才替换时间候选；已经应用/忽略的决定继续保留在历史记录中。 */
  const recheckTimeSuggestions = () => {
    const currentLesson = lessonRef.current;
    const refreshed = createTimeSuggestions(currentLesson, assets);
    let updated: WordBeatLesson = {
      ...currentLesson,
      gameData: {
        ...currentLesson.gameData,
        suggestionHistory: (currentLesson.gameData.suggestionHistory ?? []).filter(
          (record) => record.kind !== 'time' || ['applied', 'ignored'].includes(record.state),
        ),
      },
    };
    for (const suggestion of refreshed) updated = rememberSuggestion(updated, suggestion);
    setTimeSuggestions(refreshed);
    setSuggestions((previous) => previous.filter((suggestion) => suggestion.kind !== 'time'));
    if (
      JSON.stringify(updated.gameData.suggestionHistory) !==
      JSON.stringify(currentLesson.gameData.suggestionHistory ?? [])
    )
      edit(updated, 'separate');
    if (!refreshed.length) notify('检查完成，当前没有可应用的时间调整建议。');
  };

  const displaySuggestion = (suggestion: WordBeatSuggestion) => {
    const valid =
      suggestion.state === 'available' &&
      isSuggestionCurrent(lesson, suggestion) &&
      !invalidRemixPreviews.has(suggestion.id);
    const preserved = protectedValues(lesson, suggestion);
    // 原因是阅读内容，定位是独立操作；携带真实差异字段，避免默认总跳到英文或 BPM。
    const target = suggestion.changes.find((change) => change.objectId) ?? suggestion.changes[0];
    const targetsEntry = entries.some((entry) => entry.id === target?.objectId);
    return (
      <div className="suggestion stack-sm" key={suggestion.id}>
        <div>
          <h3>{suggestion.title}</h3>
          <p>{suggestion.reason}</p>
        </div>
        {suggestion.changes
          .filter(
            (change) => !change.path.endsWith('.seed') && !change.path.endsWith('.templateId'),
          )
          .map((change, position) => (
            <small key={position}>
              {change.reason}：{humanValue(change.path, change.before)} →{' '}
              {humanValue(change.path, change.after)}
            </small>
          ))}
        {preserved.length > 0 && (
          <details>
            <summary>本次保留 {preserved.length} 项</summary>
            {preserved.map((value, index) => (
              <p key={index}>{value}</p>
            ))}
          </details>
        )}
        {suggestion.afterDurationMs !== undefined && (
          <small>
            调整后 {(suggestion.afterDurationMs / 1000).toFixed(1)} 秒，预计减少{' '}
            {((suggestion.beforeDurationMs! - suggestion.afterDurationMs) / 1000).toFixed(1)} 秒
          </small>
        )}
        <div className="row">
          <Button
            variant="text"
            onClick={() => selectIssue(target?.objectId, targetsEntry ? target?.path : undefined)}
          >
            {targetsEntry ? '定位词条' : '查看整课设置'}
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              try {
                edit(applySuggestion(lesson, suggestion), 'separate');
                setSuggestions((previous) =>
                  previous.filter((value) => value.id !== suggestion.id),
                );
              } catch (cause) {
                setError(errorMessage(cause));
              }
            }}
          >
            {suggestion.state === 'applied'
              ? '已应用'
              : suggestion.state === 'ignored'
                ? '已忽略'
                : valid
                  ? '应用全部'
                  : '需重新检查'}
          </Button>
          {!valid && !['applied', 'ignored'].includes(suggestion.state) && (
            <Button
              variant="text"
              onClick={() => {
                if (suggestion.kind === 'remix') {
                  openRemix();
                  return;
                }
                if (suggestion.kind === 'time') {
                  recheckTimeSuggestions();
                  return;
                }
                const targetPreset = suggestion.changes.find(
                  (change) => change.path === 'gameData.preset',
                )?.after;
                const refreshed =
                  typeof targetPreset === 'string' && targetPreset in PRESETS
                    ? createPresetSuggestion(
                        lessonRef.current,
                        targetPreset as WordBeatData['preset'],
                      )
                    : null;
                if (refreshed) edit(rememberSuggestion(lessonRef.current, refreshed), 'separate');
                else notify('重新检查完成，当前没有可应用的变化。');
              }}
            >
              重新检查
            </Button>
          )}
          <Button
            variant="text"
            disabled={!valid}
            onClick={() => {
              edit(ignoreSuggestion(lesson, suggestion));
              setSuggestions((previous) => previous.filter((value) => value.id !== suggestion.id));
            }}
          >
            忽略
          </Button>
        </div>
      </div>
    );
  };

  const checkContent = (
    <div className="panel panel-compact stack-sm error-summary" tabIndex={-1}>
      <h3>智能检查 · {issues.filter((issue) => issue.severity === 'error').length} 项需处理</h3>
      {issues.map((issue, position) => (
        <button
          type="button"
          className="issue-button"
          key={position}
          onClick={() => selectIssue(issue.objectId, issue.field)}
        >
          <Badge tone={issue.severity === 'error' ? 'error' : 'warning'}>
            {issue.severity === 'error' ? '需处理' : '提醒'}
          </Badge>{' '}
          <small>
            {issue.code.includes('MUSIC') || issue.field?.startsWith('music')
              ? '音乐'
              : /AUDIO|VOICE|SLOGAN|SOUND/u.test(issue.code)
                ? '声音'
                : /VERSION|COMPAT/u.test(issue.code)
                  ? '兼容'
                  : /ENGLISH|MEANING|ENTRY|TAG|UNIT/u.test(issue.code)
                    ? '内容'
                    : '参数'}{' '}
            ·{' '}
          </small>
          {issue.message}
        </button>
      ))}
    </div>
  );
  const suggestionContent = (
    <div className="panel panel-compact stack">
      <div className="row spread">
        <h3>智能建议与改编</h3>
        <Button variant="text" onClick={recheckTimeSuggestions}>
          检查时间建议
        </Button>
        <Button variant="text" onClick={openRemix}>
          <Sparkle size={16} aria-hidden="true" />
          换一版
        </Button>
      </div>
      <small>
        当前确认补全 {countConfirmedFields(entries)} 个字段 ·{' '}
        {entries.filter((entry) => entry.priority).length} 个重点词
      </small>
      {visibleSuggestions.map(displaySuggestion)}
      <TimePlanning
        lesson={lesson}
        assets={assets}
        onSavingChange={(saving) => {
          splitSaving.current = saving;
          if (!saving) void queryClient.invalidateQueries({ queryKey: ['lessons'] });
        }}
        onSuggestion={(suggestion) => {
          edit(rememberSuggestion(lessonRef.current, suggestion), 'separate');
          setSuggestions((previous) => [...previous, suggestion]);
        }}
      />
      <LocalModelGoal
        lesson={lesson}
        onSuggestion={(suggestion) => {
          edit(rememberSuggestion(lessonRef.current, suggestion), 'separate');
          setSuggestions((previous) => [
            ...previous.filter((item) => item.id !== suggestion.id),
            suggestion,
          ]);
        }}
      />
      {!visibleSuggestions.length && (
        <small>{explainTimeSuggestions(lesson, assets, duration)}</small>
      )}
    </div>
  );
  const suggestionCount = visibleSuggestions.filter(
    (item) =>
      item.state === 'available' &&
      isSuggestionCurrent(lesson, item) &&
      !invalidRemixPreviews.has(item.id),
  ).length;

  const properties = (
    <div className="property-panel panel stack">
      <div className="row spread">
        <h2>当前词条</h2>
        {current?.positionLocked && <Lock size={18} aria-label="位置已锁定" />}
      </div>
      {current ? (
        <>
          <div className="property-group stack-sm">
            <InputField
              label="英文 / 短语"
              id={`entry-${current.id}-english`}
              aria-label="词条英文"
              value={current.english}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.english = event.target.value;
                  if (entry.meaningSource)
                    entry.meaningSource = { ...entry.meaningSource, teacherRevised: true };
                })
              }
              error={contentError('english')}
            />
            <InputField
              label="教学释义"
              id={`entry-${current.id}-meaning`}
              value={current.meaning}
              error={contentError('meaning')}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.meaning = event.target.value;
                  if (entry.meaningSource)
                    entry.meaningSource = { ...entry.meaningSource, teacherRevised: true };
                })
              }
            />
            <InputField
              label="词性"
              id={`entry-${current.id}-partOfSpeech`}
              value={current.partOfSpeech ?? ''}
              error={contentError('partOfSpeech')}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.partOfSpeech = event.target.value;
                  if (entry.meaningSource)
                    entry.meaningSource = { ...entry.meaningSource, teacherRevised: true };
                })
              }
            />
            <InputField
              label="单元"
              id={`entry-${current.id}-unit`}
              value={current.unit ?? ''}
              error={contentError('unit')}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.unit = event.target.value;
                })
              }
            />
            <TeachingTagsField
              key={current.id}
              id={`entry-${current.id}-tags`}
              value={current.tags}
              error={contentError('tags')}
              onChange={(tags) =>
                patchEntry(current.id, (entry) => {
                  entry.tags = tags;
                })
              }
            />
            <TeachingEntrySource entry={current} />
            <Check
              label="重点词"
              checked={current.priority}
              onChange={(event) =>
                edit((previous) => setEntryPriority(previous, current.id, event.target.checked))
              }
            />
            <Button variant="text" onClick={() => onSaveCommon([current])}>
              保存为常用词
            </Button>
          </div>
          <div className="property-group stack-sm">
            <h3>练习参数</h3>
            <Field label="词条类型">
              <select
                id={`entry-${current.id}-entryType`}
                className="input"
                aria-label="词条类型"
                value={current.entryType}
                onChange={(event) =>
                  edit((previous) =>
                    setEntryType(previous, current.id, event.target.value as 'word' | 'phrase'),
                  )
                }
              >
                <option value="word">单词</option>
                <option value="phrase">短语</option>
              </select>
            </Field>
            <small>来源：{current.entryTypeSource === 'manual' ? '教师手动' : '预设规则'}</small>
            <InputField
              label="练习轮数"
              help={WORD_BEAT_HELP.rounds}
              id={`entry-${current.id}-rounds`}
              type="number"
              min={1}
              max={8}
              value={rawNumber(`${current.id}.rounds`, current.rounds.value)}
              error={lesson.draftInputs?.[`${current.id}.rounds`]?.message}
              onChange={(event) =>
                setNumber(
                  `${current.id}.rounds`,
                  event.target.value,
                  1,
                  8,
                  (document, value) => {
                    const entry = getEntries(document).find((item) => item.id === current.id)!;
                    entry.rounds = { ...entry.rounds, value, source: 'manual' };
                  },
                  current.id,
                )
              }
            />
            <small>轮数来源：{current.rounds.source === 'manual' ? '教师手动' : '练习预设'}</small>
            <Check
              label="锁定轮数"
              help={WORD_BEAT_HELP.lock}
              checked={current.rounds.locked}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.rounds.locked = event.target.checked;
                })
              }
            />
            {lesson.gameData.soundMode === 'chorus' && (
              <>
                {(
                  [
                    ['chorusBeats', '每轮总拍数', 'beats', 32],
                    ['chorusPerRead', '每次朗读占用拍数', 'beatsPerRead', 2],
                  ] as const
                ).map(([key, label, field, max]) => (
                  <div className="stack-sm" key={key}>
                    <InputField
                      label={label}
                      help={WORD_BEAT_HELP[field === 'beats' ? 'beats' : 'perRead']}
                      id={`entry-${current.id}-${key}`}
                      type="number"
                      min={1}
                      max={max}
                      value={rawNumber(
                        `${current.id}.${key}`,
                        current.chorus?.[field].value ?? (field === 'beats' ? 4 : 1),
                      )}
                      error={lesson.draftInputs?.[`${current.id}.${key}`]?.message}
                      onChange={(event) =>
                        setNumber(
                          `${current.id}.${key}`,
                          event.target.value,
                          1,
                          max,
                          (document, value) => {
                            const entry = getEntries(document).find(
                              (item) => item.id === current.id,
                            )!;
                            entry.chorus ??= {
                              beats: { value: 4, source: 'preset', locked: false },
                              beatsPerRead: { value: 1, source: 'preset', locked: false },
                            };
                            entry.chorus[field] = {
                              ...entry.chorus[field],
                              value,
                              source: 'manual',
                            };
                          },
                          current.id,
                        )
                      }
                    />
                    <Check
                      label={`锁定${label}`}
                      checked={current.chorus?.[field].locked ?? false}
                      onChange={(event) =>
                        patchEntry(current.id, (entry) => {
                          entry.chorus ??= {
                            beats: { value: 4, source: 'preset', locked: false },
                            beatsPerRead: { value: 1, source: 'preset', locked: false },
                          };
                          entry.chorus[field].locked = event.target.checked;
                        })
                      }
                    />
                  </div>
                ))}
                <p role="status">
                  {(current.chorus?.beats.value ?? 4) %
                    (current.chorus?.beatsPerRead.value ?? 1) !==
                  0
                    ? '总拍数必须能被每次占用拍数整除，请调整。'
                    : `每轮${current.chorus?.beats.value ?? 4}拍 · 读${(current.chorus?.beats.value ?? 4) / (current.chorus?.beatsPerRead.value ?? 1)}次 · 每次${current.chorus?.beatsPerRead.value ?? 1}拍 · 共${current.rounds.value}轮`}
                </p>
              </>
            )}
            {lesson.gameData.soundMode !== 'chorus' && (
              <>
                <Field label="跟读拍数来源">
                  <select
                    id={`entry-${current.id}-followMode`}
                    className="input"
                    aria-label="跟读拍数来源"
                    value={current.follow.mode}
                    onChange={(event) =>
                      patchEntry(current.id, (entry) => {
                        entry.follow.mode = event.target.value as 'preset' | 'manual';
                        if (entry.follow.mode === 'preset')
                          entry.follow.preset = lesson.gameData.preset;
                      })
                    }
                  >
                    <option value="preset">按预设公式自动计算</option>
                    <option value="manual">教师固定拍数</option>
                  </select>
                </Field>
                {current.follow.mode === 'manual' && (
                  <InputField
                    label="固定跟读拍数"
                    id={`entry-${current.id}-follow`}
                    type="number"
                    min={1}
                    max={32}
                    value={rawNumber(`${current.id}.follow`, current.follow.beats)}
                    error={lesson.draftInputs?.[`${current.id}.follow`]?.message}
                    onChange={(event) =>
                      setNumber(
                        `${current.id}.follow`,
                        event.target.value,
                        1,
                        32,
                        (document, value) => {
                          getEntries(document).find(
                            (item) => item.id === current.id,
                          )!.follow.beats = value;
                        },
                        current.id,
                      )
                    }
                  />
                )}
                <Check
                  label="锁定跟读设置"
                  checked={current.follow.locked}
                  onChange={(event) =>
                    patchEntry(current.id, (entry) => {
                      entry.follow.locked = event.target.checked;
                    })
                  }
                />
                {lesson.gameData.soundMode === 'teacher' && (
                  <InputField
                    label="教师示范拍数"
                    id={`entry-${current.id}-model`}
                    type="number"
                    min={1}
                    max={32}
                    value={rawNumber(`${current.id}.model`, current.modelBeats.value)}
                    error={lesson.draftInputs?.[`${current.id}.model`]?.message}
                    onChange={(event) =>
                      setNumber(
                        `${current.id}.model`,
                        event.target.value,
                        1,
                        32,
                        (document, value) => {
                          const entry = getEntries(document).find(
                            (item) => item.id === current.id,
                          )!;
                          entry.modelBeats = { ...entry.modelBeats, value, source: 'manual' };
                        },
                        current.id,
                      )
                    }
                  />
                )}
                <Check
                  label="锁定教师示范拍数"
                  checked={current.modelBeats.locked}
                  onChange={(event) =>
                    patchEntry(current.id, (entry) => {
                      entry.modelBeats.locked = event.target.checked;
                    })
                  }
                />
              </>
            )}
            <Check
              label="锁定位置"
              checked={current.positionLocked}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.positionLocked = event.target.checked;
                })
              }
            />
            <Field label="所属段落">
              <select
                id={`entry-${current.id}-segment`}
                className="input"
                aria-label="所属段落"
                value={
                  lesson.gameData.segments.find((segment) =>
                    segment.entries.some((entry) => entry.id === current.id),
                  )?.id
                }
                onChange={(event) =>
                  edit((previous) => {
                    const origin = previous.gameData.segments.find((segment) =>
                      segment.entries.some((entry) => entry.id === current.id),
                    )!;
                    const position = origin.entries.findIndex((entry) => entry.id === current.id);
                    const [entry] = origin.entries.splice(position, 1);
                    previous.gameData.segments
                      .find((segment) => segment.id === event.target.value)!
                      .entries.push(entry);
                    return previous;
                  })
                }
              >
                {lesson.gameData.segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="property-group stack-sm" hidden={lesson.gameData.soundMode === 'chorus'}>
            <h3>词条声音</h3>
            <Field label="条目英文音色">
              <select
                id={`entry-${current.id}-voiceId`}
                className="input"
                aria-label="条目英文音色"
                value={current.voiceOverrides?.voiceId ?? ''}
                disabled={current.audio?.source === 'recording'}
                onChange={(event) =>
                  patchEntry(current.id, (entry) => {
                    entry.voiceOverrides ??= {};
                    if (event.target.value) entry.voiceOverrides.voiceId = event.target.value;
                    else delete entry.voiceOverrides.voiceId;
                  })
                }
              >
                <option value="">沿用本课默认音色</option>
                {(voices.data ?? [])
                  .filter((voice) => voice.language.toLowerCase().startsWith('en'))
                  .map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="条目英文语速">
              <select
                id={`entry-${current.id}-rate`}
                className="input"
                aria-label="条目英文语速"
                value={current.voiceOverrides?.rate ?? ''}
                disabled={current.audio?.source === 'recording'}
                onChange={(event) =>
                  patchEntry(current.id, (entry) => {
                    entry.voiceOverrides ??= {};
                    if (event.target.value) entry.voiceOverrides.rate = Number(event.target.value);
                    else delete entry.voiceOverrides.rate;
                  })
                }
              >
                <option value="">沿用本课默认语速</option>
                {[0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} 倍
                  </option>
                ))}
              </select>
            </Field>
            <small>
              {lesson.gameData.soundMode === 'chorus'
                ? '学生自主齐读'
                : lesson.gameData.soundMode === 'teacher'
                  ? '教师示范（示范声音已关闭）'
                  : current.audio?.source === 'recording'
                    ? '教师导入录音'
                    : '合成配音'}{' '}
              ·{' '}
              {current.audio?.status === 'ready'
                ? '已匹配'
                : current.audio
                  ? '需要更新'
                  : '尚未制作'}
            </small>
            <div className="row">
              <Button
                disabled={
                  !current.audio?.assetId ||
                  !audioMatches(
                    current.audio,
                    current.english,
                    getVoiceSettings(lesson, 'en-US', current.voiceOverrides).voiceId,
                    getVoiceSettings(lesson, 'en-US', current.voiceOverrides).rate,
                  )
                }
                onClick={() => {
                  const asset = assets[current.audio!.assetId!];
                  if (asset)
                    void previewAudio(asset).catch((cause) => setError(errorMessage(cause)));
                }}
              >
                <SpeakerHigh size={18} aria-hidden="true" />
                试听
              </Button>
              <Button
                id={`entry-${current.id}-audio`}
                onClick={() => {
                  void importAudio(current.id);
                }}
              >
                导入录音
              </Button>
            </div>
            <Check
              label="锁定声音选择"
              checked={current.soundLocked}
              onChange={(event) =>
                patchEntry(current.id, (entry) => {
                  entry.soundLocked = event.target.checked;
                })
              }
            />
            {current.audio?.source === 'recording' && (
              <Button
                variant="text"
                onClick={async () => {
                  if (
                    await confirm({
                      title: '改用合成配音',
                      message: `将替换「${current.english}」的录音选择，之后需要制作配音。`,
                    })
                  )
                    patchEntry(current.id, (entry) => {
                      delete entry.audio;
                    });
                }}
              >
                改用合成配音
              </Button>
            )}
          </div>
          <div className="row">
            <Button onClick={() => moveEntry(current.id, -1)} aria-label="词条上移">
              <ArrowUp size={18} aria-hidden="true" />
            </Button>
            <Button onClick={() => moveEntry(current.id, 1)} aria-label="词条下移">
              <ArrowDown size={18} aria-hidden="true" />
            </Button>
            <Button
              variant="text"
              onClick={() => {
                void removeEntries([current.id]);
              }}
            >
              <Trash size={18} aria-hidden="true" />
              删除
            </Button>
          </div>
        </>
      ) : (
        <p className="muted">选择词条后查看和调整属性。</p>
      )}
    </div>
  );

  if (classroom)
    return createPortal(
      <div className="classroom-overlay">
        <WordBeatClassroom
          lesson={classroom}
          assets={assets}
          resolveAsset={readAssetData}
          onExit={() => setClassroom(null)}
        />
      </div>,
      document.body,
    );

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="topbar editor-topbar">
        <div className="row grow">
          <Button
            variant="text"
            aria-label="返回课件库"
            onClick={() => {
              void attempt('保存', async () => {
                await flush();
                onExit();
              });
            }}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </Button>
          <input
            id="lesson-name"
            onKeyDown={commitSingleLineOnEnter}
            aria-label="课件名称"
            className="input editor-name"
            value={lesson.name}
            onChange={(event) => edit((previous) => ({ ...previous, name: event.target.value }))}
          />
          <small role="status">
            {editor.saveState === 'saving'
              ? '保存中'
              : editor.saveState === 'error'
                ? editor.saveConflict
                  ? '本地输入未保存（冲突）'
                  : '保存失败'
                : '已保存'}{' '}
            · v{lesson.revision}
          </small>
          <Badge tone={state === 'ready' ? 'success' : state === 'repair' ? 'error' : 'warning'}>
            {STATE_LABEL[state]}
          </Badge>
        </div>
        <div className="row">
          <Button
            className="icon-button"
            aria-label="撤销"
            disabled={!editor.canUndo}
            onClick={editor.undo}
          >
            <ArrowUDownLeft size={18} aria-hidden="true" />
          </Button>
          <Button
            className="icon-button"
            aria-label="重做"
            disabled={!editor.canRedo}
            onClick={editor.redo}
          >
            <ArrowUDownRight size={18} aria-hidden="true" />
          </Button>
          <Button
            onClick={() => {
              void start();
            }}
            busy={busy === '检查课件'}
          >
            <Play size={18} aria-hidden="true" />
            预演 / 上课
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void exportHtml();
            }}
          >
            <DownloadSimple size={18} aria-hidden="true" />
            导出课堂文件
          </Button>
        </div>
      </div>
      {editor.saveConflict && (
        <Notice tone="error" role="alert">
          <div className="stack-sm">
            <strong>保存冲突 · 当前输入尚未保存</strong>
            <p>课件已有其他更新，已停止自动重试。当前输入和撤销记录均已保留，请选择处理方式。</p>
            <div className="row">
              <Button
                disabled={!!busy}
                onClick={() =>
                  void attempt('查看已保存版本', async () => {
                    setSavedView(await getLesson<WordBeatData>(lessonRef.current.id));
                  })
                }
              >
                查看已保存版本（只读）
              </Button>
              <Button
                disabled={!!busy}
                onClick={() => {
                  setCopyName(`${lessonRef.current.name} 副本`);
                  setCopyOpen(true);
                }}
              >
                另存当前输入为副本
              </Button>
              <Button disabled={!!busy} onClick={() => void reloadSaved()}>
                放弃本地输入并重载
              </Button>
              <Button
                disabled={!!busy}
                onClick={() => document.getElementById('lesson-name')?.focus()}
              >
                继续编辑
              </Button>
            </div>
          </div>
        </Notice>
      )}
      {(error || (editor.saveError && !editor.saveConflict)) && (
        <div style={{ padding: '12px 16px 0' }}>
          <Notice tone="error" role="alert">
            {error || editor.saveError}
            {editor.saveState === 'error' && !editor.saveConflict && (
              <Button
                onClick={() => {
                  void flush().catch((cause) => setError(errorMessage(cause)));
                }}
              >
                重试保存
              </Button>
            )}
          </Notice>
        </div>
      )}
      <div className="tabs-list editor-tabbar">
        <button
          className="tab"
          aria-selected={mobileTab === 'entries'}
          onClick={() => setMobileTab('entries')}
        >
          词表
        </button>
        <button
          className="tab"
          aria-selected={mobileTab === 'preview'}
          onClick={() => setMobileTab('preview')}
        >
          课堂预览
        </button>
        {compactEditor && (
          <>
            <Button
              className="editor-assistant-toggle"
              onClick={() => setAssistantDrawer('checks')}
            >
              检查（{issues.length}）
            </Button>
            <Button
              className="editor-assistant-toggle"
              onClick={() => setAssistantDrawer('suggestions')}
            >
              建议（{suggestionCount}）
            </Button>
          </>
        )}
        <Button className="properties-toggle" onClick={() => setPropertiesOpen(true)}>
          当前词属性
        </Button>
      </div>
      <div className="editor-grid" data-mobile-tab={mobileTab}>
        <div className="panel editor-entries stack-sm">
          <div className="row spread">
            <h3>教学词表 · {entries.length}/100</h3>
            <Button
              variant="text"
              className="icon-button"
              aria-label="新增词条"
              disabled={entries.length >= 100}
              onClick={() =>
                edit((previous) => {
                  const entry = createWordBeatEntry(
                    { id: crypto.randomUUID(), english: '', meaning: '', priority: false },
                    previous.gameData.preset,
                  );
                  previous.gameData.segments[0].entries.push(entry);
                  focusNewEntry.current = true;
                  setSelectedId(entry.id);
                  return previous;
                })
              }
            >
              <Plus size={18} aria-hidden="true" />
            </Button>
          </div>
          <div className="row">
            <Button onClick={() => setImportMode('append')}>导入 / 粘贴</Button>
            <Button variant="text" onClick={() => setChecked(entries.map((entry) => entry.id))}>
              全选当前词表
            </Button>
            {checked.length > 0 && (
              <Button variant="text" onClick={() => setChecked([])}>
                清空选择
              </Button>
            )}
            <Button variant="text" onClick={() => setImportMode('replace')}>
              替换材料
            </Button>
          </div>
          {checked.length > 0 && (
            <div className="notice stack-sm">
              <strong>已勾选 {checked.length} 条</strong>
              <div className="row">
                <Button
                  onClick={() => {
                    setBatch({});
                    setError('');
                    setBatchOpen(true);
                  }}
                >
                  批量修改
                </Button>
                <Button
                  variant="text"
                  onClick={() =>
                    onSaveCommon(entries.filter((entry) => checked.includes(entry.id)))
                  }
                >
                  存为常用词
                </Button>
                <Button
                  variant="text"
                  onClick={() => {
                    void removeEntries(checked);
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
          )}
          {lesson.gameData.segments.map((segment, segmentIndex) => (
            <div key={segment.id}>
              <div className="segment-header">
                <input
                  className="input"
                  aria-label={`段落${segmentIndex + 1}名称`}
                  value={segment.name}
                  onChange={(event) =>
                    edit((previous) => {
                      previous.gameData.segments[segmentIndex].name = event.target.value;
                      return previous;
                    })
                  }
                />
                <small>{segment.entries.length}</small>
                <Button
                  variant="text"
                  className="icon-button"
                  aria-label={`删除${segment.name}`}
                  onClick={() => {
                    setDeleteSegmentId(segment.id);
                    setSegmentDestination('delete');
                  }}
                >
                  <Trash size={16} aria-hidden="true" />
                </Button>
              </div>
              <div className="row">
                {([-1, 1] as const).map((direction) => (
                  <Button
                    key={direction}
                    variant="text"
                    disabled={
                      segmentIndex + direction < 0 ||
                      segmentIndex + direction >= lesson.gameData.segments.length
                    }
                    aria-label={`${segment.name}${direction < 0 ? '上移' : '下移'}`}
                    onClick={() =>
                      edit((previous) => {
                        const segments = previous.gameData.segments;
                        [segments[segmentIndex], segments[segmentIndex + direction]] = [
                          segments[segmentIndex + direction],
                          segments[segmentIndex],
                        ];
                        return previous;
                      })
                    }
                  >
                    {direction < 0 ? '段落上移' : '段落下移'}
                  </Button>
                ))}
              </div>
              {segment.entries.map((entry) => (
                <div
                  className="entry-row"
                  key={entry.id}
                  data-current={selectedId === entry.id}
                  onDragOver={(event) => {
                    if (draggedEntry) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggedEntry || draggedEntry === entry.id) return;
                    const movingId = draggedEntry;
                    setDraggedEntry(null);
                    edit((previous) => {
                      const origin = previous.gameData.segments.find((item) =>
                        item.entries.some((word) => word.id === movingId),
                      );
                      const target = previous.gameData.segments.find(
                        (item) => item.id === segment.id,
                      );
                      if (!origin || !target) return previous;
                      const [moving] = origin.entries.splice(
                        origin.entries.findIndex((word) => word.id === movingId),
                        1,
                      );
                      target.entries.splice(
                        target.entries.findIndex((word) => word.id === entry.id),
                        0,
                        moving,
                      );
                      return previous;
                    });
                  }}
                >
                  <button
                    type="button"
                    className="button button-text icon-button"
                    draggable
                    aria-label={`拖动${entry.english || '空词条'}排序，也可在属性中上移下移`}
                    onDragStart={(event) => {
                      setDraggedEntry(entry.id);
                      event.dataTransfer.setData('text/plain', entry.id);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDraggedEntry(null)}
                  >
                    <ArrowsDownUp size={18} aria-hidden="true" />
                  </button>
                  <input
                    style={{ marginTop: 5 }}
                    aria-label={`勾选${entry.english || '空词条'}`}
                    type="checkbox"
                    checked={checked.includes(entry.id)}
                    onChange={(event) =>
                      setChecked((previous) =>
                        event.target.checked
                          ? [...previous, entry.id]
                          : previous.filter((id) => id !== entry.id),
                      )
                    }
                  />
                  <button className="entry-main" onClick={() => setSelectedId(entry.id)}>
                    <strong>
                      {entry.priority ? '重点 · ' : ''}
                      {entry.english || '待填写英文'}
                      {entry.positionLocked && <Lock size={12} aria-label="位置锁定" />}
                    </strong>
                    <small>{entry.meaning || '释义可补充'}</small>
                    <small>
                      {entry.rounds.value} 轮 ·{' '}
                      {lesson.gameData.soundMode === 'chorus'
                        ? '学生自主齐读'
                        : lesson.gameData.soundMode === 'teacher'
                          ? '教师示范'
                          : entry.audio?.status === 'ready'
                            ? '已配音'
                            : entry.audio
                              ? '声音需更新'
                              : '声音待制作'}
                    </small>
                  </button>
                </div>
              ))}
            </div>
          ))}
          <Button
            variant="text"
            onClick={() =>
              edit((previous) => {
                previous.gameData.segments.push({
                  id: crypto.randomUUID(),
                  name: `第 ${previous.gameData.segments.length + 1} 组`,
                  entries: [],
                });
                return previous;
              })
            }
          >
            <Plus size={16} aria-hidden="true" />
            新增段落
          </Button>
        </div>
        <div className="editor-center stack">
          <div
            className={`preview-stage classroom preview-stage--${lesson.gameData.displayMode}`}
            data-theme="classroom"
          >
            <ClassroomAtmosphere active={false} />
            <div className="row studio-preview-header">
              <Badge>
                {lesson.gameData.soundMode === 'chorus'
                  ? '学生自主齐读'
                  : lesson.gameData.soundMode === 'teacher'
                    ? '教师示范'
                    : '示范 / 跟读'}
              </Badge>
              <small>{lesson.gameData.bpm.value} BPM</small>
            </div>
            <TeachingContent
              english={current?.english || '选择一个词条'}
              meaning={lesson.gameData.showMeaning ? current?.meaning : undefined}
              wordAs="div"
            />
            <div className="studio-preview-trail" aria-hidden="true">
              <BeatTrail
                mode={lesson.gameData.displayMode}
                english={current?.english}
                activeBeat={0}
                beatsElapsed={lesson.gameData.soundMode === 'chorus' ? 0 : 3}
                totalBeats={
                  lesson.gameData.soundMode === 'chorus'
                    ? (current?.chorus?.beats.value ?? 4)
                    : undefined
                }
                beatsPerRead={current?.chorus?.beatsPerRead.value ?? 1}
                playing={false}
                animations={false}
                timelineKey="editor-static"
              />
            </div>
            <small className="studio-preview-footnote">
              静态编辑预览 · 点击“预演 / 上课”运行真实安排
            </small>
          </div>
          <div className="row spread">
            <small>
              {duration === undefined
                ? `暂不能计算时长：${issues.find((issue) => issue.severity === 'error')?.message ?? '请检查参数和所需声音。'}`
                : `编排 ${(duration / 1000).toFixed(1)} 秒`}{' '}
              · {lesson.gameData.segments.filter((segment) => segment.entries.length).length}{' '}
              个非空段
            </small>
            <Button
              busy={busy === '声音制作'}
              onClick={() => {
                void produce();
              }}
            >
              <Sparkle size={18} aria-hidden="true" />
              制作 / 更新声音
            </Button>
          </div>
          <div className="panel stack-sm" id="lesson-settings">
            <div className="row spread">
              <h3>全课设置</h3>
              <Button className="properties-toggle" onClick={() => setPropertiesOpen(true)}>
                <Gear size={18} aria-hidden="true" />
                词条属性
              </Button>
            </div>
            {lesson.gameData.soundMode === 'chorus' && (
              <InputField
                label="词间间隔（拍）"
                help={WORD_BEAT_HELP.gap}
                type="number"
                min={0}
                max={4}
                value={rawNumber('chorusGapBeats', lesson.gameData.chorusGapBeats ?? 0)}
                error={lesson.draftInputs?.chorusGapBeats?.message}
                onChange={(event) =>
                  setNumber('chorusGapBeats', event.target.value, 0, 4, (document, value) => {
                    document.gameData.chorusGapBeats = value;
                  })
                }
                hint="默认0拍连续换词；段落准备与口号另计。"
              />
            )}
            <div className="grid-two">
              <InputField
                label="节奏 BPM"
                help={WORD_BEAT_HELP.bpm}
                id="lesson-bpm"
                disabled={
                  lesson.gameData.soundMode === 'chorus' &&
                  lesson.gameData.music.enabled &&
                  lesson.gameData.music.syncEnabled
                }
                type="number"
                min={50}
                max={180}
                value={rawNumber('bpm', lesson.gameData.bpm.value)}
                error={lesson.draftInputs?.bpm?.message}
                onChange={(event) =>
                  setNumber('bpm', event.target.value, 50, 180, (document, value) => {
                    document.gameData.bpm = { ...document.gameData.bpm, value, source: 'manual' };
                  })
                }
              />
              <Field label="练习模式" help={WORD_BEAT_HELP.mode}>
                <select
                  aria-label="练习模式"
                  className="input"
                  value={lesson.gameData.soundMode}
                  onChange={async (event) => {
                    const soundMode = event.target.value as WordBeatData['soundMode'];
                    if (soundMode === lesson.gameData.soundMode) return;
                    if (
                      await confirm({
                        title: '切换练习模式',
                        message:
                          '切换将重新计算课堂阶段和时长；已有音频与各模式参数保留，可切回恢复。',
                      })
                    )
                      patchData({ soundMode });
                  }}
                >
                  <option value="voiced">配音跟读</option>
                  <option value="teacher">文字领读</option>
                  <option value="chorus">学生自主齐读（无示范，跟拍朗读）</option>
                </select>
              </Field>
              <Field label="展示模式" help={WORD_BEAT_HELP.display}>
                <select
                  aria-label="展示模式"
                  className="input"
                  value={lesson.gameData.displayMode}
                  onChange={(event) =>
                    patchData({ displayMode: event.target.value as 'centered' | 'blocks' })
                  }
                >
                  <option value="centered">居中大词</option>
                  <option value="blocks">节奏方块</option>
                </select>
              </Field>
              <Field label="练习预设">
                <select
                  aria-label="练习预设"
                  className="input"
                  value={lesson.gameData.preset}
                  onChange={(event) => {
                    const preset = event.target.value as WordBeatData['preset'];
                    const suggestion = createPresetSuggestion(lesson, preset);
                    if (suggestion) setPresetPreview(suggestion);
                    else notify('当前预设与参数没有实际变化。');
                  }}
                >
                  {Object.entries(PRESETS).map(([id, preset]) => (
                    <option value={id} key={id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="row">
              <Check
                label="锁定节奏"
                checked={lesson.gameData.bpm.locked}
                onChange={(event) =>
                  patchData({ bpm: { ...lesson.gameData.bpm, locked: event.target.checked } })
                }
              />
              <Check
                label="显示释义"
                checked={lesson.gameData.showMeaning}
                onChange={(event) => patchData({ showMeaning: event.target.checked })}
              />
              <Check
                label="基础节拍"
                checked={lesson.gameData.beatEnabled}
                onChange={(event) => patchData({ beatEnabled: event.target.checked })}
              />
            </div>
            <details>
              <summary>声音、口号及导出设置</summary>
              <div className="stack" style={{ marginTop: 16 }}>
                <VoiceFields lesson={lesson} voices={voices.data ?? []} onChange={edit} />
                <Field label="背景音乐">
                  <select
                    id="lesson-music"
                    className="input"
                    aria-label="背景音乐"
                    value={lesson.gameData.music.assetId ?? ''}
                    onChange={(event) =>
                      patchData({
                        music: {
                          ...lesson.gameData.music,
                          assetId: event.target.value || undefined,
                          syncEnabled: false,
                        },
                      })
                    }
                  >
                    <option value="">请选择音乐</option>
                    {Object.values(assets)
                      .filter((asset) => asset.kind === 'music')
                      .map((asset) => (
                        <option key={asset.assetId} value={asset.assetId}>
                          {asset.name ?? '已导入音乐'}
                        </option>
                      ))}
                  </select>
                </Field>
                <div className="row">
                  <Check
                    label="启用背景音乐"
                    checked={lesson.gameData.music.enabled}
                    onChange={(event) =>
                      patchData({
                        music: { ...lesson.gameData.music, enabled: event.target.checked },
                      })
                    }
                  />
                  <Check
                    label="背景音乐循环"
                    checked={lesson.gameData.music.loop}
                    onChange={(event) =>
                      patchData({ music: { ...lesson.gameData.music, loop: event.target.checked } })
                    }
                  />
                  <MusicImportButton
                    label="导入音乐"
                    onImported={(asset) => {
                      onAssets({ [asset.assetId]: asset });
                      edit(
                        (previous) => ({
                          ...previous,
                          gameData: {
                            ...previous.gameData,
                            music: {
                              ...previous.gameData.music,
                              assetId: asset.assetId,
                              syncEnabled: false,
                            },
                          },
                        }),
                        'separate',
                      );
                    }}
                  />
                </div>
                {
                  <MusicCalibration
                    active={active}
                    lesson={lesson}
                    assets={assets}
                    edit={edit}
                    resolveAsset={readAssetData}
                  />
                }
                {(['voice', 'beat', 'music'] as const).map((channel, index) => (
                  <div key={channel} className="grid-two">
                    <Field label={`${['配音', '节拍', '音乐'][index]}音量（%）`}>
                      <input
                        aria-label={`${['配音', '节拍', '音乐'][index]}音量`}
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={lesson.gameData.volumes[channel] * 100}
                        onChange={(event) =>
                          setNumber(
                            `volume-${channel}`,
                            event.target.value,
                            0,
                            100,
                            (document, value) => {
                              document.gameData.volumes[channel] = value / 100;
                            },
                          )
                        }
                      />
                    </Field>
                    <InputField
                      label={`${['配音', '节拍', '音乐'][index]}音量数值（%）`}
                      id={`lesson-volume-${channel}`}
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={rawNumber(
                        `volume-${channel}`,
                        Math.round(lesson.gameData.volumes[channel] * 100),
                      )}
                      error={lesson.draftInputs?.[`volume-${channel}`]?.message}
                      onChange={(event) =>
                        setNumber(
                          `volume-${channel}`,
                          event.target.value,
                          0,
                          100,
                          (document, value) => {
                            document.gameData.volumes[channel] = value / 100;
                          },
                        )
                      }
                    />
                  </div>
                ))}
                {lesson.preparedRevision && (
                  <Check
                    label={`预演 / 上课使用上次已准备版本 v${lesson.preparedRevision}（启动前查看版本差异）`}
                    checked={usePreparedVersion}
                    onChange={(event) => setUsePreparedVersion(event.target.checked)}
                  />
                )}
                <InputField
                  label="目标时长（分钟）"
                  hint="编排目标不含教师等待、暂停和临时重读。"
                  id="lesson-target"
                  type="number"
                  min={1}
                  max={30}
                  step="any"
                  value={rawNumber('target', lesson.gameData.targetDurationMs / 60000)}
                  error={lesson.draftInputs?.target?.message}
                  onChange={(event) =>
                    setNumber(
                      'target',
                      event.target.value,
                      1,
                      30,
                      (document, value) => {
                        document.gameData.targetDurationMs = value * 60000;
                      },
                      undefined,
                      false,
                    )
                  }
                />
                {(['opening', 'transition', 'closing'] as const).map((purpose) => {
                  const slogan = lesson.gameData.slogans[purpose];
                  let finalText = '';
                  let expansionError: string | undefined;
                  try {
                    finalText = resolveSloganText(lesson, slogan);
                  } catch (cause) {
                    expansionError = errorMessage(cause);
                  }
                  const sloganError =
                    issues.find((issue) => issue.objectId === slogan.id && issue.field === 'text')
                      ?.message ?? expansionError;
                  return (
                    <div className="stack-sm property-group" key={purpose}>
                      <div className="row spread">
                        <Check
                          label={PURPOSE_LABEL[purpose]}
                          checked={slogan.enabled}
                          onChange={(event) =>
                            patchData({
                              slogans: {
                                ...lesson.gameData.slogans,
                                [purpose]: {
                                  ...slogan,
                                  enabled: event.target.checked,
                                  enabledSource: 'manual',
                                },
                              },
                            })
                          }
                        />
                        <Check
                          label="锁定"
                          checked={slogan.locked}
                          onChange={(event) =>
                            patchData({
                              slogans: {
                                ...lesson.gameData.slogans,
                                [purpose]: { ...slogan, locked: event.target.checked },
                              },
                            })
                          }
                        />
                      </div>
                      <InputField
                        label={`${PURPOSE_LABEL[purpose]}文本`}
                        id={`slogan-${slogan.id}`}
                        value={slogan.text}
                        error={sloganError}
                        onChange={(event) =>
                          patchData({
                            slogans: {
                              ...lesson.gameData.slogans,
                              [purpose]: {
                                ...slogan,
                                text: event.target.value,
                                textSource: 'manual',
                              },
                            },
                          })
                        }
                      />
                      <div
                        className="stack-sm"
                        aria-label={`${PURPOSE_LABEL[purpose]}最终口号预览`}
                      >
                        <small>最终口号 · {[...finalText].length} / 60 字符</small>
                        <p className="teaching-source-text">
                          {expansionError
                            ? '占位符修正后显示最终口号。'
                            : finalText || '尚未填写口号。'}
                        </p>
                      </div>
                      <Field label="口号语言">
                        <select
                          aria-label={`${PURPOSE_LABEL[purpose]}语言`}
                          className="input"
                          value={slogan.language}
                          onChange={(event) =>
                            patchData({
                              slogans: {
                                ...lesson.gameData.slogans,
                                [purpose]: {
                                  ...slogan,
                                  language: event.target.value as 'en-US' | 'zh-CN',
                                  textSource: 'manual',
                                },
                              },
                            })
                          }
                        >
                          <option value="zh-CN">中文</option>
                          <option value="en-US">英文</option>
                        </select>
                      </Field>
                      <div className="row">
                        <Button
                          onClick={() => {
                            void importAudio(slogan.id);
                          }}
                        >
                          导入口号录音
                        </Button>
                        <Button
                          disabled={!slogan.audio?.assetId || slogan.audio.status !== 'ready'}
                          onClick={() => {
                            const asset = assets[slogan.audio!.assetId!];
                            if (asset)
                              void previewAudio(asset).catch((cause) =>
                                setError(errorMessage(cause)),
                              );
                          }}
                        >
                          试听口号
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <Check
                  label="逐词等待教师"
                  checked={lesson.gameData.progression === 'step'}
                  onChange={(event) =>
                    patchData({ progression: event.target.checked ? 'step' : 'auto' })
                  }
                />
                <Check
                  label="整课循环"
                  checked={lesson.gameData.loop}
                  onChange={(event) => patchData({ loop: event.target.checked })}
                />
                <Check
                  label="恢复播放前准备 2 拍"
                  checked={lesson.gameData.resumePreparationBeats === 2}
                  onChange={(event) =>
                    patchData({ resumePreparationBeats: event.target.checked ? 2 : 0 })
                  }
                />
                <Button
                  onClick={() => {
                    setExportKind('package');
                    setExportOpen(true);
                  }}
                >
                  独立导出可编辑包（允许未完成草稿）
                </Button>
              </div>
            </details>
          </div>
          {task && (
            <Notice>
              <div className="row spread">
                <TaskProgress task={task} />
                {['queued', 'running'].includes(task.state) && (
                  <Button
                    onClick={() => {
                      void native
                        .cancelTask(task.taskId)
                        .then(setTask)
                        .catch((cause) => setError(errorMessage(cause)));
                    }}
                  >
                    取消制作
                  </Button>
                )}
              </div>
              {task.failures.map((failure) => (
                <small key={failure.requestId}>{failure.error.message}</small>
              ))}
            </Notice>
          )}
          {productionSummary && (
            <Notice>
              <p>
                声音需求 {productionSummary.total} 项：新制作 {productionSummary.created}，复用{' '}
                {productionSummary.reused}，未完成 {productionSummary.unfinished}。
              </p>
            </Notice>
          )}
          {oldResult && (
            <Notice tone="warning">
              制作版本与当前版本已不同，当前修改已保留。
              <Button onClick={() => setOldResultOpen(true)}>查看旧成果（只读）</Button>
              <Button
                onClick={() => {
                  void produce();
                }}
              >
                基于当前内容重新制作
              </Button>
            </Notice>
          )}
          {!compactEditor && issues.length > 0 && checkContent}
          {!compactEditor && suggestionContent}
        </div>
        {wideProperties && properties}
      </div>
      <Modal
        open={!!presetPreview}
        onOpenChange={(open) => {
          if (!open) setPresetPreview(null);
        }}
        title="切换练习预设"
        footer={
          <>
            <Button onClick={() => setPresetPreview(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={!!presetPreview && !isSuggestionCurrent(lesson, presetPreview)}
              onClick={() => {
                if (!presetPreview) return;
                try {
                  edit(applySuggestion(lessonRef.current, presetPreview), 'separate');
                  setPresetPreview(null);
                } catch (cause) {
                  setError(errorMessage(cause));
                }
              }}
            >
              应用这些变化
            </Button>
            {presetPreview && !isSuggestionCurrent(lesson, presetPreview) && (
              <Button
                onClick={() => {
                  const target = presetPreview.changes.find(
                    (change) => change.path === 'gameData.preset',
                  )?.after;
                  if (typeof target === 'string' && target in PRESETS)
                    setPresetPreview(
                      createPresetSuggestion(lessonRef.current, target as WordBeatData['preset']),
                    );
                }}
              >
                重新检查
              </Button>
            )}
          </>
        }
      >
        {presetPreview && (
          <div className="stack">
            <p>只更新由预设管理且未锁定的参数。教师手动值与锁定项保留。</p>
            {presetPreview.changes.map((change, index) => (
              <p key={index}>
                {change.reason}：{humanValue(change.path, change.before)} →{' '}
                {humanValue(change.path, change.after)}
              </p>
            ))}
            {protectedValues(lesson, presetPreview).map((value, index) => (
              <p key={`kept-${index}`}>保留：{value}</p>
            ))}
            {error && <Notice tone="error">{error}</Notice>}
          </div>
        )}
      </Modal>
      <Modal
        open={compactEditor && assistantDrawer !== null}
        onOpenChange={(open) => {
          if (!open) setAssistantDrawer(null);
        }}
        title={assistantDrawer === 'checks' ? '智能检查' : '智能建议与改编'}
        drawer
      >
        {assistantDrawer === 'checks' ? (
          issues.length ? (
            checkContent
          ) : (
            <Notice>检查完成，当前没有需要处理的问题。</Notice>
          )
        ) : (
          suggestionContent
        )}
      </Modal>
      <Modal
        open={!!savedView}
        onOpenChange={(open) => {
          if (!open) setSavedView(null);
        }}
        title="已保存版本（只读）"
      >
        {savedView && (
          <div className="stack">
            <Notice>此处仅查看已保存内容；关闭后继续保留你的本地输入。</Notice>
            <h3>
              {savedView.name} · v{savedView.revision}
            </h3>
            <p>
              {PRESETS[savedView.gameData.preset].name} · {savedView.gameData.bpm.value} BPM ·{' '}
              {savedView.gameData.soundMode === 'chorus'
                ? '学生自主齐读'
                : savedView.gameData.soundMode === 'teacher'
                  ? '教师示范'
                  : '带配音'}
            </p>
            <WordBeatReadOnlyResult
              lesson={savedView}
              assets={assets}
              onListen={(id) => {
                const asset = assets[id];
                if (asset) void previewAudio(asset).catch((cause) => setError(errorMessage(cause)));
              }}
            />
          </div>
        )}
      </Modal>
      <Modal
        open={copyOpen}
        onOpenChange={(open) => {
          if (!busy) setCopyOpen(open);
        }}
        title="另存当前输入为副本"
        footer={
          <>
            <Button disabled={!!busy} onClick={() => setCopyOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              busy={busy === '保存本地副本'}
              disabled={!!busy}
              onClick={() =>
                void attempt('保存本地副本', async () => {
                  const expected = structuredClone(lessonRef.current);
                  const saved = await saveLocalLessonCopy(expected, copyName);
                  // 副本已安全落盘。若异步期间继续输入，则继续保护本地新输入，不切换编辑基线。
                  try {
                    editor.replaceWithSaved(saved, expected);
                  } catch (cause) {
                    notify(`副本“${saved.name}”已保存，当前新输入继续保留。`);
                    throw cause;
                  }
                  setSuggestions([]);
                  setTimeSuggestions(createTimeSuggestions(saved, assets));
                  setInvalidRemixPreviews(new Set());
                  setCopyOpen(false);
                  setError('');
                  notify('当前输入已另存为独立副本，正在编辑副本。');
                })
              }
            >
              保存副本并继续编辑
            </Button>
          </>
        }
      >
        <div className="stack">
          <Notice>副本保留当前未保存的文字、手动参数、错误输入及已准备版；原课件保留原样。</Notice>
          <InputField
            label="副本名称"
            value={copyName}
            disabled={!!busy}
            onChange={(event) => setCopyName(event.target.value)}
          />
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
        </div>
      </Modal>
      <Modal
        open={propertiesOpen && !wideProperties}
        onOpenChange={setPropertiesOpen}
        title="词条属性"
        drawer
      >
        {!wideProperties && properties}
      </Modal>
      <Modal open={oldResultOpen} onOpenChange={setOldResultOpen} title="旧版本制作成果（只读）">
        {oldResult && (
          <div className="stack">
            <Notice>此结果不包含当前草稿后续修改，不会覆盖当前内容。</Notice>
            <p>
              {getEntries(oldResult).length} 条词汇 · 源 v
              {task?.inputRevision ?? oldResult.revision}
            </p>
            {getEntries(oldResult).map((entry) => (
              <p key={entry.id}>
                {entry.english} · {entry.audio?.status === 'ready' ? '声音已制作' : '声音待处理'}
              </p>
            ))}
            <Button
              onClick={() => {
                void attempt('检查旧成果', async () => {
                  await validatePlayableAssets(oldResult, assets);
                  setOldResultOpen(false);
                  setClassroom(oldResult);
                });
              }}
            >
              检查并预演此成果
            </Button>
          </div>
        )}
      </Modal>
      <Modal
        open={!!deleteSegmentId}
        onOpenChange={(open) => {
          if (!open) setDeleteSegmentId(null);
        }}
        title="删除段落"
        footer={
          <>
            <Button onClick={() => setDeleteSegmentId(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!deleteSegmentId) return;
                edit((previous) => {
                  const index = previous.gameData.segments.findIndex(
                    (item) => item.id === deleteSegmentId,
                  );
                  if (index < 0) return previous;
                  const source = previous.gameData.segments[index];
                  if (segmentDestination !== 'delete') {
                    const destination = previous.gameData.segments.find(
                      (item) => item.id === segmentDestination,
                    );
                    if (!destination) throw new Error('目标段落已变化，请重新选择。');
                    destination.entries.push(...source.entries);
                  } else {
                    const deleted = new Set(source.entries.map((entry) => entry.id));
                    previous.draftInputs = Object.fromEntries(
                      Object.entries(previous.draftInputs ?? {}).filter(
                        ([, input]) => !input.objectId || !deleted.has(input.objectId),
                      ),
                    );
                  }
                  if (previous.gameData.segments.length === 1) source.entries = [];
                  else previous.gameData.segments.splice(index, 1);
                  return previous;
                });
                setDeleteSegmentId(null);
              }}
            >
              确认删除段落
            </Button>
          </>
        }
      >
        <div className="stack">
          <p>将删除该段落。请选择其中词条的去向，本次操作可一次撤销。</p>
          <Field label="词条处理方式">
            <select
              aria-label="词条处理方式"
              className="input"
              value={segmentDestination}
              onChange={(event) => setSegmentDestination(event.target.value)}
            >
              <option value="delete">连同该段全部词条删除</option>
              {lesson.gameData.segments
                .filter((segment) => segment.id !== deleteSegmentId)
                .map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    移入：{segment.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </Modal>
      <Modal
        open={!!importMode}
        onOpenChange={(open) => {
          if (!open) void closeImport();
        }}
        title={importMode === 'replace' ? '替换教学材料' : '追加教学词汇'}
        wide
      >
        <ImportPanel
          dictionary={dictionary}
          commonWords={commonWords}
          onDraftChange={setImportDirty}
          disabled={importApplying}
          onConfirm={async (imported) => {
            if (importApplyOperation.current) return;
            importApplyOperation.current = true;
            setImportApplying(true);
            try {
              if (importMode === 'replace') {
                if (
                  !(await confirm({
                    title: '确认替换材料',
                    message: `将替换 ${entries.length} 条旧词及原段落，新 ${imported.length} 条按所选预设编排；全课设置保留，可一次撤销。`,
                  }))
                )
                  return;
                edit((previous) => replaceMaterials(previous, imported));
              } else {
                if (entries.length + imported.length > 100) {
                  setError('追加后超过 100 条，请减少所选词汇。');
                  return;
                }
                edit((previous) => {
                  const added = imported.map((entry) =>
                    createWordBeatEntry(entry, previous.gameData.preset),
                  );
                  previous.gameData.segments[previous.gameData.segments.length - 1].entries.push(
                    ...added,
                  );
                  return previous;
                });
              }
              setImportDirty(false);
              setImportMode(null);
            } finally {
              importApplyOperation.current = false;
              setImportApplying(false);
            }
          }}
        />
      </Modal>
      <Modal
        open={batchOpen}
        onOpenChange={(open) => {
          if (!open) void closeBatch();
        }}
        title={`批量修改 ${checked.length} 条词汇`}
        footer={
          <>
            <Button onClick={() => void closeBatch()}>取消</Button>
            <Button variant="primary" onClick={applyBatch}>
              整批应用
            </Button>
          </>
        }
      >
        <div className="stack">
          <Notice>
            先勾选要修改的字段，再填写本次值。未勾选字段只显示当前值，保持各自设置；“多个值”须选定后填写，已勾选字段留空会阻止整批应用。
          </Notice>
          <p role="status">
            本次将修改 {checked.length} 条词汇的 {Object.keys(batch).length}{' '}
            个字段；一次应用、一次撤销。
          </p>
          {(
            [
              ['rounds', '练习轮数', 8],
              ['modelBeats', '批量教师示范拍数', 32],
              ['chorusBeats', '齐读每轮总拍数', 32],
              ['chorusPerRead', '齐读每次占用拍数', 2],
            ] as const
          )
            .filter(
              ([key]) =>
                key === 'rounds' ||
                (lesson.gameData.soundMode === 'chorus'
                  ? key.startsWith('chorus')
                  : !key.startsWith('chorus')),
            )
            .map(([key, label, max]) => (
              <div className="stack-sm" key={key}>
                <Check
                  label={`修改${label}`}
                  checked={batch[key] !== undefined}
                  onChange={(event) => chooseBatchField(key, event.target.checked)}
                />
                <InputField
                  label={label}
                  help={
                    key === 'rounds'
                      ? WORD_BEAT_HELP.rounds
                      : key === 'chorusBeats'
                        ? WORD_BEAT_HELP.beats
                        : key === 'chorusPerRead'
                          ? WORD_BEAT_HELP.perRead
                          : '教师先示范的拍数，不包含后续学生跟读。'
                  }
                  type="number"
                  min={1}
                  max={max}
                  disabled={batch[key] === undefined || batch[key] === 'preset'}
                  value={batch[key] === 'preset' ? '' : (batch[key] ?? batchCurrent[key] ?? '')}
                  placeholder={batchCurrent[key] === undefined ? '多个值' : undefined}
                  hint={
                    batch[key] === 'preset'
                      ? '本次明确恢复本课预设'
                      : `当前：${batchCurrent[key] ?? '多个值'}`
                  }
                  onChange={(event) =>
                    setBatch((previous) => ({ ...previous, [key]: event.target.value }))
                  }
                />
                <div className="row" hidden={key.startsWith('chorus')}>
                  <Button
                    disabled={batch[key] === undefined || key.startsWith('chorus')}
                    onClick={() => setBatch((previous) => ({ ...previous, [key]: 'preset' }))}
                  >
                    恢复{key === 'rounds' ? '轮数' : '教师示范拍数'}预设
                  </Button>
                  {batch[key] === 'preset' && (
                    <Button
                      onClick={() =>
                        setBatch((previous) => ({ ...previous, [key]: batchCurrent[key] ?? '' }))
                      }
                    >
                      改为填写{key === 'rounds' ? '轮数' : '教师示范拍数'}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          {(
            [
              [
                'priority',
                '批量重点',
                [
                  ['yes', '设为重点'],
                  ['no', '取消重点'],
                ],
              ],
              [
                'entryType',
                '批量类型',
                [
                  ['word', '单词'],
                  ['phrase', '短语'],
                ],
              ],
              [
                'followMode',
                '批量跟读来源',
                [
                  ['preset', '恢复本课预设公式'],
                  ['manual', '教师固定拍数'],
                ],
              ],
              [
                'voiceId',
                '批量合成音色',
                [
                  ['inherit', '恢复本课默认'],
                  ...(voices.data ?? [])
                    .filter((voice) => voice.language.toLowerCase().startsWith('en'))
                    .map((voice) => [voice.id, voice.name]),
                ],
              ],
              [
                'rate',
                '批量系统语速',
                [
                  ['inherit', '恢复本课默认'],
                  ...[0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25].map((value) => [
                    String(value),
                    `${value} 倍`,
                  ]),
                ],
              ],
              ...(
                [
                  'lockPosition',
                  'lockRounds',
                  'lockFollow',
                  'lockModel',
                  'lockSound',
                  'lockChorusBeats',
                  'lockChorusRead',
                ] as const
              ).map((key, index) => [
                key,
                `批量锁定：${['位置', '轮数', '跟读设置', '教师示范拍数', '声音选择', '齐读总拍数', '朗读占拍'][index]}`,
                [
                  ['lock', '锁定'],
                  ['unlock', '解锁'],
                ],
              ]),
            ] as [keyof BatchInputs, string, string[][]][]
          )
            .filter(
              ([key]) =>
                lesson.gameData.soundMode !== 'chorus' ||
                !['followMode', 'voiceId', 'rate', 'lockFollow', 'lockModel', 'lockSound'].includes(
                  key,
                ),
            )
            .map(([key, label, options]) => (
              <div className="stack-sm" key={key}>
                <Check
                  label={`修改${label}`}
                  checked={batch[key] !== undefined}
                  onChange={(event) => chooseBatchField(key, event.target.checked)}
                />
                <Field label={label}>
                  <select
                    className="input"
                    aria-label={label}
                    disabled={batch[key] === undefined}
                    value={batch[key] ?? batchCurrent[key] ?? ''}
                    onChange={(event) =>
                      setBatch((previous) => {
                        const next = { ...previous, [key]: event.target.value };
                        if (key === 'followMode' && event.target.value === 'preset')
                          delete next.followBeats;
                        return next;
                      })
                    }
                  >
                    <option value="">
                      {batchCurrent[key] === undefined ? '多个值：请选择本次值' : '请选择本次值'}
                    </option>
                    {options.map(([value, title]) => (
                      <option key={value} value={value}>
                        {title}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ))}
          <div className="stack-sm" hidden={lesson.gameData.soundMode === 'chorus'}>
            <Check
              label="修改批量固定跟读拍数"
              checked={batch.followBeats !== undefined}
              disabled={batch.followMode === 'preset'}
              onChange={(event) => chooseBatchField('followBeats', event.target.checked)}
            />
            <InputField
              label="批量固定跟读拍数"
              type="number"
              min={1}
              max={32}
              disabled={batch.followBeats === undefined || batch.followMode === 'preset'}
              value={batch.followBeats ?? batchCurrent.followBeats ?? ''}
              placeholder={batchCurrent.followBeats === undefined ? '多个值' : undefined}
              hint="明确填写固定拍数时，会将选中词条的跟读方式设为教师固定。"
              onChange={(event) =>
                setBatch((previous) => ({ ...previous, followBeats: event.target.value }))
              }
            />
          </div>
          <small hidden={lesson.gameData.soundMode === 'chorus'}>
            音色与语速分别继承；录音条目保留原录音，不参与系统参数批改。锁定和解锁均须单独勾选确认。
          </small>
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
        </div>
      </Modal>
      <Modal
        open={remixOpen}
        onOpenChange={(open) => {
          if (!open) setRemixOpen(false);
        }}
        title="智能改编范围"
        footer={
          <>
            <Button onClick={() => setRemixOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                try {
                  const suggestion = remixLesson(lesson, {
                    shuffleEntries: shuffle,
                    restorePreset: restore,
                    overrideManual: restore && overrideManual,
                    overrideManualSlogans,
                  });
                  if (suggestion) {
                    // 范围随预览保存，后续打开也能辨认本次明确授权过的内容，避免笼统声称保留手动值。
                    suggestion.reason = `本次范围：${[
                      '未锁定模板口号',
                      shuffle && '段内未锁定词序',
                      restore && '预设管理参数',
                      restore && overrideManual && '允许恢复未锁定手动参数',
                      overrideManualSlogans && '允许替换未锁定手改口号',
                    ]
                      .filter(Boolean)
                      .join('、')}。锁定项继续保留，应用前请核对以下差异。`;
                    const next = structuredClone(lesson);
                    next.gameData.suggestionHistory = next.gameData.suggestionHistory?.filter(
                      (record) =>
                        record.kind !== 'remix' || ['applied', 'ignored'].includes(record.state),
                    );
                    edit(rememberSuggestion(next, suggestion), 'separate');
                    setSuggestions((previous) => [
                      ...previous.filter((value) => value.kind !== 'remix'),
                      suggestion,
                    ]);
                  } else notify('当前没有可变项或实际差异。');
                  setRemixOpen(false);
                  if (compactEditor) setAssistantDrawer('suggestions');
                } catch (cause) {
                  setError(errorMessage(cause));
                }
              }}
            >
              生成差异预览
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <p>
            默认只替换未锁定、未经教师手改的模板口号，不会立即修改课件。修改范围后须重新生成差异。
          </p>
          <Check
            label="允许替换手改口号"
            checked={overrideManualSlogans}
            onChange={(event) => setOverrideManualSlogans(event.target.checked)}
          />
          <Check
            label="同时调整段内未锁定词序"
            checked={shuffle}
            onChange={(event) => setShuffle(event.target.checked)}
          />
          <Check
            label="恢复由预设管理的参数"
            checked={restore}
            onChange={(event) => {
              setRestore(event.target.checked);
              if (!event.target.checked) setOverrideManual(false);
            }}
          />
          <Check
            label="明确允许恢复未锁定的教师手动参数"
            checked={overrideManual}
            disabled={!restore}
            onChange={(event) => setOverrideManual(event.target.checked)}
          />
        </div>
      </Modal>
      <LessonExportDialog
        open={exportOpen}
        initialKind={exportKind}
        assets={assets}
        getCurrent={flush}
        onPrepared={(revision, lessonId) => {
          if (mounted.current) editor.acceptPrepared(revision, lessonId);
        }}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}
