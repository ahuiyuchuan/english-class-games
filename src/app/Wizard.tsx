import { TaskProgress } from '../shared/ui/TaskProgress';
import builtinMusic from '../../resources/music/source.json';
/** 三步智能制作页。规则有据可查，默认保留配音与口号，缺资源必须明确修复。 @author ahui */
import { WORD_BEAT_HELP } from '../games/word-beat/settingHelp';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Lightning,
  Sparkle,
  Target,
  Waveform,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { AssetMap, TeachingEntry } from '../platform/types';
import type { DictionaryEntry } from '../platform/materials/types';
import type { TeacherPreferences } from '../platform/repository';
import { validateWordBeatPreferences } from '../games/word-beat/preferences';
import { desktopAvailable, markPrepared, readAssetData, saveLesson } from '../platform/repository';
import {
  createWordBeatLesson,
  compileWordBeat,
  getEntries,
  validateWordBeat,
  getAudioProductionSummary,
  getAudioRequests,
  requiredAssets,
} from '../games/word-beat/rules';
import { PRESETS } from '../games/word-beat/rules';
import type { PresetId, WordBeatLesson, WordBeatSuggestion } from '../games/word-beat/model';
import * as native from '../platform/native';
import type { TaskRecord, VoiceInfo } from '../platform/native';
import {
  produceLesson,
  productionChanges,
  productionFingerprint,
} from '../games/word-beat/production';
import { previewAudio, stopPreview, validatePlayableAssets } from '../platform/audio-preview';
import { LessonExportDialog } from './LessonExportDialog';
import { WordBeatClassroom } from '../games/word-beat/Classroom';
import {
  applySuggestion,
  createPresetSuggestion,
  getDurationGuidance,
  replaceMaterials,
} from '../games/word-beat/suggestions';
import {
  Badge,
  Button,
  Check,
  Field,
  InputField,
  Modal,
  Notice,
  errorMessage,
  useFeedback,
} from '../shared/ui';
import { ImportPanel } from './ImportPanel';
import { countConfirmedFields } from '../shared/ai/completion-summary';
import './creation-studio.css';

/** 试听独占的小任务；取消制作、换页和组件卸载不能影响教师的整课制作任务。 */
interface VoicePreviewOperation {
  cancelled: boolean;
  task?: TaskRecord;
  cancellation?: Promise<TaskRecord>;
  wake?: () => void;
}

const runningTask = (task: TaskRecord) => ['queued', 'running', 'cancelling'].includes(task.state);

/** 异步取消答复不能把已经收到的终态退回制作中；取消请求一经确认不重复发送。 */
function newerTask(current: TaskRecord | undefined, next: TaskRecord): TaskRecord {
  if (current?.taskId !== next.taskId) return next;
  if (!runningTask(current)) return current;
  if (current.cancelRequested && ['queued', 'running'].includes(next.state))
    return { ...next, state: 'cancelling', cancelRequested: true };
  return next;
}

/** 预设差异使用教师能直接理解的名称与单位，不泄漏内部路径或JSON。 */
function presetChangeText(change: WordBeatSuggestion['changes'][number]): string {
  if (change.path === 'gameData.preset')
    return `练习预设：${PRESETS[change.before as PresetId].name} → ${PRESETS[change.after as PresetId].name}`;
  const value = (input: unknown) => (input as { value: number }).value;
  if (change.path === 'gameData.bpm')
    return `节奏：${value(change.before)} → ${value(change.after)} BPM`;
  if (change.path.endsWith('.rounds'))
    return `轮数：${value(change.before)} 轮 → ${value(change.after)} 轮`;
  if (change.path.endsWith('.modelBeats'))
    return `教师示范：${value(change.before)} 拍 → ${value(change.after)} 拍`;
  const follow = (input: unknown) => {
    const rule = input as { mode: string; beats: number; preset: PresetId };
    return rule.mode === 'manual'
      ? `手动 ${rule.beats} 拍`
      : `${PRESETS[rule.preset]?.name ?? '当前预设'}公式`;
  };
  return `跟读：${follow(change.before)} → ${follow(change.after)}`;
}

/** 取消只发送一次；迟到的任务标识也由调用方交回此入口处理。 */
function cancelVoicePreview(operation: VoicePreviewOperation): void {
  operation.cancelled = true;
  operation.wake?.();
  if (operation.task && runningTask(operation.task) && !operation.cancellation) {
    operation.cancellation = native.cancelTask(operation.task.taskId);
    // 先挂拒绝处理，防止取消在主轮询醒来前失败而产生未处理的 Promise。
    void operation.cancellation.catch(() => undefined);
  }
}

/** 只清理本组件创建的试听任务；服务确认停止后才清记录和未保存的候选素材。 */
async function releaseVoicePreview(operation: VoicePreviewOperation): Promise<void> {
  if (!operation.task) return;
  let task = operation.task;
  if (runningTask(task)) {
    cancelVoicePreview(operation);
    task = await operation.cancellation!;
    while (runningTask(task)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      task = await native.getTask(task.taskId);
    }
  }
  await native.clearTask(task.taskId);
}

/** 配音设置共享于制作页和编辑器；选项来自已安装的内置引擎和实际枚举的 Windows 音色。 */
export function VoiceFields({
  lesson,
  voices,
  onChange,
  active = true,
}: {
  lesson: WordBeatLesson;
  voices: VoiceInfo[];
  onChange: (lesson: WordBeatLesson) => void;
  active?: boolean;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const englishRateDraft = lesson.draftInputs?.[`${lesson.id}.englishRate`]?.raw;
  const chineseRateDraft = lesson.draftInputs?.[`${lesson.id}.chineseRate`]?.raw;
  const operation = useRef<VoicePreviewOperation | null>(null);
  const stop = useCallback(() => {
    if (operation.current) {
      cancelVoicePreview(operation.current);
      operation.current = null;
      stopPreview();
    }
    if (mounted.current) {
      setBusy(false);
      setPreviewing(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, [stop]);
  useEffect(() => {
    stop();
  }, [
    active,
    lesson.gameData.voices.englishVoiceId,
    lesson.gameData.voices.chineseVoiceId,
    lesson.gameData.voices.englishRate,
    lesson.gameData.voices.chineseRate,
    englishRateDraft,
    chineseRateDraft,
    stop,
  ]);
  const test = async (language: 'en-US' | 'zh-CN') => {
    if (!active || busy) return;
    stop();
    const current: VoicePreviewOperation = { cancelled: false };
    operation.current = current;
    const isCurrent = () =>
      mounted.current && activeRef.current && operation.current === current && !current.cancelled;
    setError('');
    setBusy(true);
    setPreviewing(true);
    try {
      const rateKey = language === 'en-US' ? 'englishRate' : 'chineseRate';
      if (lesson.draftInputs?.[`${lesson.id}.${rateKey}`])
        throw new Error('请先把试听语速修正为0.75～1.25倍。');
      const voiceId =
        language === 'en-US'
          ? lesson.gameData.voices.englishVoiceId
          : lesson.gameData.voices.chineseVoiceId;
      if (!voiceId) throw new Error('请先选择实际可用的音色。');
      let task = await native.synthesizeSpeech([
        {
          requestId: crypto.randomUUID(),
          objectId: 'voice-preview',
          text:
            language === 'en-US' ? 'Ready to speak. Make a difference.' : '准备好，跟着节奏开口。',
          language,
          voiceId,
          rate:
            language === 'en-US'
              ? lesson.gameData.voices.englishRate
              : lesson.gameData.voices.chineseRate,
        },
      ]);
      current.task = task;
      if (!isCurrent()) return;
      while (runningTask(task)) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 300);
          current.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        current.wake = undefined;
        if (!isCurrent()) return;
        task = await native.getTask(task.taskId);
        current.task = task;
        if (!isCurrent()) return;
      }
      if (!task.results[0])
        throw new Error(task.failures[0]?.error.message ?? '试听声音制作未完成。');
      const asset = await native.readAsset(task.results[0].asset.assetId);
      if (!isCurrent()) return;
      await previewAudio(asset);
    } catch (cause) {
      if (isCurrent()) {
        setError(errorMessage(cause));
        setPreviewing(false);
      }
    } finally {
      if (isCurrent()) setBusy(false);
      try {
        await releaseVoicePreview(current);
      } catch (cause) {
        if (isCurrent()) setError(`试听任务清理未完成：${errorMessage(cause)}`);
      }
    }
  };
  const update = (key: 'englishVoiceId' | 'chineseVoiceId', value: string) =>
    onChange({
      ...lesson,
      gameData: { ...lesson.gameData, voices: { ...lesson.gameData.voices, [key]: value } },
    });
  const updateRate = (key: 'englishRate' | 'chineseRate', raw: string) => {
    const value = Number(raw);
    const valid = raw.trim() !== '' && Number.isFinite(value) && value >= 0.75 && value <= 1.25;
    const next = structuredClone(lesson);
    const path = `${lesson.id}.${key}`;
    next.draftInputs = { ...next.draftInputs };
    if (valid) {
      next.gameData.voices[key] = value;
      delete next.draftInputs[path];
    } else {
      next.draftInputs[path] = { raw, message: '语速需为0.75～1.25倍。', objectId: lesson.id };
    }
    onChange(next);
  };
  return (
    <div className="stack-sm">
      {(['en-US', 'zh-CN'] as const).map((language) => {
        const english = language === 'en-US';
        // 只展示本课实际使用的声部；隐藏不会删除切回配音模式所需的配置。
        const sloganUsesLanguage = Object.values(lesson.gameData.slogans).some(
          (slogan) => slogan.enabled && slogan.language === language,
        );
        if (!(english && lesson.gameData.soundMode === 'voiced') && !sloganUsesLanguage)
          return null;
        const filtered = voices.filter((voice) =>
          english
            ? voice.language.toLowerCase().startsWith('en')
            : voice.language.toLowerCase().startsWith('zh'),
        );
        return (
          <div key={language} className="stack-sm">
            <Field
              label={
                english
                  ? lesson.gameData.soundMode === 'voiced'
                    ? '英文示范音色'
                    : '英文口号音色'
                  : '中文口号音色'
              }
            >
              <select
                className="input"
                aria-label={
                  english
                    ? lesson.gameData.soundMode === 'voiced'
                      ? '英文示范音色'
                      : '英文口号音色'
                    : '中文口号音色'
                }
                value={
                  (english
                    ? lesson.gameData.voices.englishVoiceId
                    : lesson.gameData.voices.chineseVoiceId) ?? ''
                }
                onChange={(event) =>
                  update(english ? 'englishVoiceId' : 'chineseVoiceId', event.target.value)
                }
              >
                <option value="">{filtered.length ? '请选择并试听' : '未发现可用音色'}</option>
                {filtered.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} · {voice.language}
                  </option>
                ))}
              </select>
            </Field>
            <div className="row">
              <InputField
                label={english ? '英文语速（倍）' : '中文语速（倍）'}
                type="number"
                min={0.75}
                max={1.25}
                step={0.05}
                value={
                  lesson.draftInputs?.[`${lesson.id}.${english ? 'englishRate' : 'chineseRate'}`]
                    ?.raw ??
                  (english
                    ? lesson.gameData.voices.englishRate
                    : lesson.gameData.voices.chineseRate)
                }
                error={
                  lesson.draftInputs?.[`${lesson.id}.${english ? 'englishRate' : 'chineseRate'}`]
                    ?.message
                }
                onChange={(event) =>
                  updateRate(english ? 'englishRate' : 'chineseRate', event.target.value)
                }
              />
              <Button
                busy={busy}
                disabled={!active}
                onClick={() => {
                  void test(language);
                }}
              >
                试听{english ? '英文' : '中文'}
              </Button>
            </div>
          </div>
        );
      })}
      {previewing && <Button onClick={stop}>停止试听</Button>}
      {!desktopAvailable && (
        <Notice>
          本地音色与声音制作需要 Windows 备课软件。可明确选择文字领读并关闭口号后预演。
        </Notice>
      )}
      {error && (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      )}
    </div>
  );
}

interface WizardProps {
  dictionary: DictionaryEntry[];
  commonWords: TeachingEntry[];
  preferences: TeacherPreferences;
  assets: AssetMap;
  initialEntries?: TeachingEntry[];
  /** 平台跨导航保留制作会话；隐藏时仅停止试听，整课制作继续。 */
  active?: boolean;
  onAssets: (assets: AssetMap) => void;
  onBack: () => void;
  onEdit: (lesson: WordBeatLesson) => void;
  onMaterial: (
    entries: TeachingEntry[],
    source: { name: string; original: string },
  ) => Promise<void>;
}

/** 输入保存为内容副本；明确点击制作后才合成声音，返回校对不会丢失内容。 */
export function Wizard({
  dictionary,
  commonWords,
  preferences,
  assets,
  initialEntries,
  active = true,
  onAssets,
  onBack,
  onEdit,
  onMaterial,
}: WizardProps) {
  const [step, setStep] = useState(initialEntries ? 1 : 0);
  const [furthestStep, setFurthestStep] = useState(initialEntries ? 1 : 0);
  const [lesson, setLessonState] = useState<WordBeatLesson | null>(() =>
    initialEntries ? makeLesson(initialEntries) : null,
  );
  const lessonRef = useRef(lesson);
  const mounted = useRef(true);
  const making = useRef(false);
  /** 每次明确制作独立编号，迟到任务通知／取消失败不属于后续制作。 */
  const productionRun = useRef(0);
  const savedMaterials = useRef(new Set<string>());
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [productionInput, setProductionInput] = useState<{
    lesson: WordBeatLesson;
    assets: AssetMap;
  }>();
  const [producedResult, setProducedResult] = useState<WordBeatLesson | null>(null);
  /** 声音任务完成不等于成果已保存；保存失败不能显示当前课件就绪。 */
  const [resultSaved, setResultSaved] = useState(false);
  const [presetSuggestion, setPresetSuggestion] = useState<WordBeatSuggestion | null>(null);
  const [pendingMaterials, setPendingMaterials] = useState<{
    entries: TeachingEntry[];
    source: { name: string; original: string };
  } | null>(null);
  const [oldResult, setOldResult] = useState<WordBeatLesson | null>(null);
  const [oldResultOpen, setOldResultOpen] = useState(false);
  const [classroom, setClassroom] = useState<WordBeatLesson | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);
  const outputPending = useRef(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const { confirm } = useFeedback();

  const [task, setTask] = useState<TaskRecord>();
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelPending = useRef<{ taskId: string; run: number }>();
  const [error, setError] = useState('');
  const [source, setSource] = useState<{ name: string; original: string }>();
  /** 名称按 Unicode 码点校验，保留超限原文供教师修正，不使用浏览器 UTF-16 截断。 */
  const [nameChecked, setNameChecked] = useState(false);
  const [saveMaterial, setSaveMaterial] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 同步当前输入引用，迟到制作/保存结果只能合并版本元信息，不能覆盖新内容。 */
  const setLesson = (next: WordBeatLesson | null) => {
    lessonRef.current = next;
    if (mounted.current) setLessonState(next);
  };
  /** 未确认替换前保留原会话，进行中的制作仍绑定旧快照。 */
  const acceptMaterials = (
    entries: TeachingEntry[],
    importedSource: { name: string; original: string },
  ) => {
    setLesson(
      lessonRef.current ? replaceMaterials(lessonRef.current, entries) : makeLesson(entries),
    );
    setSource(importedSource);
    setStep(1);
    setFurthestStep((previous) => Math.max(previous, 1));
    setPendingMaterials(null);
  };
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) setClassroom(null);
  }, [active]);
  const voiceQuery = useQuery({
    queryKey: ['voices'],
    queryFn: native.listVoices,
    enabled: desktopAvailable,
  });
  function makeLesson(entries: TeachingEntry[]): WordBeatLesson {
    const defaults = validateWordBeatPreferences(preferences.gameDefaults['word-beat'] ?? {});
    const created = createWordBeatLesson(entries, {
      preset: defaults.preset,
      soundMode: defaults.soundMode,
      progression: defaults.progression,
    });
    // Bind only newly created lessons to the verified bundled track. Existing
    // lessons and the import dialog's explicit enabled switch remain untouched.
    const music = Object.values(assets).find(
      (asset) => asset.kind === 'music' && asset.sha256 === builtinMusic.sha256,
    );
    if (music) created.gameData.music = { enabled: true, loop: true, assetId: music.assetId };
    created.gameData.displayMode = defaults.displayMode;
    created.gameData.targetDurationMs = defaults.targetDurationMs;
    created.gameData.voices = {
      ...created.gameData.voices,
      ...Object.fromEntries(
        Object.entries(defaults).filter(([key]) =>
          ['englishVoiceId', 'chineseVoiceId', 'englishRate', 'chineseRate'].includes(key),
        ),
      ),
    };
    return created;
  }

  const make = async () => {
    if (!lessonRef.current || making.current || outputPending.current) return;
    const input = structuredClone(lessonRef.current);
    const initialAssets = { ...assetsRef.current };
    const invalid = validateWordBeat(input, assetsRef.current).filter(
      (issue) => issue.severity === 'error' && issue.kind === 'invalid',
    );
    if (invalid.length) {
      setNameChecked(true);
      setError(invalid.map((issue) => issue.message).join('；'));
      return;
    }
    const requests = getAudioRequests(input, initialAssets);
    // 只拦截从未选择音色的需求。已保存的音色即使不再安装，后端仍可能找到
    // 文本、语言、语速和环境均匹配的有效缓存；枚举结果不能替代缓存检查。
    // 缓存未命中时由后端校验实际音色及语言，并把不能制作的项如实列为失败。
    if (requests.some((request) => !request.voiceId)) {
      setError(
        '请先选择并试听当前可用的音色；没有所需音色时可导入录音，或明确改用文字领读并关闭缺少声音的口号。',
      );
      setStep(1);
      setAdvancedOpen(true);
      return;
    }
    making.current = true;
    const run = ++productionRun.current;
    setCancelling(false);
    setError('');
    setNotice('');
    setOldResult(null);
    setOldResultOpen(false);
    setTask(undefined);
    setProductionInput({ lesson: input, assets: initialAssets });
    setProducedResult(null);
    setResultSaved(false);
    setBusy(true);
    setStep(2);
    setFurthestStep(2);
    const fingerprint = productionFingerprint(input);
    const mergeSaved = (saved: WordBeatLesson, resultFingerprint: string) => {
      const current = lessonRef.current;
      if (current?.id !== saved.id) return;
      setLesson(
        productionFingerprint(current) === resultFingerprint
          ? saved
          : { ...current, revision: saved.revision, preparedRevision: saved.preparedRevision },
      );
    };
    try {
      const materialKey = source
        ? JSON.stringify([
            source,
            getEntries(input).map(
              ({ english, meaning, partOfSpeech, priority, tags, unit, entryType }) => ({
                english,
                meaning,
                partOfSpeech,
                priority,
                tags,
                unit,
                entryType,
              }),
            ),
          ])
        : undefined;
      if (saveMaterial && source && materialKey && !savedMaterials.current.has(materialKey)) {
        await onMaterial(getEntries(input), source);
        savedMaterials.current.add(materialKey);
      }
      const snapshot = await saveLesson(input, input.revision);
      mergeSaved(snapshot, fingerprint);
      if (mounted.current) setProductionInput({ lesson: snapshot, assets: initialAssets });
      const retryOf = task && !runningTask(task) ? task.taskId : undefined;
      const result = await produceLesson(
        snapshot,
        initialAssets,
        (next) => {
          if (mounted.current && productionRun.current === run)
            setTask((current) => newerTask(current, next));
        },
        retryOf,
      );
      onAssets(result.assets);
      assetsRef.current = { ...assetsRef.current, ...result.assets };
      if (mounted.current) setProducedResult(result.lesson);
      if (
        lessonRef.current?.id !== input.id ||
        productionFingerprint(lessonRef.current) !== fingerprint
      ) {
        if (mounted.current) {
          setOldResult(result.lesson);
        }
        return;
      }
      const saved = await saveLesson(result.lesson, snapshot.revision);
      // 教师也可能在最终保存等待期间修改，保存完成后的这次比较同样不可省略。
      const changedDuringSave =
        lessonRef.current?.id !== input.id ||
        productionFingerprint(lessonRef.current) !== fingerprint;
      mergeSaved(saved, fingerprint);
      if (mounted.current) setResultSaved(true);
      if (changedDuringSave && mounted.current) {
        setOldResult(saved);
      }
      const problems = validateWordBeat(saved, result.assets).filter(
        (issue) => issue.severity === 'error',
      );
      if (problems.length && mounted.current)
        setError(`当前课件仍有 ${problems.length} 项需要处理，可进入编辑器逐项修复。`);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      making.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** 预演与导出共用真实资源检查；准备指针只指向此刻固定的合法修订。 */
  const prepare = async () => {
    const current = lessonRef.current;
    if (!current || making.current) throw new Error('请等待当前制作结束。');
    stopPreview();
    const fingerprint = productionFingerprint(current);
    const snapshot = await saveLesson(structuredClone(current), current.revision);
    if (lessonRef.current?.id === snapshot.id)
      setLesson({ ...lessonRef.current, revision: snapshot.revision });
    await validatePlayableAssets(snapshot, assetsRef.current);
    const prepared = await markPrepared(snapshot, requiredAssets(snapshot));
    if (lessonRef.current && productionFingerprint(lessonRef.current) === fingerprint)
      setLesson(prepared);
    return prepared;
  };

  /** 输出只固定当前点击时的版本，操作中继续校对不会混入已生成文件。 */
  const output = async (kind: 'preview' | 'export') => {
    if (kind === 'export') {
      setExportOpen(true);
      return;
    }
    if (outputPending.current || making.current) return;
    outputPending.current = true;
    setOutputBusy(true);
    setError('');
    try {
      const prepared = await prepare();
      if (kind === 'preview') {
        if (mounted.current && activeRef.current) setClassroom(prepared);
        return;
      }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      outputPending.current = false;
      if (mounted.current) setOutputBusy(false);
    }
  };

  const issues = lesson ? validateWordBeat(lesson, assets) : [];
  // 制作中以原输入判断并发编辑；完成后以自动回填已采用的成果判断后续修改。
  // 普通保存的字段重排与元信息不产生过期；未采用成果不能自动覆盖当前草稿。
  const staleResult =
    oldResult ??
    (!busy &&
    producedResult &&
    lesson &&
    productionFingerprint(producedResult) !== productionFingerprint(lesson)
      ? producedResult
      : null);
  const changeBaseline = oldResult ? (productionInput?.lesson ?? oldResult) : producedResult;
  const changedContent = changeBaseline && lesson ? productionChanges(changeBaseline, lesson) : [];
  const currentReady =
    !busy &&
    resultSaved &&
    !staleResult &&
    !error &&
    (!task || task.state === 'completed') &&
    !issues.some((issue) => issue.severity === 'error');
  // 新建一轮与显式应用的预设目标不同；摘要只读取真实条目，不把预设名当成实际轮数。
  const currentRounds = lesson ? getEntries(lesson).map((entry) => entry.rounds.value) : [];
  const minimumRounds = Math.min(...currentRounds);
  const maximumRounds = Math.max(...currentRounds);
  const roundsSummary = !currentRounds.length
    ? '尚无词条'
    : minimumRounds === maximumRounds
      ? `每词 ${minimumRounds} 轮`
      : `各词 ${minimumRounds}～${maximumRounds} 轮`;
  const summaryLesson = producedResult ?? productionInput?.lesson ?? lesson;
  const summaryIssues = summaryLesson ? validateWordBeat(summaryLesson, assets) : [];
  const audioSummary = productionInput
    ? getAudioProductionSummary(productionInput.lesson, productionInput.assets, task?.results)
    : lesson
      ? getAudioProductionSummary(lesson, assets)
      : undefined;
  let duration: number | undefined;
  try {
    if (summaryLesson) duration = compileWordBeat(summaryLesson, assets).durationMs;
  } catch {
    /* 尚缺必需声音时只显示真实待准备状态。 */
  }

  return (
    <>
      <div className="page stack wizard-page" data-step={step} hidden={!active || !!classroom}>
        <div className="page-heading wizard-heading">
          <div>
            <h1>制作课堂课件</h1>
            <p>
              {
                [
                  '先确认教学内容，再安排练习与声音。原文和修改始终保留。',
                  '选择练习目标，检查每个词的安排，再一键制作。',
                  '检查真实制作结果，预演后即可带到课堂。',
                ][step]
              }
            </p>
          </div>
          <Button variant="text" onClick={onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            返回工作台
          </Button>
        </div>
        <div className="steps" aria-label="制作步骤">
          {['内容校对', '活动编排', '声音制作与检查'].map((name, position) => (
            <button
              className="step"
              key={name}
              aria-label={`${position + 1} ${name}`}
              aria-current={step === position ? 'step' : undefined}
              data-complete={position < step}
              disabled={position > furthestStep}
              onClick={() => setStep(position)}
            >
              <span>
                {position < step ? <CheckCircle size={20} aria-hidden="true" /> : position + 1}
              </span>
              {name}
            </button>
          ))}
        </div>
        <div className="panel" hidden={step !== 0}>
          <ImportPanel
            actionLabel="确认内容，下一步"
            dictionary={dictionary}
            commonWords={commonWords}
            onConfirm={(entries, importedSource) => {
              if (lessonRef.current) setPendingMaterials({ entries, source: importedSource });
              else acceptMaterials(entries, importedSource);
            }}
          />
        </div>
        {step === 1 && lesson && (
          <div className="stack">
            <div className="panel stack studio-plan">
              <div className="row spread">
                <h2>单词节拍 · 活动编排</h2>
                <Badge>{getEntries(lesson).length} 条词汇</Badge>
              </div>
              <InputField
                label="课件名称"
                value={lesson.name}
                hint="1～80个字符，保留完整输入；超限请修改后制作。"
                error={
                  nameChecked
                    ? issues.find((issue) => issue.code === 'NAME_INVALID')?.message
                    : undefined
                }
                onBlur={() => setNameChecked(true)}
                onChange={(event) => setLesson({ ...lesson, name: event.target.value })}
              />
              <div className="grid-three" role="radiogroup" aria-label="练习预设">
                {(Object.keys(PRESETS) as PresetId[]).map((preset) => (
                  <button
                    key={preset}
                    className="preset"
                    role="radio"
                    aria-checked={lesson.gameData.preset === preset}
                    tabIndex={lesson.gameData.preset === preset ? 0 : -1}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
                        return;
                      event.preventDefault();
                      const presets = Object.keys(PRESETS) as PresetId[];
                      const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
                      const next =
                        (presets.indexOf(preset) + direction + presets.length) % presets.length;
                      const controls =
                        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                          '[role="radio"]',
                        );
                      controls?.[next]?.focus();
                      const suggestion = createPresetSuggestion(lesson, presets[next]);
                      if (suggestion) setPresetSuggestion(suggestion);
                    }}
                    onClick={() => {
                      const suggestion = createPresetSuggestion(lesson, preset);
                      if (suggestion) setPresetSuggestion(suggestion);
                      else setNotice('当前已使用此预设，没有需要更新的参数。');
                    }}
                  >
                    <span className="studio-preset-icon" aria-hidden="true">
                      {preset === 'regular' ? (
                        <Waveform size={26} />
                      ) : preset === 'focus' ? (
                        <Target size={26} />
                      ) : (
                        <Lightning size={26} />
                      )}
                    </span>
                    <strong>{PRESETS[preset].name}</strong>
                    <span className="muted">
                      预设目标：{PRESETS[preset].bpm} BPM · 普通 {PRESETS[preset].normalRounds} 轮 /
                      重点 {PRESETS[preset].priorityRounds} 轮
                    </span>
                    <small>
                      {preset === 'regular'
                        ? '均衡练习，适合日常巩固'
                        : preset === 'focus'
                          ? '增加轮次和跟读空间'
                          : '减少轮次，适合快速回顾'}
                    </small>
                  </button>
                ))}
              </div>
              <div className="grid-two">
                <InputField
                  label="目标时长（分钟，仅作建议依据）"
                  hint="按编排本身计算，不含教师等待、暂停和临时重读。"
                  type="number"
                  min={1}
                  max={30}
                  value={
                    lesson.draftInputs?.[`${lesson.id}.targetDurationMs`]?.raw ??
                    lesson.gameData.targetDurationMs / 60000
                  }
                  error={lesson.draftInputs?.[`${lesson.id}.targetDurationMs`]?.message}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const minutes = Number(raw);
                    const next = structuredClone(lesson);
                    const path = `${lesson.id}.targetDurationMs`;
                    next.draftInputs = { ...next.draftInputs };
                    if (raw.trim() && Number.isFinite(minutes) && minutes >= 1 && minutes <= 30) {
                      next.gameData.targetDurationMs = Math.round(minutes * 60000);
                      delete next.draftInputs[path];
                    } else
                      next.draftInputs[path] = {
                        raw,
                        message: '目标时长需为1～30分钟。',
                        objectId: lesson.id,
                      };
                    setLesson(next);
                  }}
                />
                <Field label="练习模式" help={WORD_BEAT_HELP.mode}>
                  <select
                    aria-label="练习模式"
                    className="input"
                    value={lesson.gameData.soundMode}
                    onChange={async (event) => {
                      const soundMode = event.target
                        .value as WordBeatLesson['gameData']['soundMode'];
                      if (soundMode === lesson.gameData.soundMode) return;
                      if (
                        await confirm({
                          title: '切换练习模式',
                          message: '将重新计算阶段和时长，保留已有声音和其他模式参数。',
                        })
                      ) {
                        const current = lessonRef.current;
                        if (current)
                          setLesson({ ...current, gameData: { ...current.gameData, soundMode } });
                      }
                    }}
                  >
                    <option value="voiced">配音跟读</option>
                    <option value="teacher">文字领读（教师示范）</option>
                    <option value="chorus">学生自主齐读（无示范，跟拍朗读）</option>
                  </select>
                </Field>
                {lesson.gameData.soundMode === 'chorus' && (
                  <p>
                    学生直接跟拍朗读，无示范阶段。默认每轮4拍、读4次、每次1拍，新建每词默认1轮；主动应用练习预设后才按预设调整轮数。在编辑器或课堂设置中可按词或范围调整轮数、每轮总拍数和每次占拍；课堂设置仅本课本地保存，不改原课件。
                  </p>
                )}
                <Field label="展示模式" help={WORD_BEAT_HELP.display}>
                  <select
                    aria-label="展示模式"
                    className="input"
                    value={lesson.gameData.displayMode}
                    onChange={(event) =>
                      setLesson({
                        ...lesson,
                        gameData: {
                          ...lesson.gameData,
                          displayMode: event.target.value as 'centered' | 'blocks',
                        },
                      })
                    }
                  >
                    <option value="blocks">节奏方块</option>
                    <option value="centered">居中大词</option>
                  </select>
                </Field>
                <Field label="课堂推进方式" help={WORD_BEAT_HELP.progression}>
                  <select
                    aria-label="课堂推进方式"
                    className="input"
                    value={lesson.gameData.progression}
                    onChange={(event) =>
                      setLesson({
                        ...lesson,
                        gameData: {
                          ...lesson.gameData,
                          progression: event.target.value as 'step' | 'auto',
                        },
                      })
                    }
                  >
                    <option value="auto">自动推进</option>
                    <option value="step">逐词等待教师</option>
                  </select>
                </Field>
              </div>
              <Notice tone="ai">
                当前安排：{roundsSummary}
                。新建默认一轮；点击预设先查看差异，确认后才调整，保留手动和锁定值。 按原顺序每 10
                条分一组，目标时长不改变教学词数。
              </Notice>
              <details
                open={advancedOpen}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              >
                <summary>声音、口号与材料设置</summary>
                <div className="stack" style={{ marginTop: 16 }}>
                  <VoiceFields
                    lesson={lesson}
                    voices={voiceQuery.data ?? []}
                    onChange={setLesson}
                    active={active && step === 1 && advancedOpen && !classroom}
                  />
                  {(['opening', 'transition', 'closing'] as const).map((purpose, position) => (
                    <Check
                      key={purpose}
                      label={['开场口号', '段间口号', '收尾口号'][position]}
                      checked={lesson.gameData.slogans[purpose].enabled}
                      onChange={(event) =>
                        setLesson({
                          ...lesson,
                          gameData: {
                            ...lesson.gameData,
                            slogans: {
                              ...lesson.gameData.slogans,
                              [purpose]: {
                                ...lesson.gameData.slogans[purpose],
                                enabled: event.target.checked,
                                enabledSource: 'manual',
                              },
                            },
                          },
                        })
                      }
                    />
                  ))}
                  <Check
                    label="将本次材料保存到材料集，便于后续复用"
                    checked={saveMaterial}
                    onChange={(event) => setSaveMaterial(event.target.checked)}
                  />
                </div>
              </details>
            </div>
            <div className="wizard-footer">
              <Button onClick={() => setStep(0)}>
                <ArrowLeft size={18} aria-hidden="true" />
                返回校对
              </Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => {
                  void make();
                }}
              >
                <Sparkle size={18} aria-hidden="true" />
                一键制作
              </Button>
            </div>
          </div>
        )}
        {step === 2 && lesson && (
          <div className="panel stack studio-result" data-busy={busy}>
            <div className="row spread">
              <h2>
                {busy ? '正在准备课堂声音' : staleResult ? '先前制作成果与检查' : '制作结果与检查'}
              </h2>
              <Badge tone={busy ? 'ai' : !currentReady ? 'warning' : 'success'}>
                {busy
                  ? '制作中'
                  : staleResult
                    ? '当前草稿待更新'
                    : currentReady
                      ? '当前课件检查通过'
                      : '需要处理'}
              </Badge>
            </div>
            {staleResult && (
              <p className="muted">以下统计与声音检查对应先前制作成果，尚未应用到当前草稿。</p>
            )}
            {task && (
              <div className="notice">
                <div className="grow stack-sm">
                  <TaskProgress task={task} />
                  {task.failures.map((failure) => (
                    <p key={failure.requestId} className="error-text">
                      {failure.error.message}
                    </p>
                  ))}
                </div>
                {runningTask(task) && (
                  <Button
                    busy={cancelling}
                    disabled={task.state === 'cancelling' || task.cancelRequested}
                    onClick={() => {
                      if (cancelPending.current?.taskId === task.taskId) return;
                      const request = { taskId: task.taskId, run: productionRun.current };
                      cancelPending.current = request;
                      setCancelling(true);
                      void native
                        .cancelTask(task.taskId)
                        .then((next) => {
                          // 取消答复只属于点击时的任务。旧任务可能已经结束且新一轮
                          // 制作已经开始，迟到答复不得替换新任务的进度与取消入口。
                          if (mounted.current)
                            setTask((current) =>
                              current?.taskId === task.taskId ? newerTask(current, next) : current,
                            );
                        })
                        .catch((cause) => {
                          if (mounted.current && productionRun.current === request.run)
                            setError(errorMessage(cause));
                        })
                        .finally(() => {
                          if (cancelPending.current === request) {
                            cancelPending.current = undefined;
                            if (mounted.current) setCancelling(false);
                          }
                        });
                    }}
                  >
                    {task.state === 'cancelling' || task.cancelRequested ? '正在取消' : '取消制作'}
                  </Button>
                )}
              </div>
            )}
            <div className="production-summary">
              <span>{getEntries(summaryLesson ?? lesson).length} 条词汇</span>
              <span>
                {getEntries(summaryLesson ?? lesson).filter((entry) => entry.priority).length}{' '}
                个重点
              </span>
              <span>
                {
                  (summaryLesson ?? lesson).gameData.segments.filter(
                    (segment) => segment.entries.length,
                  ).length
                }{' '}
                个段落
              </span>
              <span>{countConfirmedFields(getEntries(summaryLesson ?? lesson))} 项已确认补全</span>
              <span>
                {duration === undefined
                  ? busy
                    ? '声音准备完成后计算完整时长'
                    : `暂不能计算时长：${issues.find((issue) => issue.severity === 'error')?.message ?? '请检查参数和所需声音。'}`
                  : `编排 ${(duration / 60000).toFixed(1)} 分钟`}
              </span>
            </div>
            {!busy && audioSummary && (
              <div className="production-summary">
                <span>声音需求 {audioSummary.total} 项</span>
                <span>新制作 {audioSummary.created} 项</span>
                <span>复用 {audioSummary.reused} 项</span>
                <span>未完成 {audioSummary.unfinished} 项</span>
              </div>
            )}
            {!busy && getDurationGuidance(summaryLesson ?? lesson, duration) && (
              <Notice tone="warning">
                {getDurationGuidance(summaryLesson ?? lesson, duration)}
              </Notice>
            )}
            {!busy && summaryIssues.length > 0 && (
              <div className="stack-sm">
                {summaryIssues.map((issue, position) => (
                  <Notice tone={issue.severity === 'error' ? 'error' : 'warning'} key={position}>
                    {issue.message}
                  </Notice>
                ))}
              </div>
            )}
            {currentReady && (
              <Notice tone="ai">
                <strong>当前课件已就绪</strong>
                <p>建议先预演声音与节奏，确认后直接导出到教室使用，无需再进入编辑器。</p>
              </Notice>
            )}
            {staleResult && (
              <Notice tone="warning">
                <strong>当前草稿已有修改</strong>
                <p>
                  已变化：{changedContent.join('、') || '教学内容或活动设置'}
                  。当前修改已保留；请按当前内容重新制作并检查，再预演或导出。仍匹配的声音会继续复用。
                </p>
                <Button onClick={() => setOldResultOpen(true)}>查看旧成果（只读）</Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void make();
                  }}
                >
                  基于当前内容重新制作
                </Button>
              </Notice>
            )}
            <div className="row spread">
              <Button disabled={busy} onClick={() => setStep(1)}>
                调整编排
              </Button>
              <div className="row">
                <Button
                  disabled={
                    busy || !!staleResult || issues.some((issue) => issue.severity === 'error')
                  }
                  busy={outputBusy}
                  onClick={() => {
                    void output('preview');
                  }}
                >
                  预演课件
                </Button>
                <Button
                  variant={
                    issues.some((issue) => issue.severity === 'error') ? 'secondary' : 'primary'
                  }
                  disabled={busy || !!staleResult}
                  busy={outputBusy}
                  onClick={() => {
                    void output('export');
                  }}
                >
                  导出课堂文件
                </Button>
                <Button
                  variant={
                    issues.some((issue) => issue.severity === 'error') ? 'primary' : 'secondary'
                  }
                  disabled={busy}
                  onClick={() => onEdit(lesson)}
                >
                  {issues.some((issue) => issue.severity === 'error') ? (
                    <ArrowRight size={18} aria-hidden="true" />
                  ) : (
                    <CheckCircle size={18} aria-hidden="true" />
                  )}
                  {staleResult ? '进入当前草稿' : '进入编辑'}
                </Button>
              </div>
            </div>
          </div>
        )}
        {notice && (
          <Notice tone="ai" role="status">
            {notice}
          </Notice>
        )}
        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
      </div>
      <Modal
        open={!!presetSuggestion && active}
        onOpenChange={(open) => {
          if (!open) setPresetSuggestion(null);
        }}
        title="确认切换练习预设"
        description="只更新未锁定的预设参数；教师手动值和锁定项继续保留。"
      >
        {presetSuggestion && lesson && (
          <div className="stack">
            <ul>
              {presetSuggestion.changes.map((change) => (
                <li key={change.path}>
                  {getEntries(lesson).find((entry) => entry.id === change.objectId)?.english ??
                    '全课'}{' '}
                  · {presetChangeText(change)}
                </li>
              ))}
            </ul>
            {(lesson.gameData.bpm.locked || lesson.gameData.bpm.source === 'manual') && (
              <p>保留全课节奏：已锁定或由教师手动设置。</p>
            )}
            {getEntries(lesson).map((entry) => {
              const preserved = [
                entry.rounds.locked || entry.rounds.source === 'manual' ? '轮数' : '',
                entry.follow.locked || entry.follow.mode === 'manual' ? '跟读规则 / 拍数' : '',
                entry.modelBeats.locked || entry.modelBeats.source === 'manual'
                  ? '教师示范拍数'
                  : '',
              ].filter(Boolean);
              return preserved.length ? (
                <p key={entry.id}>
                  保留 {entry.english}：{preserved.join('、')}，已锁定或由教师手动设置。
                </p>
              ) : null;
            })}
            <div className="row">
              <Button data-modal-safe-action onClick={() => setPresetSuggestion(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  try {
                    if (!lessonRef.current) return;
                    setLesson(applySuggestion(lessonRef.current, presetSuggestion));
                    setPresetSuggestion(null);
                    setNotice('练习预设已更新，手动值和锁定项已保留。');
                  } catch (cause) {
                    setError(errorMessage(cause));
                  }
                }}
              >
                应用预设
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={!!pendingMaterials && active}
        onOpenChange={(open) => {
          if (!open) setPendingMaterials(null);
        }}
        title="替换本次制作材料"
        description="确认后替换词条和段落，保留本课节奏、声音默认、展示、预设及目标时长；新词条不继承旧词条的手动参数或锁定。"
      >
        {pendingMaterials && (
          <div className="stack">
            <p>
              当前 {lesson ? getEntries(lesson).length : 0} 条 → 新材料{' '}
              {pendingMaterials.entries.length} 条。进行中的任务继续制作原版本。
            </p>
            <div className="row">
              <Button data-modal-safe-action onClick={() => setPendingMaterials(null)}>
                保留原材料
              </Button>
              <Button
                variant="primary"
                onClick={() => acceptMaterials(pendingMaterials.entries, pendingMaterials.source)}
              >
                确认替换
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={oldResultOpen && active}
        onOpenChange={setOldResultOpen}
        title="旧制作成果（只读）"
        description="此结果属于制作时固定的版本，不会替换当前输入。"
      >
        {staleResult && (
          <div className="stack-sm">
            <p>
              {staleResult.name} · 修订 v{staleResult.revision} · {getEntries(staleResult).length}{' '}
              条词语
            </p>
            <ul>
              {getEntries(staleResult).map((entry) => (
                <li key={entry.id}>
                  {entry.english} · {entry.meaning || '未填写释义'} ·{' '}
                  {entry.audio?.status === 'ready' ? '声音已准备' : '声音未准备'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
      <LessonExportDialog
        open={exportOpen}
        assets={assetsRef.current}
        getCurrent={async () => {
          const current = lessonRef.current;
          if (!current || making.current) throw new Error('请等待当前制作结束。');
          const snapshot = await saveLesson(structuredClone(current), current.revision);
          if (mounted.current && lessonRef.current?.id === snapshot.id)
            setLesson({ ...lessonRef.current, revision: snapshot.revision });
          return snapshot;
        }}
        onPrepared={(revision, lessonId) => {
          if (mounted.current && lessonRef.current?.id === lessonId)
            setLesson({ ...lessonRef.current, preparedRevision: revision });
        }}
        onClose={() => setExportOpen(false)}
      />
      {classroom && active && (
        <WordBeatClassroom
          lesson={classroom}
          assets={assetsRef.current}
          resolveAsset={readAssetData}
          exitLabel="返回制作"
          onExit={() => setClassroom(null)}
        />
      )}
    </>
  );
}
