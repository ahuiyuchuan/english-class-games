/** 桌面预演及便携 HTML 共用课堂场景，所有声音来自已检查素材。 @author ahui */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  CheckCircle,
  Clock,
  CornersIn,
  CornersOut,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkle,
  SpeakerHigh,
  Stack,
  Stop,
  WarningCircle,
  Waveform,
  X,
} from '@phosphor-icons/react';
import type { ClassroomProps } from '../../platform/types';
import { TimelineController } from '../../runtime/controller';
import { WebAudioSession } from '../../runtime/audio';
import type { RuntimeState } from '../../runtime/types';
import { TeachingContent } from '../../shared/ui/TeachingContent';
import type { WordBeatData, WordBeatLesson } from './model';
import type { WordBeatCueData, WordBeatPlan } from './timeline';
import { getWordBeatBeatProgress } from './timeline';
import {
  audioMatches,
  compileWordBeat,
  getEntries,
  getVoiceSettings,
  validateWordBeat,
} from './rules';
import {
  classroomWordError,
  classroomWordsChanged,
  classroomWordStructureChanged,
} from './classroom-words';
import {
  BeatTrail,
  ClassroomAtmosphere,
  CompletionBurst,
  useClassroomMotion,
} from './ClassroomVisuals';
import { StagePortal } from './StagePortal';
import {
  ClassroomRounds,
  createClassroomBulkDraft,
  getClassroomBulkSelection,
  previewClassroomFollow,
  validClassroomRounds,
  type ClassroomBulkDraft,
  type ClassroomRoundDraft,
} from './ClassroomRounds';
import { HelpTip } from '../../shared/ui/HelpTip';
import { ClassroomNotice, type ClassroomNoticeTone } from './ClassroomNotice';
import { WORD_BEAT_HELP } from './settingHelp';
import {
  classroomRhythmChanged,
  classroomRhythmError,
  getClassroomChorus,
  previewClassroomRhythm,
  type ClassroomRhythmBulk,
  type ClassroomRhythmDraft,
} from './classroom-rhythm';
import {
  applyClassroomSettings,
  captureClassroomSettings,
  clearClassroomSettings,
  loadClassroomSettings,
  saveClassroomSettings,
} from './classroom-storage';
import './classroom.css';
import { SoftwareLicense } from '../../shared/SoftwareLicense';

/** 以分钟秒显示编排/实际时间，不声称是学生正确率。 */
function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 数字草稿必须完整且为范围内整数；HTML min/max 不会阻止普通按钮提交。 */
function validSettingInteger(raw: string, min: number, max: number): boolean {
  return (
    raw.trim() !== '' && Number.isInteger(Number(raw)) && Number(raw) >= min && Number(raw) <= max
  );
}

const initialState: RuntimeState = {
  status: 'idle',
  hasStarted: false,
  cueIndex: 0,
  elapsedInCueMs: 0,
  actualElapsedMs: 0,
  mode: 'auto',
  loop: false,
  repeats: 0,
  completedItems: 0,
};

/**
 * 游戏完整课堂入口。课堂设置在完成时统一保存到浏览器，不改变传入课件；
 * 退出、失焦或休眠均停止声音。resolveAsset用于桌面素材适配。
 */
export function WordBeatClassroom({
  lesson,
  assets,
  resolveAsset,
  onExit,
  exitLabel,
  exportedAt,
}: ClassroomProps<WordBeatData>) {
  const issues = useMemo(() => validateWordBeat(lesson, assets), [lesson, assets]);
  const originalPlan = useMemo(() => {
    try {
      return compileWordBeat(lesson, assets);
    } catch {
      return null;
    }
  }, [lesson, assets]);
  // 固定修订只读取一次本地偏好；绝不在逐拍渲染时访问存储或覆盖教师输入。
  const [boot] = useState(() => loadClassroomSettings(lesson, assets));
  const [draftLesson, setDraftLesson] = useState(() => structuredClone(boot.lesson));
  const [appliedSettings, setAppliedSettings] = useState(boot.settings);
  const savedSession = useRef(boot.settings);
  const [storageError, setStorageError] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [state, setState] = useState<RuntimeState>({
    ...initialState,
    mode: boot.lesson.gameData.progression,
    loop: boot.lesson.gameData.loop,
  });
  const [plan, setPlan] = useState<WordBeatPlan | null>(() => {
    try {
      return compileWordBeat(boot.lesson, assets);
    } catch {
      return originalPlan;
    }
  });
  const [settings, setSettings] = useState(false);
  const [roundDraft, setRoundDraft] = useState<ClassroomRoundDraft | null>(null);
  const incompleteSettings = useRef(false);
  const [bulkDraft, setBulkDraft] = useState<ClassroomBulkDraft>(() =>
    createClassroomBulkDraft(boot.lesson),
  );
  const [roundUndo, setRoundUndo] = useState<Map<
    string,
    ReturnType<typeof getEntries>[number]['rounds']
  > | null>(null);
  const [pendingRounds, setPendingRounds] = useState(false);
  const [rhythmDraft, setRhythmDraft] = useState<ClassroomRhythmDraft | null>(null);
  const [rhythmBulk, setRhythmBulk] = useState<ClassroomRhythmBulk>({
    beats: null,
    beatsPerRead: null,
  });
  const [rhythmUndo, setRhythmUndo] = useState<Map<
    string,
    ReturnType<typeof getClassroomChorus>
  > | null>(null);
  const [gapInput, setGapInput] = useState(String(boot.lesson.gameData.chorusGapBeats ?? 0));
  const [showMeaning, setShowMeaning] = useState(boot.settings.showMeaning);
  const [displayMode, setDisplayMode] = useState(boot.settings.displayMode);
  // 装饰偏好随本课保存，系统减少动态效果仍具有更高优先级。
  const [stageEffects, setStageEffects] = useState(boot.settings.stageEffects);
  const [showWordTrack, setShowWordTrack] = useState(boot.settings.showWordTrack);
  const [resumePreparation, setResumePreparation] = useState(boot.settings.resumePreparationBeats);
  // 开场前尚无控制器，已校验的会话编排独立保留，首次开局与键盘入口读取同一份。
  const sessionPlan = useRef(plan);
  const latestStart = useRef<() => Promise<void>>(async () => {});
  const [volumes, setVolumes] = useState({ ...boot.settings.volumes });
  // 长口号试听只保留完整语音；异步截断回调必须读取最新草稿，不能把教师音量跳回旧值。
  const latestPreviewVolumes = useRef(volumes);
  latestPreviewVolumes.current = volumes;
  const previewAccompanimentStopped = useRef(false);
  const [volumeInputs, setVolumeInputs] = useState(() =>
    Object.fromEntries(
      Object.entries(boot.settings.volumes).map(([part, value]) => [
        part,
        String(Math.round(value * 100)),
      ]),
    ),
  );
  const [bpmInput, setBpmInput] = useState(String(boot.settings.bpm));
  const [pendingBpm, setPendingBpm] = useState<number | null>(null);
  const [notice, setNotice] = useState({
    text: boot.notice,
    tone: (boot.noticeKind === 'fallback' ? 'warning' : 'info') as ClassroomNoticeTone,
    title: '本课设置',
    autoDismiss: boot.noticeKind === 'restored',
  });
  const message = notice.text;
  /** 普通确认默认短显，警告／错误持续；待生效须显式保留，不让超时冒充已应用。 */
  const setMessage = (
    text: string,
    tone: ClassroomNoticeTone = 'info',
    title = '课堂提示',
    autoDismiss = tone === 'info' || tone === 'success',
  ) => setNotice({ text, tone, title, autoDismiss });
  useEffect(() => {
    if (!notice.text || !notice.autoDismiss) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inNotice = (target: EventTarget | null) =>
      target instanceof Element &&
      !!target.closest('.ecg-classroom-message') &&
      !!root.current?.contains(target);
    let focused = inNotice(document.activeElement);
    let hovered = !!root.current?.querySelector('.ecg-classroom-message:hover');
    /** 始终只有一个4秒定时器；悬停／聚焦暂停，移开后重新留足阅读时间。 */
    const schedule = () => {
      clearTimeout(timer);
      if (focused || hovered) return;
      timer = setTimeout(() => {
        // 移除前再次保护真实焦点；旧回调也不能清除后到的错误或新消息。
        if (inNotice(document.activeElement)) return;
        setNotice((current) => (current === notice ? { ...current, text: '' } : current));
      }, 4000);
    };
    const focusIn = (event: FocusEvent) => {
      if (!inNotice(event.target)) return;
      focused = true;
      schedule();
    };
    const focusOut = (event: FocusEvent) => {
      if (!inNotice(event.target)) return;
      focused = inNotice(event.relatedTarget);
      schedule();
    };
    const pointerOver = (event: PointerEvent) => {
      if (!inNotice(event.target) || inNotice(event.relatedTarget)) return;
      hovered = true;
      schedule();
    };
    const pointerOut = (event: PointerEvent) => {
      if (!inNotice(event.target) || inNotice(event.relatedTarget)) return;
      hovered = false;
      schedule();
    };
    // 委托事件覆盖设置内外的同一个提示槽；不逐拍重绑，也不轮询焦点／鼠标。
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('pointerover', pointerOver);
    document.addEventListener('pointerout', pointerOut);
    schedule();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerover', pointerOver);
      document.removeEventListener('pointerout', pointerOut);
    };
  }, [notice, settings]);
  const [testing, setTesting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const completeButton = useRef<HTMLButtonElement>(null);
  const previousScene = useRef('lobby');
  const engine = useRef<TimelineController<WordBeatCueData> | null>(null);
  const session = useRef<WebAudioSession<WordBeatCueData> | null>(null);
  const testSession = useRef<WebAudioSession<WordBeatCueData> | null>(null);
  const testTimer = useRef<ReturnType<typeof setTimeout>>();
  const testShortTimer = useRef<ReturnType<typeof setTimeout>>();
  const testInterval = useRef<ReturnType<typeof setInterval>>();
  const unsubscribe = useRef<(() => void) | null>(null);
  const initialLesson = useRef<WordBeatLesson>(structuredClone(boot.lesson));
  /** 输入值与当前运行值分开；只有控制器实际安装该安排后才清除待生效提示。 */
  const pendingTempo = useRef<WordBeatPlan | null>(null);

  const musicSynced =
    lesson.gameData.soundMode === 'chorus' &&
    lesson.gameData.music.enabled &&
    lesson.gameData.music.syncEnabled;
  const validBpm = validSettingInteger(bpmInput, 50, 180);
  // 完整候选同时包含逐词与批量变化，保证同一次提交中的 BPM 和轮数一起编排。
  const candidate = useMemo(() => {
    const follow = previewClassroomFollow(draftLesson, bulkDraft);
    const rhythm = previewClassroomRhythm(follow.lesson, rhythmBulk, bulkDraft.scope);
    const next = rhythm.lesson;
    if (bulkDraft.dirty && validClassroomRounds(bulkDraft.raw)) {
      for (const entry of getClassroomBulkSelection(next, bulkDraft).changed)
        entry.rounds.value = Number(bulkDraft.raw);
    }
    if (!musicSynced && validSettingInteger(bpmInput, 50, 180))
      next.gameData.bpm.value = Number(bpmInput);
    if (next.gameData.soundMode === 'chorus' && validSettingInteger(gapInput, 0, 4))
      next.gameData.chorusGapBeats = Number(gapInput);
    Object.assign(next.gameData, {
      showMeaning,
      displayMode,
      resumePreparationBeats: resumePreparation,
      volumes: { ...volumes },
    });
    let preview: WordBeatPlan | null = null;
    let error = '';
    try {
      if (follow.error || rhythm.error) throw new Error(follow.error || rhythm.error);
      preview = compileWordBeat(next, assets);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : '当前安排无法运行。';
    }
    return { lesson: next, plan: preview, error };
  }, [
    draftLesson,
    bulkDraft,
    rhythmBulk,
    gapInput,
    musicSynced,
    bpmInput,
    showMeaning,
    displayMode,
    resumePreparation,
    volumes,
    assets,
  ]);
  const draftSettings = useMemo(
    () => captureClassroomSettings(candidate.lesson, { stageEffects, showWordTrack }),
    [candidate.lesson, stageEffects, showWordTrack],
  );
  // 试听与声部说明读取同一候选；未使用的旧配音仍保留在课件中，不冒充会播放。
  const soundCues = candidate.plan?.cues ?? sessionPlan.current?.cues ?? originalPlan?.cues ?? [];
  const hasDemonstration = soundCues.some((item) => item.kind === 'model' && item.audioAssetId);
  const hasSlogan = soundCues.some(
    (item) => ['opening', 'transition', 'closing'].includes(item.kind) && item.audioAssetId,
  );
  const soundLabels = {
    voice: hasDemonstration ? (hasSlogan ? '示范 / 口号' : '示范') : '口号',
    beat: '节拍',
    music: '音乐',
  };
  const soundParts = (['voice', 'beat', 'music'] as const).filter((part) =>
    part === 'beat'
      ? lesson.gameData.beatEnabled
      : part === 'music'
        ? lesson.gameData.music.enabled
        : soundCues.some((item) => item.audioAssetId),
  );
  // 不重写声音绑定来冒充新配音。只有教师明确操作才可整课改用文字领读。
  const staleWords =
    lesson.gameData.soundMode === 'voiced'
      ? getEntries(draftLesson).filter((entry) => {
          const voice = getVoiceSettings(draftLesson, 'en-US', entry.voiceOverrides);
          return !audioMatches(entry.audio, entry.english, voice.voiceId, voice.rate);
        })
      : [];
  const settingsDirty = useMemo(
    () => JSON.stringify(draftSettings) !== JSON.stringify(appliedSettings),
    [draftSettings, appliedSettings],
  );
  // 同一份问题列表保护按钮、键盘和声音入口。合法但未应用的节奏也不能冒充已完成。
  const settingsIssues: { field: string; label: string }[] = [];
  const invalidWord = getEntries(draftLesson).find((entry) =>
    classroomWordError(entry.english, entry.meaning),
  );
  if (invalidWord)
    settingsIssues.push({
      field: 'classroom-word-editor',
      label: classroomWordError(invalidWord.english, invalidWord.meaning),
    });
  if (rhythmDraft)
    settingsIssues.push({
      field: 'classroom-chorus-beats',
      label: classroomRhythmError(rhythmDraft.beats, rhythmDraft.beatsPerRead),
    });
  if (lesson.gameData.soundMode === 'chorus' && !validSettingInteger(gapInput, 0, 4))
    settingsIssues.push({ field: 'classroom-chorus-gap', label: '词间间隔需为 0～4 的整数拍' });
  if (roundDraft)
    settingsIssues.push({
      field:
        roundDraft.field === 'modelBeats'
          ? 'classroom-model-beats-input'
          : roundDraft.field === 'follow'
            ? 'classroom-follow-beats-input'
            : 'classroom-rounds-input',
      label: roundDraft.error || '当前词轮数需要修正或恢复',
    });
  if (bulkDraft.dirty && !validClassroomRounds(bulkDraft.raw))
    settingsIssues.push({
      field: 'classroom-bulk-input',
      label: '统一轮数需为 1～8 的整数',
    });
  if (!musicSynced && !validBpm)
    settingsIssues.push({
      field: 'classroom-bpm-input',
      label: '节奏需为 50～180 的整数 BPM',
    });
  for (const part of soundParts) {
    if (!validSettingInteger(volumeInputs[part], 0, 100))
      settingsIssues.push({
        field: `classroom-volume-${part}`,
        label: `${soundLabels[part]}音量需为 0～100 的整数`,
      });
  }
  if (candidate.error && !settingsIssues.length)
    settingsIssues.push({
      field:
        draftLesson.gameData.soundMode === 'voiced' && staleWords.length
          ? 'classroom-word-sound-fallback'
          : 'classroom-settings-rounds',
      label:
        draftLesson.gameData.soundMode === 'voiced' && staleWords.length
          ? `${staleWords.length} 个词与原配音不匹配，请还原英文或明确改用文字领读。`
          : candidate.error,
    });
  const settingsBlocked = settingsIssues.length > 0;
  const playBlocked = settingsBlocked || settingsDirty;
  incompleteSettings.current = playBlocked;
  // 错误与底部操作出现时，只校正正在编辑字段的滚动位置，不移动焦点或在逐拍更新时滚动。
  useLayoutEffect(() => {
    if (!settingsBlocked) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.ecg-settings-body')) {
      active
        .closest('.ecg-volume-field, .ecg-settings-field')
        ?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [settingsBlocked]);

  /**
   * 重置全部未完成输入，保留已完成的课堂设置与本地记录。
   * notice 由实际操作给出；结束课堂且没有草稿时，不能宣称已放弃输入。
   */
  const discardDrafts = (notice = '已放弃未完成输入，保留上次完成的设置。') => {
    setDraftLesson(structuredClone(initialLesson.current));
    setRoundDraft(null);
    setRhythmDraft(null);
    setRhythmBulk({ beats: null, beatsPerRead: null });
    setRhythmUndo(null);
    setGapInput(String(initialLesson.current.gameData.chorusGapBeats ?? 0));
    setBulkDraft(createClassroomBulkDraft(initialLesson.current));
    setRoundUndo(null);
    setBpmInput(String(appliedSettings.bpm));
    setShowMeaning(appliedSettings.showMeaning);
    setDisplayMode(appliedSettings.displayMode);
    setResumePreparation(appliedSettings.resumePreparationBeats);
    setStageEffects(appliedSettings.stageEffects);
    setShowWordTrack(appliedSettings.showWordTrack);
    setVolumes({ ...appliedSettings.volumes });
    setVolumeInputs(
      Object.fromEntries(
        Object.entries(appliedSettings.volumes).map(([part, value]) => [
          part,
          String(Math.round(value * 100)),
        ]),
      ),
    );
    setStorageError('');
    setRestoreConfirm(false);
    setMessage(notice);
  };

  /**
   * 焦点与滚动只在教师明确定位时移动；分区导航从标题开始，错误字段就近可见。
   * 小屏分区可能高于滚动容器，nearest 会保留中部位置并遮住标题，不能用于分区跳转。
   */
  const focusSetting = (id: string) => {
    const element = root.current?.querySelector<HTMLElement>(`#${id}`);
    if (!element) return;
    element?.focus({ preventScroll: true });
    const body = element.closest<HTMLElement>('.ecg-settings-body');
    if (!body) return;
    const target = element.getBoundingClientRect();
    const viewport = body.getBoundingClientRect();
    // 只滚动字段容器；scrollIntoView 也会滚动 overflow:hidden 的外层对话框，
    // 导致固定头部与完成按钮随定位消失。12px 与共享滚动留白保持一致。
    const top = target.top - viewport.top - 12;
    const bottom = target.bottom - viewport.bottom + 12;
    const offset = element.classList.contains('ecg-settings-section')
      ? top
      : top < 0
        ? top
        : Math.max(0, bottom);
    body.scrollTop += offset;
  };

  const stopTest = () => {
    if (testTimer.current) clearTimeout(testTimer.current);
    if (testShortTimer.current) clearTimeout(testShortTimer.current);
    if (testInterval.current) clearInterval(testInterval.current);
    testSession.current?.dispose();
    testSession.current = null;
    previewAccompanimentStopped.current = false;
    setTesting(false);
  };

  /** 长语音超过短试听窗口后只继续语音；再改滑条也不能重新打开伴奏。 */
  const updateTestVolumes = (next: typeof volumes) => {
    testSession.current?.setVolumes(
      previewAccompanimentStopped.current ? { ...next, beat: 0, music: 0 } : next,
    );
  };

  const createAudio = () =>
    new WebAudioSession<WordBeatCueData>(assets, {
      beatEnabled: lesson.gameData.beatEnabled,
      musicAssetId: lesson.gameData.music.enabled ? lesson.gameData.music.assetId : undefined,
      musicLoop: lesson.gameData.music.loop,
      musicRate:
        lesson.gameData.soundMode === 'chorus' &&
        lesson.gameData.music.syncEnabled &&
        lesson.gameData.music.sync
          ? lesson.gameData.bpm.value / lesson.gameData.music.sync.bpm
          : (lesson.gameData.music.playbackRate ?? 1),
      musicPreservePitch: lesson.gameData.music.preservePitch ?? true,
      musicSync:
        lesson.gameData.soundMode === 'chorus' &&
        lesson.gameData.music.enabled &&
        lesson.gameData.music.syncEnabled
          ? lesson.gameData.music.sync
          : undefined,
      volumes: { ...appliedSettings.volumes },
      resolveAsset,
    });

  const start = async () => {
    if (!sessionPlan.current || incompleteSettings.current) return;
    stopTest();
    setMessage('');
    if (!engine.current) {
      try {
        const audio = createAudio();
        session.current = audio;
        const controller = new TimelineController(sessionPlan.current, audio, {
          mode: initialLesson.current.gameData.progression,
          loop: initialLesson.current.gameData.loop,
        });
        engine.current = controller;
        let displayedKey = '';
        unsubscribe.current = controller.subscribe((next) => {
          if (next.status === 'completed') setSettings(false);
          const activePlan = controller.getTimeline() as WordBeatPlan;
          // 音频和状态机仍逐帧推进；React 仅在可见拍位、整秒或操作状态改变时提交。
          // 避免每帧重建整个舞台及粒子树抢占落拍；绝不对拍位更新加防抖延迟。
          const activeCue = controller.getActiveCue();
          const displayKey = JSON.stringify([
            next.status,
            next.cueIndex,
            activeCue?.id,
            Math.floor(next.elapsedInCueMs / (activeCue?.pulseIntervalMs || 100)),
            Math.floor(next.actualElapsedMs / 1000),
            next.mode,
            next.loop,
            next.repeats,
            next.completedItems,
            next.error,
            next.resourceReady,
            next.hasStarted,
          ]);
          if (displayKey !== displayedKey) {
            displayedKey = displayKey;
            // 订阅由用户操作/音频时钟回调触发，不在 React 生命周期中执行。
            // 真实拍位必须在本帧提交，不能让并发渲染把提示推迟到下一轮装饰绘制后。
            if (next.status === 'running') flushSync(() => setState(next));
            else setState(next);
          }
          setPlan(activePlan);
          if (pendingTempo.current === activePlan) {
            pendingTempo.current = null;
            setPendingBpm(null);
            setPendingRounds(false);
            setMessage(
              `课堂安排已生效，当前节奏 ${activePlan.bpm} BPM。`,
              'success',
              '安排已生效',
              true,
            );
          }
        });
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : '无法初始化声音设备。',
          'error',
          '声音设备未就绪',
        );
        return;
      }
    }
    await engine.current.start();
  };

  latestStart.current = start;

  const testSound = async () => {
    if (testing) {
      stopTest();
      return;
    }
    if (settingsBlocked) return;
    const testPlan = candidate.plan;
    if (!testPlan) return;
    if (
      !lesson.gameData.beatEnabled &&
      !testPlan.cues.some((cue) => cue.audioAssetId) &&
      !lesson.gameData.music.enabled
    ) {
      setMessage('当前无启用声音。');
      return;
    }
    let activeTest: WebAudioSession<WordBeatCueData> | undefined;
    try {
      stopTest();
      setTesting(true);
      setMessage('');
      const audio = createAudio();
      audio.setVolumes(volumes);
      activeTest = audio;
      testSession.current = audio;
      const index = Math.max(
        0,
        testPlan.cues.findIndex(
          (cue) =>
            cue.audioAssetId || (cue.musicPositionMs !== undefined && cue.musicPositionMs >= 0),
        ),
      );
      await audio.prepare(testPlan, index);
      if (testSession.current !== audio) return;
      const sample = testPlan.cues[index];
      // 带语音的样本沿用真实整拍阶段，避免较长口号被1.8秒上限截断或拒播。
      // 只有节拍或背景音乐时仍用短测试，不播放整段准备或整首音乐。
      const durationMs = sample.audioAssetId ? Math.max(1800, sample.durationMs) : 1800;
      const cue = { ...sample, durationMs };
      const startedAt = audio.now();
      audio.play(cue, 0);
      const pulse = () => {
        if (testSession.current !== audio) return;
        audio.tick(cue, Math.max(0, audio.now() - startedAt));
      };
      testInterval.current = setInterval(pulse, 50);
      // 口语样本需完整播放；节拍与音乐只试听短片段，避免长口号延长测试音乐。
      if (durationMs > 1800)
        testShortTimer.current = setTimeout(() => {
          if (testSession.current === audio) {
            previewAccompanimentStopped.current = true;
            audio.setVolumes({ ...latestPreviewVolumes.current, beat: 0, music: 0 });
          }
        }, 1800);
      testTimer.current = setTimeout(() => {
        if (testSession.current === audio) {
          stopTest();
          setMessage('试听结束，请确认教室音箱实际发声。');
        }
      }, durationMs);
    } catch (error) {
      // 已取消的旧试听可能迟到失败，不能停止后来新建的试听或课堂。
      if (activeTest && testSession.current !== activeTest) return;
      stopTest();
      setMessage(
        error instanceof Error ? error.message : '声音测试失败。',
        'error',
        '声音试听未完成',
      );
    }
  };

  useEffect(() => {
    // 轮询只读取音频时钟，不用定时器次数累计拍位；装饰低帧率不应限制教学状态更新。
    let clockPoll: ReturnType<typeof setTimeout>;
    let lastFrame = performance.now();
    const frame = () => {
      const now = performance.now();
      if (now - lastFrame > 2000) engine.current?.pause();
      lastFrame = now;
      engine.current?.tick();
      clockPoll = setTimeout(frame, 16);
    };
    clockPoll = setTimeout(frame, 16);
    const blur = () => {
      engine.current?.pause();
      stopTest();
    };
    const visibility = () => {
      if (document.hidden) {
        engine.current?.pause();
        stopTest();
      }
    };
    const keys = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        incompleteSettings.current ||
        root.current?.querySelector('[role="dialog"][data-state="open"]') ||
        target?.closest(
          'input, textarea, select, button, [role="dialog"], [contenteditable="true"]',
        )
      )
        return;
      if ((event.code === 'Space' || event.code === 'KeyR') && event.repeat) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (engine.current) void engine.current.toggle();
        else void latestStart.current();
      }
      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        void engine.current?.previous();
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault();
        void engine.current?.next();
      }
      if (event.code === 'KeyR') {
        event.preventDefault();
        void engine.current?.repeat();
      }
    };
    const fullscreenChanged = () => setIsFullscreen(document.fullscreenElement === root.current);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('keydown', keys);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => {
      clearTimeout(clockPoll);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('keydown', keys);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      if (testTimer.current) clearTimeout(testTimer.current);
      if (testShortTimer.current) clearTimeout(testShortTimer.current);
      if (testInterval.current) clearInterval(testInterval.current);
      testSession.current?.dispose();
      unsubscribe.current?.();
      engine.current?.dispose();
    };
    // 课堂接收的是固定修订。运行中不通过外层重渲染重建音频会话。
  }, []);

  /**
   * 完成是唯一提交边界：先编排与保存，再安装。写入失败不改变运行安排。
   * 仅本次使用必须由教师明确选择；两条路径都不自动继续已暂停的课堂。
   */
  const completeSettings = (sessionOnly = false) => {
    if (settingsBlocked || !candidate.plan) return;
    try {
      if (!sessionOnly) saveClassroomSettings(lesson, assets, draftSettings);
      const next = candidate.plan;
      const nextLesson = candidate.lesson;
      // 词表身份／顺序改变不能套用旧条目索引。完成前已明确说明会从头开始，
      // 写入成功后才释放旧课堂；保存失败仍保留原运行位置和全部草稿。
      if (classroomWordStructureChanged(initialLesson.current, nextLesson)) {
        savedSession.current = draftSettings;
        resetClassroom(draftSettings);
        setMessage(
          `${sessionOnly ? '新词表仅用于本次打开。' : '新词表与全部设置已保存到当前浏览器。'}${state.hasStarted ? '已返回开始页，请按新词表重新开始课堂。' : '现在可按新词表开始课堂。'}`,
          sessionOnly ? 'warning' : 'success',
          '词表已更新',
        );
        return;
      }
      const roundsChanged = getEntries(nextLesson).some(
        (entry, index) =>
          entry.rounds.value !== getEntries(initialLesson.current)[index].rounds.value,
      );
      const rhythmChanged = classroomRhythmChanged(initialLesson.current, nextLesson);
      const chorusCountsChanged = classroomRhythmChanged(initialLesson.current, nextLesson, false);
      const wordsChanged =
        classroomWordsChanged(initialLesson.current, nextLesson) ||
        nextLesson.gameData.soundMode !== initialLesson.current.gameData.soundMode;
      const practiceChanged = getEntries(nextLesson).some((entry, index) => {
        const previous = getEntries(initialLesson.current)[index];
        return (
          entry.entryType !== previous.entryType ||
          entry.modelBeats.value !== previous.modelBeats.value ||
          JSON.stringify(entry.follow) !== JSON.stringify(previous.follow)
        );
      });
      const structureChanged = roundsChanged || rhythmChanged || wordsChanged || practiceChanged;
      const timelineChanged =
        structureChanged ||
        nextLesson.gameData.bpm.value !== initialLesson.current.gameData.bpm.value ||
        nextLesson.gameData.resumePreparationBeats !==
          initialLesson.current.gameData.resumePreparationBeats;
      stopTest();
      const controller = engine.current;
      if (controller && timelineChanged)
        controller.replaceTimeline(next, structureChanged || pendingRounds);
      else if (!controller) setPlan(next);
      const previousRounds = new Map(
        getEntries(initialLesson.current).map((entry) => [entry.id, { ...entry.rounds }]),
      );
      const previousRhythm = new Map(
        getEntries(initialLesson.current).map((entry) => [
          entry.id,
          structuredClone(getClassroomChorus(entry)),
        ]),
      );
      initialLesson.current = structuredClone(nextLesson);
      sessionPlan.current = next;
      const deferred = !!controller && timelineChanged && controller.getTimeline() !== next;
      if (timelineChanged) {
        pendingTempo.current = deferred ? next : null;
        setPendingBpm(deferred ? next.bpm : null);
        setPendingRounds(deferred && (structureChanged || pendingRounds));
      }
      // 等待教师时切自动不能在提交中自行开播，先保持暂停再修改模式。
      if (
        controller?.getState().status === 'waiting' &&
        nextLesson.gameData.progression !== state.mode
      )
        controller.pause();
      if (controller) {
        controller.setMode(nextLesson.gameData.progression);
        controller.setLoop(nextLesson.gameData.loop);
        session.current?.setVolumes(nextLesson.gameData.volumes);
      } else
        setState((previous) => ({
          ...previous,
          mode: nextLesson.gameData.progression,
          loop: nextLesson.gameData.loop,
        }));
      setAppliedSettings(draftSettings);
      savedSession.current = draftSettings;
      setDraftLesson(structuredClone(nextLesson));
      setBulkDraft((previous) => createClassroomBulkDraft(nextLesson, previous.scope));
      setRoundDraft(null);
      setRhythmDraft(null);
      setRhythmBulk({ beats: null, beatsPerRead: null });
      // 每次真实提交都刷新一次撤销快照；连续保存不能一直退回第一笔调整前。
      if (roundsChanged) setRoundUndo(previousRounds);
      if (chorusCountsChanged) setRhythmUndo(previousRhythm);
      setStorageError('');
      setMessage(
        `${sessionOnly ? '设置仅用于本次打开，未保存到浏览器。' : '已保存到当前浏览器，关闭重开仍可恢复。'}${deferred ? '节奏将在下一词生效；内容、轮数与齐读安排在下一词或重玩生效，当前词和重读保持原安排。' : controller && timelineChanged ? '节奏已更新，继续后从当前阶段起点生效。' : ''}${controller ? '请手动继续课堂。' : ''}`,
        sessionOnly ? 'warning' : deferred ? 'info' : 'success',
        sessionOnly ? '仅本次使用' : deferred ? '已保存 · 等待下一词' : '设置已保存',
        !sessionOnly && !deferred,
      );
      setSettings(false);
    } catch (failure) {
      setStorageError(failure instanceof Error ? failure.message : '未能完成设置，请重试。');
    }
  };

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      setMessage('可继续使用窗口模式上课。');
    }
  };
  const exit = () => {
    stopTest();
    engine.current?.dispose();
    onExit?.();
  };
  /** 返回开始页清空运行资源及进度；设置使用最后完成的快照，而非课件默认值。 */
  const resetClassroom = (preferences = savedSession.current) => {
    const restored = applyClassroomSettings(lesson, preferences, assets);
    const restoredPlan = compileWordBeat(restored, assets);
    stopTest();
    unsubscribe.current?.();
    unsubscribe.current = null;
    engine.current?.dispose();
    engine.current = null;
    session.current = null;
    setPlan(restoredPlan);
    sessionPlan.current = restoredPlan;
    initialLesson.current = structuredClone(restored);
    setDraftLesson(structuredClone(restored));
    setAppliedSettings(preferences);
    setResumePreparation(preferences.resumePreparationBeats);
    setShowWordTrack(preferences.showWordTrack);
    setSettings(false);
    setRoundDraft(null);
    setRhythmDraft(null);
    setRhythmBulk({ beats: null, beatsPerRead: null });
    setRhythmUndo(null);
    setGapInput(String(restored.gameData.chorusGapBeats ?? 0));
    setBulkDraft(createClassroomBulkDraft(restored));
    setRoundUndo(null);
    setPendingRounds(false);
    setMessage('');
    setBpmInput(String(preferences.bpm));
    setStorageError('');
    setRestoreConfirm(false);
    setPendingBpm(null);
    pendingTempo.current = null;
    setShowMeaning(preferences.showMeaning);
    setDisplayMode(preferences.displayMode);
    setStageEffects(preferences.stageEffects);
    setVolumes({ ...preferences.volumes });
    setVolumeInputs(
      Object.fromEntries(
        Object.entries(preferences.volumes).map(([part, value]) => [
          part,
          String(Math.round(value * 100)),
        ]),
      ),
    );
    setState({ ...initialState, mode: preferences.progression, loop: preferences.loop });
  };
  const returnToStart = () => resetClassroom();
  /** 只有教师确认才删除本课记录；失败不重置、不中断现有课堂。 */
  const restoreOriginal = () => {
    try {
      const preferences = captureClassroomSettings(lesson);
      // 先核验原课件仍可运行，再删除偏好；无效原课件不能造成记录已删却恢复失败。
      applyClassroomSettings(lesson, preferences, assets);
      clearClassroomSettings(lesson);
      savedSession.current = preferences;
      resetClassroom(preferences);
      setMessage('已清除本课本地设置，并恢复课件原始设置。', 'success', '已恢复原课件', true);
    } catch (failure) {
      setStorageError(failure instanceof Error ? failure.message : '无法恢复原设置，请重试。');
    }
  };
  const endClassroom = () => {
    discardDrafts(
      settingsDirty || settingsBlocked
        ? '课堂已结束，已放弃未完成输入，保留上次完成的设置。'
        : '课堂已结束。',
    );
    stopTest();
    engine.current?.end();
  };
  const cue = engine.current?.getActiveCue() ?? plan?.cues[state.cueIndex];
  const navigation = cue?.navigation;
  // 同轮示范和跟读共用拍序；采用控制器当前编排，确保调速生效后不读到旧时间轴。
  const activePlan = engine.current?.getTimeline() ?? plan;
  const beatsElapsed = getWordBeatBeatProgress(
    cue,
    activePlan?.cues[state.cueIndex - 1],
    state.elapsedInCueMs,
  );
  const activeBeat = beatsElapsed % 4;
  // 直接读取编排已有的准备拍：四拍显示 3、2、1、GO，不增加等待或另启倒数时钟。
  // 分组准备可能只有两拍，按其实际剩余拍显示 1、GO；暂停时随课堂位置冻结。
  const preparation = cue?.kind === 'preparation' || cue?.kind === 'resume-preparation';
  const remainingPreparationBeats =
    preparation && cue?.pulseIntervalMs
      ? Math.max(1, Math.ceil((cue.durationMs - state.elapsedInCueMs) / cue.pulseIntervalMs))
      : 0;
  const preparationText =
    remainingPreparationBeats > 1 ? String(remainingPreparationBeats - 1) : 'GO';
  // 词序轨与门户读取实际安装的时间轴，既不显示原课件旧文，也不提前显示待生效草稿。
  const entries = useMemo(() => {
    if (!activePlan) return getEntries(lesson);
    return activePlan.items.map((item) => {
      const data = activePlan.cues[item.firstCue]?.data;
      return { id: item.id, english: data?.english ?? '', meaning: data?.meaning ?? '' };
    });
  }, [lesson, activePlan]);
  // 与正式编排一样忽略空段；单组不需要定位，多组才保留组号及教师命名。
  const hasMultipleGroups =
    new Set(
      activePlan?.cues.filter((item) => item.itemIndex !== null).map((item) => item.sectionIndex),
    ).size > 1;
  const hasMultipleWords = entries.length > 1;
  const hasSound =
    lesson.gameData.beatEnabled ||
    lesson.gameData.music.enabled ||
    soundCues.some((item) => item.audioAssetId);
  // 只有教学阶段才在拍垫重复词语；组名和口号不属于朗读对象。
  const reading = cue?.kind === 'model' || cue?.kind === 'follow' || cue?.kind === 'chorus';
  const preparationBeats =
    preparation && cue?.pulseIntervalMs
      ? Math.round(cue.durationMs / cue.pulseIntervalMs)
      : undefined;
  const trackStart = Math.max(0, Math.min(entries.length - 5, (cue?.itemIndex ?? 0) - 2));
  const motion = useClassroomMotion(appliedSettings.stageEffects && state.status === 'running');
  // 开场可展示低速氛围；暂停、等待、后台和减少动态设置都必须停止运动。
  const lobbyMotion = useClassroomMotion(appliedSettings.stageEffects && !state.hasStarted);
  const progress = entries.length > 0 ? Math.min(1, state.completedItems / entries.length) : 0;
  // 首批资源准备和失败属于开始页；运行后的异常保留现场供教师重试。
  const started = state.hasStarted;
  const settingsOpen = settings && state.status !== 'completed';
  const scene = state.status === 'completed' ? 'result' : started ? 'playing' : 'lobby';
  useEffect(() => {
    // 只有场景变化才接续焦点，逐拍刷新、暂停与设置调整不能抢走当前操作。
    if (previousScene.current === scene) return;
    previousScene.current = scene;
    if (scene === 'result') resultTitle.current?.focus();
    else if (scene === 'lobby') startButton.current?.focus();
    else root.current?.focus();
  }, [scene]);
  /**
   * 模态设置会隐藏课堂主体的辅助技术语义，因此反馈必须随打开状态移入设置内容。
   * 两个位置互斥渲染同一份内容，避免重复播报，也防止重开设置后旧状态区域被 aria-hidden。
   */
  const feedback =
    message || state.error || playBlocked ? (
      <ClassroomNotice
        tone={
          state.error || settingsBlocked || notice.tone === 'error'
            ? 'error'
            : playBlocked
              ? 'warning'
              : notice.tone
        }
        title={
          state.error
            ? '课堂播放已中断'
            : settingsBlocked
              ? '请先处理设置问题'
              : notice.tone === 'error'
                ? notice.title
                : playBlocked
                  ? '设置尚未完成'
                  : notice.title
        }
        onDismiss={
          !state.error && !playBlocked && notice.tone !== 'error'
            ? () => {
                // 只接续即将被卸载的通知焦点，不因消息关闭抢走其他输入焦点。
                if (document.activeElement?.closest('.ecg-classroom-message')) {
                  const target = settingsOpen
                    ? completeButton.current
                    : !started
                      ? startButton.current
                      : state.status === 'completed'
                        ? resultTitle.current
                        : playButton.current;
                  (target ?? root.current)?.focus({ preventScroll: true });
                }
                setMessage('');
              }
            : undefined
        }
      >
        {/* 设备故障不代表教学失败；保留当前词，说明可恢复动作，不抢走教师焦点。 */}
        <span>
          {state.error ??
            (settingsBlocked
              ? `${settingsIssues[0].label.replace(/[。]+$/u, '')}。${settingsOpen ? '请修正或放弃未完成输入。' : '请打开课堂设置修正或放弃未完成输入。'}`
              : notice.tone === 'error'
                ? message
                : playBlocked
                  ? '课堂设置有待保存的修改，请完成设置或放弃未完成输入。'
                  : message)}
          {state.error && (
            <span className="ecg-error-recovery">
              {started
                ? `${settingsOpen ? '关闭设置后，' : ''}点击“重试当前阶段”继续。`
                : '检查声音设备后，点击“开始课堂”重试。'}
            </span>
          )}
          {!state.error && !settingsBlocked && notice.tone === 'error' && (
            <span className="ecg-error-recovery">
              {settingsDirty
                ? '请先完成设置或放弃未完成输入，再测试声音或重试课堂。'
                : settingsOpen
                  ? '可点击“测试声音”重试，或收起设置后重试课堂。'
                  : '检查声音设备后，可重新测试声音或开始课堂。'}
            </span>
          )}
        </span>
      </ClassroomNotice>
    ) : null;
  const stage =
    state.status === 'error'
      ? '播放已中断'
      : state.status === 'paused'
        ? state.resourceReady
          ? '声音已就绪，请点击继续'
          : '已暂停'
        : state.status === 'waiting'
          ? '等待教师'
          : state.status === 'preparing'
            ? '准备声音资源'
            : (cue?.data.label ?? '准备');

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-theme="classroom"
      data-motion={motion || lobbyMotion}
      data-state={started ? state.status : 'lobby'}
      className={`ecg-classroom ecg-classroom--${appliedSettings.displayMode}`}
    >
      <ClassroomAtmosphere
        active={motion || lobbyMotion}
        beatKey={
          started
            ? `${cue?.id ?? 'idle'}-${Math.floor(beatsElapsed / (cue?.data.beatsPerRead ?? 1))}`
            : undefined
        }
        phase={cue?.kind}
        intensity={1}
      />
      <Dialog.Root
        open={settingsOpen}
        onOpenChange={(open) => {
          // 设置遮住舞台时暂停教学；收起后由教师明确继续，避免边调设置边错过词语。
          if (open) {
            if (engine.current?.getState().status === 'running') engine.current.pause();
            stopTest();
          } else stopTest();
          setSettings(open);
        }}
      >
        <header className="ecg-classroom-header">
          <div className="ecg-classroom-heading">
            <span className="ecg-classroom-brand" aria-hidden="true">
              <Waveform size={24} weight="duotone" />
            </span>
            <div>
              <strong>{lesson.name}</strong>
              <span>
                WORD BEAT /{' '}
                {appliedSettings.soundMode === 'chorus'
                  ? '学生自主齐读'
                  : appliedSettings.soundMode === 'voiced'
                    ? '配音跟读'
                    : '文字领读'}
              </span>
            </div>
          </div>
          <div className="ecg-classroom-actions">
            {started && state.status !== 'completed' && onExit && (
              <button onClick={exit}>
                <ArrowLeft size={19} aria-hidden="true" />
                {exitLabel ?? '返回编辑'}
              </button>
            )}
            {!started && state.status !== 'completed' && (
              <Dialog.Trigger asChild>
                <button disabled={state.status === 'preparing'}>
                  <SlidersHorizontal size={19} aria-hidden="true" />
                  课堂设置
                </button>
              </Dialog.Trigger>
            )}
            {(!started || state.status === 'completed') && (
              <button onClick={() => void fullscreen()}>
                {isFullscreen ? (
                  <CornersIn size={19} aria-hidden="true" />
                ) : (
                  <CornersOut size={19} aria-hidden="true" />
                )}
                {isFullscreen ? '退出全屏' : '全屏'}
              </button>
            )}
            <div className="ecg-classroom-progress">
              <span className="ecg-classroom-progress-dot" aria-hidden="true" />
              {started && state.status !== 'completed'
                ? `${hasMultipleGroups && cue?.sectionIndex != null ? `第 ${cue.sectionIndex + 1} 组 · ` : ''}${cue?.itemIndex != null ? `${cue.itemIndex + 1} / ` : ''}${entries.length} 词`
                : '离线课堂'}
            </div>
          </div>
        </header>
        {!started && state.status !== 'completed' && (
          <main className="ecg-classroom-start ecg-classroom-lobby">
            <div className="ecg-lobby-copy">
              <div className="ecg-game-kicker">
                <Sparkle size={16} weight="fill" aria-hidden="true" /> AI 智能编排 · 离线就绪
              </div>
              <span className="ecg-stage-label">
                <Waveform size={18} aria-hidden="true" />
                单词节拍
              </span>
              <div className="ecg-lobby-slogan" aria-hidden="true">
                让每个单词，
                <br />
                <em>都有节奏。</em>
              </div>
              <h1>{lesson.name}</h1>
              <p className="ecg-classroom-caption">
                {entries.length} 个词语 · 编排时长 {plan ? formatTime(plan.durationMs) : '尚未准备'}{' '}
                · 修订 {lesson.revision}
              </p>
              <div className="ecg-start-facts">
                <span>
                  <Clock size={18} aria-hidden="true" />
                  {plan?.bpm ?? lesson.gameData.bpm.value} BPM
                </span>
                {hasMultipleWords && (
                  <span>推进方式：{state.mode === 'step' ? '逐词等待教师' : '自动推进'}</span>
                )}
              </div>
              <p className="ecg-classroom-small-note">
                {!hasMultipleWords
                  ? '按设定轮数完成这个词，可随时暂停或重读。'
                  : state.mode === 'auto'
                    ? lesson.gameData.soundMode === 'chorus'
                      ? '无需示范，同词按拍齐读，完成全部轮次后连续换词。'
                      : '点击开始后，示范、跟读与下一词会随节拍自动衔接。随时可以暂停或重读。'
                    : '词内按节拍运行，每词结束后由教师继续。教师等待和暂停另计。'}
              </p>
              {state.status === 'preparing' && <p role="status">正在准备首批声音资源…</p>}
              {exportedAt && <p>导出时间：{new Date(exportedAt).toLocaleString()}</p>}
              {issues.filter((issue) => issue.severity === 'error').length > 0 && (
                <div className="ecg-classroom-error" role="alert">
                  <h2>请先修复课件</h2>
                  <ul>
                    {issues
                      .filter((issue) => issue.severity === 'error')
                      .map((issue, index) => (
                        <li key={`${issue.code}-${index}`}>{issue.message}</li>
                      ))}
                  </ul>
                </div>
              )}
              {!hasSound && (
                <p className="ecg-classroom-small-note">本课按画面节奏练习，未启用声音。</p>
              )}
              <div className="ecg-classroom-actions">
                {hasSound && (
                  <button
                    onClick={() => void testSound()}
                    disabled={!originalPlan || playBlocked || state.status === 'preparing'}
                  >
                    {testing ? (
                      <Stop size={20} aria-hidden="true" />
                    ) : (
                      <SpeakerHigh size={20} aria-hidden="true" />
                    )}
                    {testing ? '停止测试' : '测试声音'}
                  </button>
                )}
                <button
                  ref={startButton}
                  className="ecg-button-primary"
                  disabled={!originalPlan || playBlocked || state.status === 'preparing'}
                  onClick={() => void start()}
                >
                  <Play size={21} weight="fill" aria-hidden="true" />
                  {state.status === 'preparing' ? '正在准备…' : '开始课堂'}
                </button>
                {onExit && (
                  <button onClick={exit}>
                    <ArrowLeft size={19} aria-hidden="true" />
                    {exitLabel ?? '返回编辑'}
                  </button>
                )}
              </div>
              <div className="ecg-lobby-legal-row">
                <p className="ecg-shortcuts">
                  <kbd>Space</kbd> 暂停 / 继续 <kbd>← →</kbd> 切词 <kbd>R</kbd> 重读
                </p>
                <SoftwareLicense />
              </div>
            </div>
            <StagePortal words={entries.map((entry) => entry.english)} />
          </main>
        )}
        {started && state.status !== 'completed' && (
          <main className="ecg-classroom-stage" data-animated={motion} data-phase={cue?.kind}>
            <div className="ecg-arena-corner ecg-arena-corner--left" aria-hidden="true" />
            <div className="ecg-arena-corner ecg-arena-corner--right" aria-hidden="true" />
            {/* 邻词只作舞台导航；当前完整原文仅由下方唯一教学区承载。 */}
            <div
              className="ecg-word-track"
              aria-hidden="true"
              hidden={!appliedSettings.showWordTrack || !hasMultipleWords}
            >
              {entries.slice(trackStart, trackStart + 5).map((entry, index) => (
                <span
                  key={entry.id}
                  className="ecg-word-track-item"
                  data-current={trackStart + index === cue?.itemIndex}
                  data-past={trackStart + index < (cue?.itemIndex ?? 0)}
                >
                  <span className="ecg-word-track-index">
                    {String(trackStart + index + 1).padStart(2, '0')}
                  </span>
                  <span className="ecg-word-track-word" data-word={entry.english} />
                </span>
              ))}
            </div>
            <div className="ecg-stage-topline">
              <span className="ecg-stage-mode">
                <Sparkle size={15} aria-hidden="true" />{' '}
                {!hasMultipleWords ? '节拍练习' : state.mode === 'auto' ? '自动编排' : '教师控制'}
              </span>
              <span
                className={`ecg-stage-label ${cue?.kind === 'follow' ? 'ecg-stage-label--follow' : ''}`}
                data-error={state.status === 'error'}
                aria-live="polite"
              >
                {stage}
              </span>
              <span className="ecg-stage-tempo">
                <Waveform size={17} aria-hidden="true" />
                {cue?.data.totalBeats ? `${beatsElapsed + 1} / ${cue.data.totalBeats} 拍 · ` : ''}
                {plan?.bpm ?? lesson.gameData.bpm.value} BPM
              </span>
            </div>
            <TeachingContent
              key={`${cue?.id ?? 'idle'}-${preparation ? preparationText : ''}`}
              english={preparation ? preparationText : cue?.data.english || '准备下一词'}
              meaning={
                preparation
                  ? hasMultipleGroups
                    ? cue?.data.segmentName
                    : undefined
                  : appliedSettings.showMeaning
                    ? cue?.data.meaning
                    : undefined
              }
            />
            {/* 拍位与计时高频更新只供主动读取，避免读屏在教学声音上逐拍播报。 */}
            <BeatTrail
              mode={appliedSettings.displayMode}
              english={reading ? cue?.data.english : undefined}
              preparationBeats={preparationBeats}
              activeBeat={activeBeat}
              beatsElapsed={beatsElapsed}
              totalBeats={cue?.data.totalBeats}
              beatsPerRead={cue?.data.beatsPerRead}
              playing={state.status === 'running'}
              animations={motion}
              timelineKey={cue?.id ?? 'idle'}
            />
            <div className="ecg-classroom-detail" aria-live="off">
              <span className="ecg-detail-rule" />
              {cue?.round ? `第 ${cue.round} / ${cue.data.roundCount} 轮 · ` : ''}实际用时{' '}
              {formatTime(state.actualElapsedMs)}
              <span className="ecg-detail-rule" />
            </div>
          </main>
        )}
        {state.status === 'completed' && (
          <main
            className="ecg-classroom-start ecg-classroom-completed"
            data-result={state.completionReason}
          >
            <div
              className={`ecg-stage-emblem ${state.completionReason === 'finished' ? 'ecg-stage-emblem--complete' : 'ecg-stage-emblem--ended'}`}
              aria-hidden="true"
            >
              <span />
              <span />
              {state.completionReason === 'finished' ? (
                <CheckCircle size={58} weight="duotone" />
              ) : (
                <Stop size={58} weight="duotone" />
              )}
              {state.completionReason === 'finished' && (
                <CompletionBurst enabled={appliedSettings.stageEffects} />
              )}
            </div>
            <span className="ecg-stage-label">
              {state.completionReason === 'finished' ? '练习完成' : '已提前结束'}
            </span>
            <h1 ref={resultTitle} tabIndex={-1}>
              本次练习记录
            </h1>
            <div className="ecg-session-stats">
              <div>
                <Clock size={24} aria-hidden="true" />
                <span>课堂时长</span>
                <strong>{formatTime(state.actualElapsedMs)}</strong>
              </div>
              <div
                role="group"
                aria-label={`已完成 ${state.completedItems} / ${entries.length} 条`}
              >
                <Stack size={24} aria-hidden="true" />
                <span>练习条目</span>
                <strong>
                  {state.completedItems}
                  <small> / {entries.length}</small>
                </strong>
              </div>
              <div role="group" aria-label={`主动重读 ${state.repeats} 次`}>
                <ArrowCounterClockwise size={24} aria-hidden="true" />
                <span>教师重读</span>
                <strong>
                  {state.repeats}
                  <small> 次</small>
                </strong>
              </div>
            </div>
            <p className="ecg-classroom-caption">
              <span className="ecg-result-note">仅记录课堂运行，不评价学生掌握程度。</span>
            </p>
            <div className="ecg-classroom-actions">
              <button className="ecg-button-primary" onClick={() => void start()}>
                <ArrowCounterClockwise size={21} aria-hidden="true" />
                重新播放
              </button>
              {onExit && (
                <button onClick={exit}>
                  <ArrowLeft size={19} aria-hidden="true" />
                  {exitLabel ?? '返回编辑'}
                </button>
              )}
              {!onExit && (
                <button onClick={returnToStart}>
                  <ArrowLeft size={19} aria-hidden="true" />
                  回到开始页
                </button>
              )}
            </div>
          </main>
        )}
        {!settingsOpen && feedback && <div className="ecg-classroom-notice-layer">{feedback}</div>}
        {started && state.status !== 'completed' && (
          <footer className="ecg-classroom-controls">
            {/* 进度只取控制器已完成条目；不将装饰能量误作学生得分。 */}
            <div
              className="ecg-run-progress"
              style={{ '--run-progress': `${progress * 100}%` } as CSSProperties}
            >
              <span />
            </div>
            <div className="ecg-control-status" aria-live="off">
              <Waveform size={24} aria-hidden="true" />
              <span>
                <strong>
                  {!hasMultipleWords ? '节拍练习' : state.mode === 'auto' ? '自动节拍' : '逐词等待'}
                </strong>
                <small>
                  已完成 {state.completedItems} / {entries.length} 词
                </small>
              </span>
            </div>
            <div className="ecg-classroom-actions ecg-transport">
              <button
                disabled={playBlocked || navigation?.previous === null}
                onClick={() => void engine.current?.previous()}
              >
                <SkipBack size={19} aria-hidden="true" />
                上一词
              </button>
              <button
                ref={playButton}
                className="ecg-button-primary ecg-play-core"
                disabled={playBlocked}
                onClick={() => void engine.current?.toggle()}
              >
                {state.status === 'running' ? (
                  <Pause size={21} weight="fill" aria-hidden="true" />
                ) : (
                  <Play size={21} weight="fill" aria-hidden="true" />
                )}
                {state.status === 'paused'
                  ? '继续'
                  : state.status === 'waiting'
                    ? '继续下一词'
                    : state.status === 'error'
                      ? '重试当前阶段'
                      : '暂停'}
                <kbd aria-hidden="true">SPACE</kbd>
              </button>
              <button
                disabled={playBlocked || navigation?.next === null}
                onClick={() => void engine.current?.next()}
              >
                下一词
                <SkipForward size={19} aria-hidden="true" />
              </button>
              <button
                disabled={playBlocked || navigation?.repeat === null}
                onClick={() => void engine.current?.repeat()}
              >
                <ArrowCounterClockwise size={19} aria-hidden="true" />
                重读
              </button>
            </div>
            <div className="ecg-classroom-actions ecg-tools">
              <button onClick={endClassroom}>
                <Stop size={19} aria-hidden="true" />
                结束课堂
              </button>
              <Dialog.Trigger asChild>
                <button>
                  <SlidersHorizontal size={19} aria-hidden="true" />
                  课堂设置
                </button>
              </Dialog.Trigger>
              <button onClick={() => void fullscreen()}>
                {isFullscreen ? (
                  <CornersIn size={19} aria-hidden="true" />
                ) : (
                  <CornersOut size={19} aria-hidden="true" />
                )}
                {isFullscreen ? '退出全屏' : '全屏'}
              </button>
            </div>
          </footer>
        )}
        <Dialog.Portal container={root.current}>
          <Dialog.Overlay className="ecg-classroom-overlay" />
          <Dialog.Content
            className="ecg-classroom-settings"
            aria-describedby="classroom-settings-description"
            onCloseAutoFocus={(event) => {
              // 结束时设置触发器已卸载，不能让模态恢复逻辑把焦点丢回 body。
              if (engine.current?.getState().status === 'completed') {
                event.preventDefault();
                resultTitle.current?.focus();
              }
            }}
          >
            <div className="ecg-settings-header ecg-classroom-actions">
              <span className="ecg-settings-icon" aria-hidden="true">
                <SlidersHorizontal size={24} />
              </span>
              <Dialog.Title>课堂设置</Dialog.Title>
              <Dialog.Close asChild>
                <button>
                  <X size={18} aria-hidden="true" />
                  收起
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description
              id="classroom-settings-description"
              className="ecg-settings-description"
            >
              完成后保存在当前浏览器，不修改原课件。
              {started ? '课堂已暂停，完成后手动继续。' : '调整练习安排，再开始课堂。'}
            </Dialog.Description>
            <nav className="ecg-settings-nav" aria-label="设置分区">
              {(
                [
                  ['rounds', '练习安排'],
                  ['tempo', '节奏与推进'],
                  ['visual', '画面与提示'],
                  ['sound', '声音与音量'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} onClick={() => focusSetting(`classroom-settings-${id}`)}>
                  {label}
                </button>
              ))}
            </nav>
            <div className="ecg-settings-body">
              <ClassroomRounds
                lesson={draftLesson}
                originalLesson={lesson}
                assets={assets}
                savedLesson={initialLesson.current}
                previewLesson={candidate.lesson}
                durationMs={settingsBlocked ? null : (candidate.plan?.durationMs ?? null)}
                pending={pendingRounds}
                started={started}
                activeEntryId={cue?.data.entryId}
                draft={roundDraft}
                onDraft={setRoundDraft}
                undo={roundUndo}
                onUndo={setRoundUndo}
                bulkDraft={bulkDraft}
                onBulkDraft={setBulkDraft}
                rhythmDraft={rhythmDraft}
                onRhythmDraft={setRhythmDraft}
                rhythmBulk={rhythmBulk}
                onRhythmBulk={setRhythmBulk}
                rhythmUndo={rhythmUndo}
                onRhythmUndo={setRhythmUndo}
                onApply={(nextLesson) => {
                  // 文字候选变更后旧试听已过期；取消准备与播放，迟到回调由会话身份挡住。
                  // 轮数等安排变化不属于临时文字，音量仍走原有实时混音通道。
                  if (classroomWordsChanged(draftLesson, nextLesson)) stopTest();
                  setDraftLesson(nextLesson);
                  setStorageError('');
                }}
              />
              {lesson.gameData.soundMode === 'voiced' &&
                (staleWords.length > 0 || draftLesson.gameData.soundMode === 'teacher') && (
                  <section className="ecg-settings-section">
                    <h3>临时词语与配音</h3>
                    {draftLesson.gameData.soundMode === 'voiced' ? (
                      <>
                        <p>
                          {staleWords.length} 个词与原配音不匹配，不能播放旧读音。
                          可还原英文或回编辑器制作新配音；也可将本课全部词改为文字领读，由教师示范。
                          原配音保留，拍数按已有教师示范安排重新计算。
                        </p>
                        <button
                          id="classroom-word-sound-fallback"
                          onClick={() => {
                            stopTest();
                            setDraftLesson((previous) => ({
                              ...previous,
                              gameData: { ...previous.gameData, soundMode: 'teacher' },
                            }));
                          }}
                        >
                          本课改为文字领读
                        </button>
                      </>
                    ) : (
                      <>
                        <p>本课全部词将由教师示范；原配音保留，底部完成设置统一保存。</p>
                        <button
                          onClick={() => {
                            stopTest();
                            setDraftLesson((previous) => ({
                              ...previous,
                              gameData: { ...previous.gameData, soundMode: 'voiced' },
                            }));
                          }}
                        >
                          恢复配音跟读
                        </button>
                      </>
                    )}
                  </section>
                )}
              <section
                id="classroom-settings-tempo"
                tabIndex={-1}
                className="ecg-settings-section ecg-settings-tempo"
              >
                <h3>节奏与推进</h3>
                <div className="ecg-settings-fields">
                  {lesson.gameData.soundMode === 'chorus' && hasMultipleWords && (
                    <div className="ecg-settings-field">
                      <div className="setting-label">
                        <label>
                          词间间隔
                          <input
                            id="classroom-chorus-gap"
                            type="number"
                            min={0}
                            max={4}
                            step={1}
                            value={gapInput}
                            aria-invalid={!validSettingInteger(gapInput, 0, 4)}
                            aria-describedby="classroom-gap-feedback"
                            onChange={(event) => setGapInput(event.target.value)}
                          />
                        </label>
                        <HelpTip label="词间间隔">{WORD_BEAT_HELP.gap}</HelpTip>
                      </div>
                      <p
                        id="classroom-gap-feedback"
                        className={
                          !validSettingInteger(gapInput, 0, 4) ? 'ecg-volume-error' : undefined
                        }
                      >
                        {!validSettingInteger(gapInput, 0, 4)
                          ? '请输入 0～4 的整数拍。'
                          : Number(gapInput) === 0
                            ? '连续换词，不额外插空拍；同词多轮连续。'
                            : `每词完成全部轮次后，额外留 ${gapInput} 拍再换词。`}
                      </p>
                    </div>
                  )}
                  {hasMultipleWords && (
                    <div className="ecg-settings-field">
                      <div className="setting-label">
                        <label>
                          推进方式
                          <select
                            value={draftLesson.gameData.progression}
                            onChange={(event) => {
                              const mode = event.target.value as 'auto' | 'step';
                              setDraftLesson((previous) => ({
                                ...previous,
                                gameData: { ...previous.gameData, progression: mode },
                              }));
                            }}
                          >
                            <option value="auto">自动推进</option>
                            <option value="step">逐词等待</option>
                          </select>
                        </label>
                        <HelpTip label="推进方式">{WORD_BEAT_HELP.progression}</HelpTip>
                      </div>
                      <p className="ecg-classroom-small-note">
                        {draftLesson.gameData.progression === 'auto'
                          ? '全部轮次完成后自动换词，适合连续练习。'
                          : '每词读完等待教师，适合讲解后再继续。'}
                      </p>
                    </div>
                  )}
                  <div className="ecg-settings-field">
                    <div className="setting-label">
                      <label>
                        节奏 BPM
                        <div className="ecg-inline-input">
                          <input
                            id="classroom-bpm-input"
                            type="number"
                            aria-label="节奏 BPM"
                            min={50}
                            max={180}
                            step={1}
                            aria-invalid={!musicSynced && !validBpm}
                            aria-describedby="classroom-bpm-feedback"
                            disabled={
                              lesson.gameData.soundMode === 'chorus' &&
                              lesson.gameData.music.enabled &&
                              lesson.gameData.music.syncEnabled
                            }
                            value={bpmInput}
                            onChange={(event) => {
                              setBpmInput(event.target.value);
                            }}
                          />
                        </div>
                      </label>
                      <HelpTip label="节奏 BPM">{WORD_BEAT_HELP.bpm}</HelpTip>
                    </div>
                    <p
                      id="classroom-bpm-feedback"
                      className={!validBpm ? 'ecg-volume-error' : undefined}
                    >
                      {!validBpm
                        ? '请输入 50～180 的整数 BPM。'
                        : Number(bpmInput) !== appliedSettings.bpm
                          ? '待保存：点底部完成设置，一起应用。'
                          : ''}
                      当前节奏：{plan?.bpm ?? lesson.gameData.bpm.value} BPM。
                      {pendingBpm !== null &&
                        `待生效：${pendingBpm} BPM（下一词或切到其他词时生效）。`}
                    </p>
                  </div>
                  <div className="setting-label">
                    <label className="ecg-checkbox">
                      <input
                        type="checkbox"
                        checked={draftLesson.gameData.loop}
                        onChange={(event) => {
                          const loop = event.target.checked;
                          setDraftLesson((previous) => ({
                            ...previous,
                            gameData: { ...previous.gameData, loop },
                          }));
                        }}
                      />
                      整课循环
                    </label>
                    <HelpTip label="整课循环">{WORD_BEAT_HELP.loop}</HelpTip>
                  </div>
                  <div className="ecg-settings-field">
                    <div className="setting-label">
                      <label className="ecg-checkbox">
                        <input
                          type="checkbox"
                          checked={resumePreparation === 2}
                          disabled={!!engine.current}
                          aria-describedby={
                            engine.current ? 'classroom-resume-preparation-note' : undefined
                          }
                          onChange={(event) => {
                            const beats = event.target.checked ? 2 : 0;
                            setResumePreparation(beats);
                          }}
                        />
                        继续前准备两拍
                      </label>
                      <HelpTip label="继续前准备两拍">{WORD_BEAT_HELP.resume}</HelpTip>
                    </div>
                    {!!engine.current && (
                      <p id="classroom-resume-preparation-note">
                        仅课前调整；需要修改请回到开始页。
                      </p>
                    )}
                  </div>
                </div>
                {musicSynced && (
                  <p className="ecg-classroom-small-note">
                    音乐对拍已按 {lesson.gameData.bpm.value} BPM
                    准备。调整速度请返回编辑器重新准备音乐。
                  </p>
                )}
              </section>
              <section
                id="classroom-settings-visual"
                tabIndex={-1}
                className="ecg-settings-section ecg-settings-visual"
              >
                <h3>画面与提示</h3>
                <div className="ecg-settings-fields">
                  <div className="setting-label">
                    <label>
                      展示模式
                      <select
                        value={displayMode}
                        onChange={(event) =>
                          setDisplayMode(event.target.value as WordBeatData['displayMode'])
                        }
                      >
                        <option value="centered">居中大词</option>
                        <option value="blocks">节奏方块</option>
                      </select>
                    </label>
                    <HelpTip label="展示模式">{WORD_BEAT_HELP.display}</HelpTip>
                  </div>
                  <div className="setting-label">
                    <label className="ecg-checkbox">
                      <input
                        type="checkbox"
                        checked={showMeaning}
                        onChange={(event) => setShowMeaning(event.target.checked)}
                      />
                      显示释义
                    </label>
                    <HelpTip label="显示释义">
                      {'显示或隐藏中文释义，不改变词语内容和练习轮数。'}
                    </HelpTip>
                  </div>
                  <div className="setting-label">
                    <label className="ecg-checkbox">
                      <input
                        type="checkbox"
                        checked={stageEffects}
                        onChange={(event) => setStageEffects(event.target.checked)}
                      />
                      舞台特效
                    </label>
                    <HelpTip label="舞台特效">
                      {'控制粒子、音符和拍击涟漪，真实拍位始终保留；系统减少动态效果设置优先。'}
                    </HelpTip>
                  </div>
                  {hasMultipleWords && (
                    <>
                      <div className="setting-label">
                        <label className="ecg-checkbox">
                          <input
                            type="checkbox"
                            checked={showWordTrack}
                            onChange={(event) => setShowWordTrack(event.target.checked)}
                          />
                          显示前后词预告
                        </label>
                        <HelpTip label="显示前后词预告">
                          {
                            '显示上一词和下一词，方便课堂衔接。关闭后中央词语、释义及下方朗读词槽仍保留。'
                          }
                        </HelpTip>
                      </div>
                    </>
                  )}
                </div>
              </section>
              <section
                id="classroom-settings-sound"
                tabIndex={-1}
                className="ecg-settings-section ecg-settings-sound"
              >
                <div className="setting-label ecg-settings-sound-heading">
                  <h3>声音与音量</h3>
                  <HelpTip label="声音与音量">
                    音量 0～100%，完成设置时统一保存并应用，测试可试听草稿；0
                    表示静音。只显示本课启用的声部。音乐与节拍的音量互相独立，调整音量不会改变速度或轮数。
                  </HelpTip>
                  {!started && hasSound && (
                    <button
                      onClick={() => void testSound()}
                      disabled={!plan || (settingsBlocked && !testing)}
                    >
                      {testing ? '停止测试' : '测试声音'}
                    </button>
                  )}
                </div>
                {!lesson.gameData.beatEnabled &&
                  !lesson.gameData.music.enabled &&
                  !soundCues.some((item) => item.audioAssetId) && (
                    <p className="ecg-classroom-small-note">
                      课件未启用声音，可按画面节奏练习。添加声音请返回编辑器。
                    </p>
                  )}
                {soundParts.map((part) => (
                  <div key={part} className="ecg-volume-field">
                    <label>
                      {soundLabels[part]} {Math.round(volumes[part] * 100)}%
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volumes[part]}
                        onChange={(event) => {
                          const next = { ...volumes, [part]: Number(event.target.value) };
                          setVolumes(next);
                          setVolumeInputs((previous) => ({
                            ...previous,
                            [part]: String(Math.round(next[part] * 100)),
                          }));
                          updateTestVolumes(next);
                        }}
                      />
                    </label>
                    <label>
                      <span className="ecg-classroom-sr-only">{soundLabels[part]}音量百分比</span>
                      <input
                        id={`classroom-volume-${part}`}
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        aria-invalid={!validSettingInteger(volumeInputs[part], 0, 100)}
                        aria-describedby={`classroom-volume-error-${part}`}
                        value={volumeInputs[part]}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setVolumeInputs((previous) => ({ ...previous, [part]: raw }));
                          const value = Number(raw);
                          if (!validSettingInteger(raw, 0, 100)) return;
                          const next = { ...volumes, [part]: value / 100 };
                          setVolumes(next);
                          updateTestVolumes(next);
                        }}
                      />
                    </label>
                    <p
                      id={`classroom-volume-error-${part}`}
                      className="ecg-volume-error"
                      hidden={validSettingInteger(volumeInputs[part], 0, 100)}
                    >
                      请输入 0～100 的整数百分比；未应用此输入。
                    </p>
                  </div>
                ))}
              </section>
              <section className="ecg-settings-section ecg-settings-storage">
                <h3>本课本地保存</h3>
                <p>
                  完成设置后，下次在当前浏览器打开继续使用。清理浏览器数据、换浏览器或移动离线文件可能无法沿用。
                </p>
                {restoreConfirm ? (
                  <div role="group" aria-label="确认恢复课件原始设置">
                    <p>将清除本课保存的设置，放弃草稿并回到开始页；其他课件不受影响。</p>
                    <button onClick={restoreOriginal}>确认恢复并返回开始页</button>
                    <button onClick={() => setRestoreConfirm(false)}>取消恢复</button>
                  </div>
                ) : (
                  <button onClick={() => setRestoreConfirm(true)}>恢复课件原始设置</button>
                )}
              </section>
            </div>
            {storageError && (
              <ClassroomNotice tone="error" title="设置未能保存">
                {storageError}
              </ClassroomNotice>
            )}
            {settingsOpen &&
              !storageError &&
              (state.error || notice.tone === 'error' || settingsBlocked || !settingsDirty) &&
              feedback}
            <div className="ecg-settings-footer">
              <div
                className="ecg-settings-status"
                role={!state.error && (settingsBlocked || !message) ? 'status' : undefined}
                data-error={settingsBlocked}
              >
                {settingsBlocked ? (
                  <WarningCircle size={20} aria-hidden="true" />
                ) : (
                  <CheckCircle size={20} aria-hidden="true" />
                )}
                <span>
                  {settingsBlocked
                    ? `${settingsIssues.length} 项待处理 · ${settingsIssues[0].label}`
                    : settingsDirty
                      ? '有待保存修改 · 完成时统一应用'
                      : '设置已就绪 · 完成时保存到本地'}
                </span>
              </div>
              <div className="ecg-settings-footer-actions">
                {(playBlocked || storageError) && (
                  <>
                    {settingsBlocked && (
                      <button onClick={() => focusSetting(settingsIssues[0].field)}>
                        定位问题
                      </button>
                    )}
                    <button onClick={() => discardDrafts()}>放弃未完成输入</button>
                  </>
                )}
                {started && (
                  <button className="ecg-button-danger" onClick={endClassroom}>
                    结束本次课堂
                  </button>
                )}
                {storageError && (
                  <button disabled={settingsBlocked} onClick={() => completeSettings(true)}>
                    仅本次使用
                  </button>
                )}
                <button
                  ref={completeButton}
                  className="ecg-button-primary"
                  disabled={settingsBlocked}
                  onClick={() => completeSettings()}
                >
                  完成设置
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
