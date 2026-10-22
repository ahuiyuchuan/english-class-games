import { TaskProgress } from '../shared/ui/TaskProgress';
/**
 * 公共平台外壳：统一材料、课件、任务和资源入口，具体游戏通过注册表声明能力。
 * 不收集学生信息，不请求大模型或网络教学内容；所有结果来自本地真实数据。
 * @author ahui
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExportTaskCenter, LessonExportDialog } from './LessonExportDialog';
import { getExportTasks, flushExportHistory } from '../platform/exports';
import { cancelActiveMusicImport, setMusicImportsClosing } from '../platform/music-import';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Books,
  DotsThree,
  FileArrowUp,
  GameController,
  Gear,
  House,
  Info,
  List,
  MagnifyingGlass,
  Plus,
  Sparkle,
  Timer,
  WifiSlash,
} from '@phosphor-icons/react';
import type {
  LessonDocument,
  TeachingEntry,
  AssetMap,
  PackageIdentityPlan,
} from '../platform/types';
import { getGame, getGames } from '../platform/games';
import { getBuiltinDictionary } from '../platform/materials';
import {
  deleteLesson,
  desktopAvailable,
  listAssets,
  listLessons,
  getLesson,
  readAppData,
  readTeacherPreferences,
  saveLesson,
  saveLocalLessonCopy,
  saveTeacherPreferences,
  readAssetData,
  writeAppData,
} from '../platform/repository';
import type { MaterialCollection, TeacherPreferences } from '../platform/repository';
import * as native from '../platform/native';
import { stopPreview, previewAudio, validatePlayableAssets } from '../platform/audio-preview';
import { Badge, Button, InputField, Modal, Notice, errorMessage, useFeedback } from '../shared/ui';
import { useDiscardGuard } from '../shared/ui/useDiscardGuard';
import { PreparationVisual } from '../shared/ui/PreparationVisual';
import { validatePackageManifest, validatePackageData } from '../shared/schemas/lesson-package';
import { getGameViews } from './game-views';
import type { GameEditorProps } from './game-views';
import { MaterialsPage, CommonWordsDialog } from './MaterialsPage';
import { SettingsPage } from './SettingsPage';
import { AboutPage } from './AboutPage';

type Page = 'dashboard' | 'games' | 'materials' | 'lessons' | 'settings' | 'wizard' | 'about';
const NAVIGATION = [
  { id: 'dashboard', label: 'AI 工作台', icon: House },
  { id: 'games', label: '游戏库', icon: GameController },
  { id: 'materials', label: '教学材料', icon: Books },
  { id: 'lessons', label: '我的课件', icon: FileArrowUp },
  { id: 'settings', label: '资源与设置', icon: Gear },
  { id: 'about', label: '关于', icon: Info },
] as const;

/** 平台入口保留列表筛选和位置；编辑离开须等待当前输入成功落盘。 */
export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [editing, setEditing] = useState<LessonDocument | null>(null);
  const [wizardGameId, setWizardGameId] = useState(getGames()[0]?.id ?? '');
  const [wizardEntries, setWizardEntries] = useState<TeachingEntry[]>();
  const [wizardStarted, setWizardStarted] = useState(false);
  const [wizardSession, setWizardSession] = useState(0);
  const [editorAction, setEditorAction] = useState<GameEditorProps['initialAction']>();
  const [editorSession, setEditorSession] = useState(0);
  const [rename, setRename] = useState('');
  const [copySource, setCopySource] = useState<LessonDocument | null>(null);
  const [copyName, setCopyName] = useState('');
  const [copyMaterials, setCopyMaterials] = useState<'keep' | 'replace'>('keep');
  const [copyBusy, setCopyBusy] = useState(false);
  const copyOperation = useRef(false);
  const [packagePreview, setPackagePreview] = useState<{
    token: string;
    document: LessonDocument;
    assets: AssetMap;
    identityPlan: PackageIdentityPlan;
  } | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState<string[]>([]);
  const [packageExportSource, setPackageExportSource] = useState<LessonDocument | null>(null);
  const [taskView, setTaskView] = useState<{
    task: native.TaskRecord;
    lesson: LessonDocument;
    assets: AssetMap;
    ownerId: string;
  } | null>(null);
  const [taskClassroom, setTaskClassroom] = useState(false);
  const [taskPreviewBusy, setTaskPreviewBusy] = useState(false);
  const taskPreviewOperation = useRef(false);
  const packageOperation = useRef(false);
  const menuOperation = useRef(false);
  const taskOperations = useRef(new Set<string>());
  const closing = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [commonDraft, setCommonDraft] = useState<TeachingEntry[] | null>(null);
  const [error, setError] = useState('');
  const [lessonQuery, setLessonQuery] = useState('');
  /** 重置过滤条件后恢复可继续输入的位置，不改变课件和列表排序。 */
  const lessonSearch = useRef<HTMLInputElement>(null);
  const [stateFilter, setStateFilter] = useState('all');
  const [assetOverrides, setAssetOverrides] = useState<AssetMap>({});
  const [openLessonMenu, setOpenLessonMenu] = useState<LessonDocument | null>(null);
  const flushEditor = useRef<(() => Promise<LessonDocument>) | null>(null);
  const leaveMaterials = useRef<(() => Promise<boolean>) | null>(null);
  const leaveSettings = useRef<(() => Promise<boolean>) | null>(null);
  const leaveCommonWords = useRef<(() => Promise<boolean>) | null>(null);
  const leaveAppForms = useRef<(() => Promise<boolean>) | null>(null);
  const switching = useRef(false);
  const listScroll = useRef(0);
  const { confirm, notify } = useFeedback();
  const canDiscardRename = useDiscardGuard({
    dirty: !!openLessonMenu && rename !== openLessonMenu.name,
    busy: menuBusy,
    subject: '课件名称',
  });
  const canDiscardCopy = useDiscardGuard({
    dirty:
      !!copySource &&
      (copyName !== `${[...copySource.name].slice(0, 77).join('')} 副本` ||
        copyMaterials !== 'keep'),
    busy: copyBusy,
    subject: '副本名称或材料选项',
  });
  // 原生关闭回调只注册一次，从 ref 读取当前表单，避免关闭窗口绕过页面内的保护。
  leaveAppForms.current = async () => {
    if (openLessonMenu && !(await canDiscardRename())) return false;
    if (copySource && !(await canDiscardCopy())) return false;
    if (leaveCommonWords.current && !(await leaveCommonWords.current())) return false;
    if (leaveSettings.current && !(await leaveSettings.current())) return false;
    return !leaveMaterials.current || leaveMaterials.current();
  };
  const queryClient = useQueryClient();
  const lessonData = useQuery({ queryKey: ['lessons'], queryFn: listLessons });
  const assetData = useQuery({ queryKey: ['assets'], queryFn: listAssets });
  const dictionary = useQuery({
    queryKey: ['dictionary'],
    queryFn: getBuiltinDictionary,
    staleTime: Infinity,
  });
  const materialsData = useQuery({
    queryKey: ['materials'],
    queryFn: () => readAppData<MaterialCollection[]>('materials', []),
  });
  const commonData = useQuery({
    queryKey: ['commonWords'],
    queryFn: () => readAppData<TeachingEntry[]>('commonWords', []),
  });
  const preferencesData = useQuery({
    queryKey: ['preferences'],
    queryFn: readTeacherPreferences,
  });
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: native.listTasks,
    enabled: desktopAvailable,
    refetchInterval: 1000,
  });
  const assets = useMemo(
    () => ({
      ...Object.fromEntries((assetData.data ?? []).map((asset) => [asset.assetId, asset])),
      ...assetOverrides,
    }),
    [assetData.data, assetOverrides],
  );
  useEffect(() => {
    setAssetOverrides({});
  }, [assetData.data]);
  useEffect(() => {
    if (openLessonMenu) setRename(openLessonMenu.name);
  }, [openLessonMenu]);
  useEffect(() => {
    const ownerId = taskView?.ownerId;
    return () => {
      stopPreview();
      if (ownerId) void native.releaseAssets(ownerId).catch(() => undefined);
    };
  }, [taskView]);
  useEffect(() => {
    if (!taskClassroom) return;
    const shell = document.querySelector<HTMLElement>('.shell');
    if (!shell) return;
    shell.inert = true;
    return () => {
      shell.inert = false;
    };
  }, [taskClassroom]);
  const lessons = lessonData.data ?? [];
  const commonWords = commonData.data ?? [];
  const materials = materialsData.data ?? [];
  const preferences: TeacherPreferences = preferencesData.data ?? { gameDefaults: {} };
  const activeTasks =
    tasks.data?.filter((task) => ['queued', 'running', 'cancelling'].includes(task.state)).length ??
    0;
  const setAssets = (next: AssetMap) => {
    setAssetOverrides((previous) => ({ ...previous, ...next }));
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
  };
  const registerFlush = useCallback((flush: (() => Promise<LessonDocument>) | null) => {
    flushEditor.current = flush;
  }, []);
  const registerMaterialsGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    leaveMaterials.current = guard;
  }, []);
  const registerSettingsGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    leaveSettings.current = guard;
  }, []);
  const registerCommonGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    leaveCommonWords.current = guard;
  }, []);
  const navigate = async (target: Page) => {
    if (switching.current) return;
    switching.current = true;
    setError('');
    try {
      if (!editing && page === target) {
        setMenuOpen(false);
        return;
      }
      if (leaveMaterials.current && !(await leaveMaterials.current())) return;
      if (leaveSettings.current && !(await leaveSettings.current())) return;
      if (editing && flushEditor.current) await flushEditor.current();
      setEditing(null);
      setPage(target);
      setMenuOpen(false);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError'))
        setError(errorMessage(cause));
    } finally {
      switching.current = false;
    }
  };
  const make = (entries?: TeachingEntry[], gameId = getGames()[0]?.id ?? '') => {
    void (async () => {
      if (switching.current) return;
      switching.current = true;
      try {
        if (!getGameViews(gameId)) throw new Error('此游戏暂未提供制作页面。');
        if (leaveMaterials.current && !(await leaveMaterials.current())) return;
        if (leaveSettings.current && !(await leaveSettings.current())) return;
        if (flushEditor.current) await flushEditor.current();
        if (
          wizardStarted &&
          (entries || wizardGameId !== gameId) &&
          !(await confirm({
            title: '开始另一份制作',
            message: '将用所选材料替换尚未结束的制作会话。已保存课件仍保留，是否继续？',
          }))
        )
          return;
        if (!wizardStarted || entries || wizardGameId !== gameId) {
          setWizardSession((value) => value + 1);
          setWizardEntries(entries);
        }
        setWizardStarted(true);
        setWizardGameId(gameId);
        setPage('wizard');
        setEditing(null);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError'))
          setError(errorMessage(cause));
      } finally {
        switching.current = false;
      }
    })();
  };
  const openEditor = async (
    document: LessonDocument,
    action?: GameEditorProps['initialAction'],
  ): Promise<boolean> => {
    const game = getGame(document.gameId);
    if (!game || !getGameViews(document.gameId)) {
      setError('当前软件不包含此游戏，请使用包含该游戏的受支持版本。原数据已保留。');
      return false;
    }
    if (game.validateStructure(document).length) {
      setError('课件结构或数据版本不受支持，原资料已保留。');
      return false;
    }
    if (switching.current) return false;
    switching.current = true;
    try {
      if (leaveMaterials.current && !(await leaveMaterials.current())) return false;
      if (leaveSettings.current && !(await leaveSettings.current())) return false;
      if (editing && flushEditor.current) await flushEditor.current();
      const latest = await getLesson(document.id);
      if (game.validateStructure(latest).length)
        throw new Error('课件结构不受支持，原资料已保留。');
      listScroll.current = window.scrollY;
      setEditorAction(action);
      setEditorSession((value) => value + 1);
      setEditing(latest);
      return true;
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError'))
        setError(errorMessage(cause));
      return false;
    } finally {
      switching.current = false;
    }
  };

  const persistMetadata = async <T,>(key: 'materials' | 'commonWords', value: T) => {
    await writeAppData(key, value);
    queryClient.setQueryData([key], value);
  };

  /** 制作默认由各游戏校验；保存成功后才刷新缓存，不影响已有课件。 */
  const persistPreferences = async (value: TeacherPreferences) => {
    await saveTeacherPreferences(value);
    queryClient.setQueryData(['preferences'], value);
  };
  const saveMaterial = async (
    entries: TeachingEntry[],
    source: { name: string; original: string },
  ) => {
    const now = new Date().toISOString();
    await persistMetadata('materials', [
      {
        id: crypto.randomUUID(),
        name: source.name,
        original: source.original,
        entries: structuredClone(entries),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      },
      ...materials,
    ]);
  };

  useEffect(() => {
    if (editing) return;
    if (page === 'lessons') requestAnimationFrame(() => window.scrollTo(0, listScroll.current));
    else window.scrollTo(0, 0);
  }, [page, editing]);

  /** Tauri 正常关闭先保存；失败阻止退出并保留编辑输入，异常退出仅恢复成功落盘内容。 */
  useEffect(() => {
    if (!desktopAvailable) return;
    let release: (() => void) | undefined;
    let unmounted = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const windowHandle = getCurrentWindow();
      // 导入、复制和菜单文件动作使用同步锁；原生 X 不能绕过浮层的 busy 状态中断写盘。
      const hasActiveFileOperation = () =>
        packageOperation.current ||
        menuOperation.current ||
        copyOperation.current ||
        getExportTasks().some(
          (task) => task.running || task.outcomes.some((item) => item.state === 'running'),
        );
      const unlisten = await windowHandle.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing.current || hasActiveFileOperation()) return;
        closing.current = true;
        setMusicImportsClosing(true);
        try {
          // Finish cancellation before destroying the renderer; a late native
          // preparation must not outlive its UI or publish a resource after exit.
          await cancelActiveMusicImport();
          if (leaveAppForms.current && !(await leaveAppForms.current())) {
            closing.current = false;
            return;
          }
          await flushEditor.current?.();
          // 等待教师确认或自动保存期间仍可能收到异步文件操作，销毁前读取最新状态。
          if (hasActiveFileOperation()) {
            closing.current = false;
            return;
          }
          await flushExportHistory();
          if (hasActiveFileOperation()) {
            closing.current = false;
            return;
          }
          await windowHandle.destroy();
        } catch (cause) {
          closing.current = false;
          if (!(cause instanceof DOMException && cause.name === 'AbortError'))
            setError(`保存未完成，已保留窗口：${errorMessage(cause)}`);
        } finally {
          setMusicImportsClosing(false);
        }
      });
      if (unmounted) unlisten();
      else release = unlisten;
    });
    return () => {
      unmounted = true;
      release?.();
    };
  }, []);

  const importPackage = async () => {
    if (packageOperation.current) return;
    packageOperation.current = true;
    setError('');
    try {
      const file = await native.selectFile('lessonPackage');
      if (!file) return;
      const inspection = await native.inspectLessonPackage(file.token);
      const manifest = validatePackageManifest(inspection.manifest);
      const envelope = validatePackageData(inspection.lesson, manifest);
      const module = getGame(envelope.gameId);
      if (!module)
        throw new Error('当前软件不包含此游戏，请使用包含该游戏的受支持版本。原文件已保留。');
      const validated = validatePackageData(inspection.lesson, manifest, module.validateStructure);
      setPackagePreview({
        token: file.token,
        identityPlan: {
          lessonSha256: manifest.lessonSha256,
          revisions: validated.revisions.map((snapshot) => ({
            revision: snapshot.revision,
            layout: module.describeIdentities(snapshot),
          })),
        },
        document: validated.revisions.find(
          (snapshot) => snapshot.revision === validated.draftRevision,
        )!,
        assets: Object.fromEntries(inspection.assets.map((asset) => [asset.assetId, asset])),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      packageOperation.current = false;
    }
  };

  /** 导入选择先展示真实摘要，两个入口都只复用已验证相同的内容或创建副本。 */
  const confirmPackage = async (asCopy: boolean) => {
    if (!packagePreview || packageOperation.current) return;
    packageOperation.current = true;
    setPackageBusy(true);
    try {
      const imported = await native.importLessonPackage(
        packagePreview.token,
        asCopy,
        packagePreview.identityPlan,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['lessons'] }),
        queryClient.invalidateQueries({ queryKey: ['assets'] }),
      ]);
      setPackagePreview(null);
      openEditor(imported);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      packageOperation.current = false;
      setPackageBusy(false);
    }
  };

  /** 菜单动作读取最新修订，防止列表快照过期或双击创建多个副本。 */
  const performLessonAction = async (
    action: (current: LessonDocument) => Promise<void>,
    options?: { discardRename: boolean },
  ) => {
    if (!openLessonMenu || menuOperation.current) return;
    if (options?.discardRename && !(await canDiscardRename())) return;
    if (menuOperation.current) return;
    menuOperation.current = true;
    setMenuBusy(true);
    setError('');
    try {
      await action(await getLesson(openLessonMenu.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      menuOperation.current = false;
      setMenuBusy(false);
    }
  };

  /** 副本独立落盘；源课件变化时先刷新说明，避免确认旧信息后复制另一版。 */
  const createCopy = async () => {
    if (!copySource || copyOperation.current) return;
    const name = copyName.trim();
    if (!name || [...name].length > 80) {
      setError('副本名称须为 1～80 个字符。');
      return;
    }
    copyOperation.current = true;
    setCopyBusy(true);
    setError('');
    try {
      const latest = await getLesson(copySource.id);
      if (latest.revision !== copySource.revision) {
        setCopySource(latest);
        setError(`源课件已更新为 v${latest.revision}，请核对当前摘要后再次创建副本。`);
        return;
      }
      const module = getGame(latest.gameId);
      if (!module || !getGameViews(latest.gameId))
        throw new Error('请使用包含该游戏的受支持软件版本。');
      if (module.validateStructure(latest).length)
        throw new Error('源课件结构不受支持，原数据已保留。');
      const copy = await saveLocalLessonCopy(latest, name);
      await queryClient.invalidateQueries({ queryKey: ['lessons'] });
      setCopySource(null);
      await openEditor(copy, copyMaterials === 'replace' ? 'replace-materials' : undefined);
      notify('独立副本已保存，原课件不变。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      copyOperation.current = false;
      setCopyBusy(false);
    }
  };

  /** 摘要由模块计算，包预览和复制页不读取某一游戏的专属字段。 */
  const summaryLine = (document: LessonDocument, sourceAssets: AssetMap): string => {
    const module = getGame(document.gameId);
    try {
      const summary = module?.summarize?.(document, sourceAssets);
      return [
        summary?.itemCount !== undefined
          ? `${summary.itemCount} ${summary.itemLabel ?? '项'}`
          : undefined,
        summary?.durationMs !== undefined
          ? `编排 ${(summary.durationMs / 60_000).toFixed(1)} 分钟`
          : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    } catch {
      return '摘要暂不可用，导入后请检查草稿。';
    }
  };

  /** 清除终态候选与取消活动任务分别执行；请求未确认前不重复提交。 */
  const updateTask = async (task: native.TaskRecord, clear: boolean) => {
    if (taskOperations.current.has(task.taskId)) return;
    taskOperations.current.add(task.taskId);
    setTaskBusy([...taskOperations.current]);
    try {
      if (clear) {
        if (
          !(await confirm({
            title: '清除任务记录',
            message:
              '此任务未采用的声音将解除保留，之后可由缓存清理回收。已保存到课件的声音不受影响。',
            confirmLabel: '清除记录',
          }))
        )
          return;
        await native.clearTask(task.taskId);
      } else await native.cancelTask(task.taskId);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      taskOperations.current.delete(task.taskId);
      setTaskBusy([...taskOperations.current]);
    }
  };

  /** 原修订和成功声音被独立保留，只读查看不会写入正在编辑的新草稿。 */
  const viewTaskResult = async (task: native.TaskRecord) => {
    if (
      !task.lessonId ||
      task.inputRevision === undefined ||
      taskOperations.current.has(task.taskId)
    )
      return;
    taskOperations.current.add(task.taskId);
    setTaskBusy([...taskOperations.current]);
    setError('');
    const ownerId = crypto.randomUUID();
    try {
      const record = await native.getTask(task.taskId);
      const input = await native.getTaskInput(task.taskId);
      if (input.id !== task.lessonId || input.revision !== task.inputRevision)
        throw new Error('任务输入快照与记录版本不一致，不能以当前草稿替代。');
      const module = getGame(input.gameId);
      if (!module?.restoreAudioTask || module.validateStructure(input).length)
        throw new Error('当前软件无法查看此游戏的制作成果，请保留原课件。');
      const candidate = module.restoreAudioTask(input, assets, record);
      const resultIds = record.results.map((result) => result.asset.assetId);
      await native.retainAssets(ownerId, resultIds, input.id, input.revision);
      stopPreview();
      setTaskView({ task: record, ...candidate, ownerId });
      setTasksOpen(false);
    } catch (cause) {
      await native.releaseAssets(ownerId).catch(() => undefined);
      setError(errorMessage(cause));
    } finally {
      taskOperations.current.delete(task.taskId);
      setTaskBusy([...taskOperations.current]);
    }
  };

  const previewTaskResult = async () => {
    if (!taskView || taskPreviewOperation.current) return;
    taskPreviewOperation.current = true;
    setTaskPreviewBusy(true);
    setError('');
    try {
      stopPreview();
      await validatePlayableAssets(taskView.lesson, taskView.assets);
      setTaskClassroom(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      taskPreviewOperation.current = false;
      setTaskPreviewBusy(false);
    }
  };

  /** 关闭只读成果释放其素材保留；原课件已删时回到稳定的工作台入口。 */
  const closeTaskResult = () => {
    if (taskView && !lessons.some((document) => document.id === taskView.lesson.id))
      setPage('dashboard');
    setTaskClassroom(false);
    setTaskView(null);
  };

  const card = (document: LessonDocument) => {
    const game = getGame(document.gameId);
    let summary;
    try {
      summary = game?.summarize?.(document, assets);
    } catch {
      /* 坏草稿显示修复状态，列表仍可达。 */
    }
    const duration = summary?.durationMs;
    let status = '草稿';
    if (game) {
      try {
        const states = {
          draft: '草稿',
          pending: '声音待制作',
          stale: '声音需更新',
          repair: '需修复',
          ready: '可上课',
        };
        status = summary?.preparationState ? states[summary.preparationState] : '草稿';
      } catch {
        /* 列表保留不可运行草稿及其状态。 */
      }
    }
    return (
      <div className="lesson-card" key={document.id}>
        <button className="card-main" onClick={() => openEditor(document)}>
          <div className="lesson-cover" aria-hidden="true">
            <GameController size={35} weight="duotone" />
            <span className="lesson-cover-word">
              ENGLISH
              <br />
              CLASS GAMES
            </span>
            <span className="lesson-cover-wave">
              {[1, 2, 3, 4, 5].map((item) => (
                <i key={item} />
              ))}
            </span>
          </div>
          <div className="row spread">
            <Badge>{game?.name ?? '缺少游戏模块'}</Badge>
            <Badge tone={status === '可上课' ? 'success' : 'warning'}>{status}</Badge>
          </div>
          <h3>{document.name}</h3>
          <div className="metric-line">
            {summary?.itemCount !== undefined && (
              <span>
                {summary.itemCount} {summary.itemLabel ?? '项'}
              </span>
            )}
            {duration !== undefined && <span>{(duration / 60_000).toFixed(1)} 分钟</span>}
          </div>
          <small>
            修改于 {new Date(document.updatedAt).toLocaleString()} · v{document.revision}
          </small>
        </button>
        <div className="row spread">
          <Button onClick={() => openEditor(document)}>
            继续编辑
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          {game?.capabilities.preview && (
            <Button variant="text" onClick={() => openEditor(document, 'preview')}>
              预演
            </Button>
          )}
          {game?.capabilities.portable && (
            <Button variant="text" onClick={() => openEditor(document, 'export')}>
              导出
            </Button>
          )}
          <Button
            variant="text"
            className="icon-button"
            aria-label={`${document.name}更多操作`}
            onClick={() => setOpenLessonMenu(document)}
          >
            <DotsThree size={24} aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  };

  const nav = (
    <>
      <div className="brand">
        <img className="brand-logo" src="/app-icon.svg" width="48" height="52" alt="" />
        <div className="brand-text">
          English Class Games<span>智能备课 · 轻松开口</span>
        </div>
      </div>
      <nav className="navigation" aria-label="主导航">
        {NAVIGATION.map((item) => (
          <button
            key={item.id}
            className="nav-item"
            aria-current={page === item.id && !editing ? 'page' : undefined}
            title={item.label}
            onClick={() => {
              void navigate(item.id);
            }}
          >
            <item.icon size={20} aria-hidden="true" />
            <span className="nav-label">{item.label}</span>
            <ArrowRight className="nav-indicator" size={15} aria-hidden="true" />
          </button>
        ))}
      </nav>
      <div className="sidebar-footer stack-sm">
        <span className="sidebar-footer-label">为真实课堂准备</span>
        <div className="row">
          <WifiSlash size={16} aria-hidden="true" />
          <small>本地运行 · 离线可用</small>
        </div>
        <small>高中英语课堂 · V1.0</small>
      </div>
    </>
  );

  const queryError = [
    lessonData.error,
    dictionary.error,
    materialsData.error,
    commonData.error,
    assetData.error,
    preferencesData.error,
  ].find(Boolean);
  const loading =
    lessonData.isPending ||
    dictionary.isPending ||
    commonData.isPending ||
    assetData.isPending ||
    materialsData.isPending ||
    preferencesData.isPending;
  const EditorView = editing ? getGameViews(editing.gameId)?.Editor : undefined;
  const WizardView = getGameViews(wizardGameId)?.Wizard;
  const ReadonlyLessonView = taskView
    ? getGameViews(taskView.lesson.gameId)?.ReadonlyLessonView
    : undefined;
  const TaskClassroomView = taskView ? getGame(taskView.lesson.gameId)?.Classroom : undefined;
  let content;
  if (editing && EditorView)
    content = (
      <EditorView
        key={`${editing.id}:${editorSession}`}
        active={!taskClassroom}
        initial={editing}
        initialAction={editorAction}
        dictionary={dictionary.data ?? []}
        commonWords={commonWords}
        assets={assets}
        onAssets={setAssets}
        onExit={() => {
          setEditing(null);
          setPage('lessons');
        }}
        onRegisterFlush={registerFlush}
        onSaveCommon={setCommonDraft}
      />
    );
  else if (loading)
    content = (
      <div className="page panel stack">
        <h2>正在打开本地工作台</h2>
        <p className="muted">读取课件、词库与已保存偏好。</p>
      </div>
    );
  else if (queryError)
    content = (
      <div className="page">
        <Notice tone="error" role="alert">
          {errorMessage(queryError)}
          <Button
            onClick={() => {
              void queryClient.invalidateQueries();
            }}
          >
            重新读取
          </Button>
        </Notice>
      </div>
    );
  else if (page === 'wizard' && WizardView) content = null;
  else if (page === 'materials')
    content = (
      <MaterialsPage
        dictionary={dictionary.data ?? []}
        commonWords={commonWords}
        materials={materials}
        onMaterials={(value) => persistMetadata('materials', value)}
        onCommonWords={(value) => persistMetadata('commonWords', value)}
        onMake={make}
        onSaveCommon={setCommonDraft}
        onRegisterLeaveGuard={registerMaterialsGuard}
      />
    );
  else if (page === 'about') content = <AboutPage />;
  else if (page === 'settings')
    content = (
      <SettingsPage
        preferences={preferences}
        onPreferences={persistPreferences}
        assets={assets}
        onAssets={setAssets}
        onRegisterLeaveGuard={registerSettingsGuard}
      />
    );
  else if (page === 'games')
    content = (
      <div className="page games-page stack">
        <div className="page-heading">
          <div>
            <h1>游戏库</h1>
            <p>把教学材料变成可以直接带进教室的活动。</p>
          </div>
        </div>
        <div className="grid-three">
          {getGames().map((game) => (
            <div className="panel game-feature-card" key={game.id}>
              <div className="game-art" aria-hidden="true">
                <span className="game-art-title">ENGLISH CLASS GAMES</span>
                {[1, 2, 3, 4].map((number) => (
                  <div className="beat-block" key={number} />
                ))}
                <span className="game-art-caption">WORDS. BEATS. PLAY.</span>
              </div>
              <div className="stack game-feature-copy">
                <Badge tone="ai">本地智能编排</Badge>
                <h2>{game.name}</h2>
                <p className="muted">{game.description}</p>
                <p className="caption">适合：高中词汇巩固、短语复习、全班开口练习</p>
                <Button variant="primary" onClick={() => make(undefined, game.id)}>
                  <Sparkle size={18} aria-hidden="true" />
                  制作课件
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  else if (page === 'lessons') {
    const filtered = lessons.filter(
      (document) =>
        document.name.toLowerCase().includes(lessonQuery.toLowerCase()) &&
        (stateFilter === 'all' ||
          (() => {
            try {
              return (
                getGame(document.gameId)?.summarize?.(document, assets).preparationState ===
                stateFilter
              );
            } catch {
              return stateFilter === 'repair';
            }
          })()),
    );
    content = (
      <div className="page lessons-page stack">
        <div className="page-heading">
          <div>
            <h1>我的课件</h1>
            <p>继续编辑、复制改编，或导出到教室使用。</p>
          </div>
          <div className="row">
            <Button
              onClick={() => {
                void importPackage();
              }}
            >
              <FileArrowUp size={18} aria-hidden="true" />
              导入课件包
            </Button>
            <Button variant="primary" onClick={() => make()}>
              <Sparkle size={18} aria-hidden="true" />
              智能制作
            </Button>
          </div>
        </div>
        <div className="row">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <input
            className="input"
            style={{ maxWidth: 400 }}
            aria-label="搜索课件"
            ref={lessonSearch}
            placeholder="搜索课件名称"
            value={lessonQuery}
            onChange={(event) => setLessonQuery(event.target.value)}
          />
          <select
            className="input"
            style={{ width: 180 }}
            aria-label="课件准备状态筛选"
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value)}
          >
            <option value="all">全部准备状态</option>
            <option value="draft">草稿</option>
            <option value="pending">声音待制作</option>
            <option value="stale">声音需更新</option>
            <option value="repair">需修复</option>
            <option value="ready">可上课</option>
          </select>
          {(lessonQuery || stateFilter !== 'all') && (
            <Button
              variant="text"
              onClick={() => {
                setLessonQuery('');
                setStateFilter('all');
                lessonSearch.current?.focus();
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
        {filtered.length ? (
          <div className="grid-three">{filtered.map(card)}</div>
        ) : (
          <div className="panel empty">
            <Books size={40} aria-hidden="true" />
            <h2>{lessons.length ? '没有匹配的课件' : '开始制作第一份课堂活动'}</h2>
            <p>
              {lessons.length
                ? '调整名称或准备状态筛选。'
                : '从自己的词表出发，让系统完成编排与声音准备。'}
            </p>
            {!lessons.length && (
              <Button variant="primary" onClick={() => make()}>
                智能制作
              </Button>
            )}
          </div>
        )}
      </div>
    );
  } else
    content = (
      <div className="page dashboard-page stack">
        <div className="page-heading">
          <div>
            <span className="page-eyebrow">CREATE. TEACH. PLAY.</span>
            <h1>AI 工作台</h1>
            <p>备好一节课，把更多时间留给课堂互动。</p>
          </div>
          <Badge>
            <WifiSlash size={14} aria-hidden="true" />
            离线智能辅助
          </Badge>
        </div>
        <section className="panel hero">
          <div className="hero-copy stack">
            <div>
              <Badge tone="ai">
                <Sparkle size={14} aria-hidden="true" />
                AI 备课助手
              </Badge>
              <h2>
                一份词表，变成
                <br />
                <span className="hero-title-accent">有节奏的英语课堂</span>
              </h2>
              <p className="muted">
                整理教学内容、推荐练习安排、生成示范与口号配音。你确认内容与节奏，系统完成准备和检查。
              </p>
            </div>
            <div className="row">
              <Button variant="primary" onClick={() => make()}>
                <Sparkle size={18} aria-hidden="true" />
                智能制作
                <ArrowRight size={18} aria-hidden="true" />
              </Button>
              <Button
                onClick={() => {
                  void navigate('materials');
                }}
              >
                导入 / 选材料
              </Button>
            </div>
            <small>词库与规则本地运行 · 结果可编辑 · 单文件离线携带</small>
          </div>
          <PreparationVisual />
        </section>
        <ol className="workflow" aria-label="智能制作路径">
          <li>
            <span className="workflow-number">1</span>
            <div>
              <h3>确认教学内容</h3>
              <small>词表、表格、阅读选词，保留你的教学范围</small>
            </div>
          </li>
          <li>
            <span className="workflow-number">2</span>
            <div>
              <h3>一键编排与配音</h3>
              <small>重点加强、短语留拍，真实声音参与计时</small>
            </div>
          </li>
          <li>
            <span className="workflow-number">3</span>
            <div>
              <h3>检查后带到课堂</h3>
              <small>导出一个 HTML，换电脑也能断网使用</small>
            </div>
          </li>
        </ol>
        {(wizardStarted || !!tasks.data?.some((task) => task.state !== 'completed')) && (
          <section className="stack" aria-label="可继续任务">
            <h2>可继续任务</h2>
            {wizardStarted && (
              <div className="panel panel-compact row spread">
                <div className="stack-sm">
                  <h3>尚未结束的智能制作</h3>
                  <p className="muted">继续当前材料、选择与编排参数。</p>
                </div>
                <Button onClick={() => make(undefined, wizardGameId)}>继续制作</Button>
              </div>
            )}
            {tasks.data
              ?.filter((task) => task.state !== 'completed')
              .slice(0, 3)
              .map((task) => (
                <div className="panel panel-compact row spread" key={task.taskId}>
                  <div className="stack-sm">
                    <h3>
                      {lessons.find((document) => document.id === task.lessonId)?.name ??
                        '声音准备任务'}
                    </h3>
                    <TaskProgress task={task} />
                  </div>
                  <Button onClick={() => setTasksOpen(true)}>查看任务</Button>
                </div>
              ))}
          </section>
        )}
        <section className="stack">
          <div className="section-heading">
            <h2>最近课件</h2>
            <Button
              variant="text"
              onClick={() => {
                void navigate('lessons');
              }}
            >
              查看全部
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
          {lessons.length ? (
            <div className="grid-three">{lessons.slice(0, 3).map(card)}</div>
          ) : (
            <div className="panel empty">
              <Plus size={32} aria-hidden="true" />
              <p>还没有课件，点击“智能制作”开始。</p>
            </div>
          )}
        </section>
      </div>
    );

  return (
    <div className={`shell ${editing ? 'editor-shell' : ''}`} data-page={editing ? 'editor' : page}>
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      <aside className="sidebar">{nav}</aside>
      <div className="app-body">
        <header className="topbar">
          <div className="row">
            <Button
              className="menu-button icon-button"
              aria-label="打开主导航"
              onClick={() => setMenuOpen(true)}
            >
              <List size={22} aria-hidden="true" />
            </Button>
            <div className="breadcrumb">
              <span className="breadcrumb-brand">English Class Games</span>
              <span aria-hidden="true">/</span>
              <span className="breadcrumb-current">
                {editing
                  ? '课件编辑'
                  : (NAVIGATION.find((item) => item.id === page)?.label ?? 'AI 智能制作')}
              </span>
            </div>
          </div>
          <div className="row topbar-actions">
            <Button variant="text" onClick={() => setTasksOpen(true)}>
              <Timer size={18} aria-hidden="true" />
              制作任务 {activeTasks > 0 && <Badge tone="ai">{activeTasks}</Badge>}
            </Button>
            <ExportTaskCenter
              onRestart={(lessonId) => {
                void getLesson(lessonId)
                  .then((document) => openEditor(document, 'export'))
                  .catch((cause) => setError(errorMessage(cause)));
              }}
            />
          </div>
        </header>
        {!desktopAvailable && (
          <div className="browser-preview-notice" style={{ padding: '12px 16px 0' }}>
            <Notice>
              {editing || page === 'wizard' ? (
                <details>
                  <summary>浏览器预览 · 内容保存在当前浏览器</summary>
                  完整备课、离线配音与文件管理请使用 Windows 软件。
                </details>
              ) : (
                '浏览器预览：内容保存在当前浏览器。完整备课、离线配音与文件管理请使用 Windows 软件。'
              )}
            </Notice>
          </div>
        )}
        {error && (
          <div style={{ padding: '12px 16px 0' }}>
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          </div>
        )}
        <main id="main-content" tabIndex={-1}>
          {content}
          {wizardStarted && WizardView && !loading && !queryError && (
            <div hidden={page !== 'wizard' || !!editing}>
              <WizardView
                key={wizardSession}
                active={page === 'wizard' && !editing && !taskClassroom}
                dictionary={dictionary.data ?? []}
                commonWords={commonWords}
                preferences={preferences}
                assets={assets}
                initialEntries={wizardEntries}
                onAssets={setAssets}
                onBack={() => {
                  void navigate('dashboard');
                }}
                onEdit={(document) => {
                  void queryClient.invalidateQueries({ queryKey: ['lessons'] });
                  void openEditor(document).then((opened) => {
                    if (opened) setWizardStarted(false);
                  });
                }}
                onMaterial={saveMaterial}
              />
            </div>
          )}
        </main>
      </div>
      <Modal open={menuOpen} onOpenChange={setMenuOpen} title="主导航" drawer>
        <div className="stack">
          {NAVIGATION.map((item) => (
            <Button
              key={item.id}
              variant={page === item.id && !editing ? 'primary' : 'secondary'}
              aria-current={page === item.id && !editing ? 'page' : undefined}
              onClick={() => {
                void navigate(item.id);
              }}
            >
              <item.icon size={20} aria-hidden="true" />
              {item.label}
            </Button>
          ))}
        </div>
      </Modal>
      <Modal
        open={!!packagePreview}
        onOpenChange={(open) => {
          if (!open && !packageBusy) setPackagePreview(null);
        }}
        title="检查可编辑课件包"
        footer={
          <>
            <Button disabled={packageBusy} onClick={() => setPackagePreview(null)}>
              取消
            </Button>
            <Button
              busy={packageBusy}
              onClick={() => {
                void confirmPackage(false);
              }}
            >
              打开相同内容或导入副本
            </Button>
            <Button
              variant="primary"
              busy={packageBusy}
              onClick={() => {
                void confirmPackage(true);
              }}
            >
              导入独立副本
            </Button>
          </>
        }
      >
        {packagePreview && (
          <div className="stack">
            <h3>{packagePreview.document.name}</h3>
            <p>游戏：{getGame(packagePreview.document.gameId)?.name}</p>
            <p>
              草稿 v{packagePreview.document.revision}；已准备版本：
              {packagePreview.document.preparedRevision ?? '无'}
            </p>
            <p>{summaryLine(packagePreview.document, packagePreview.assets)}</p>
            <Notice>
              文件、两份版本结构及素材已检查。已有不同内容不会覆盖；只有实际留存且内容一致的修订才可复用。未完成草稿导入后仍需修复才能上课。
            </Notice>
          </div>
        )}
      </Modal>
      <Modal open={tasksOpen} onOpenChange={setTasksOpen} title="制作任务">
        <div className="stack">
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
          {!desktopAvailable ? (
            <Notice>声音任务在 Windows 备课软件中执行。</Notice>
          ) : !tasks.data?.length ? (
            <p className="muted">还没有制作任务。任务执行时会展示实际阶段和完成数量。</p>
          ) : (
            tasks.data.map((task) => (
              <div className="panel panel-compact stack-sm" key={task.taskId}>
                <TaskProgress task={task} />
                <small>
                  输入版本 {task.inputRevision ?? '音色试听'} ·{' '}
                  {new Date(task.createdAt).toLocaleString()}
                </small>
                {task.failures.map((failure) => (
                  <Notice tone="error" key={failure.requestId}>
                    {failure.error.message}
                  </Notice>
                ))}
                {!!task.results.length && (
                  <details>
                    <summary>查看声音成果（只读）</summary>
                    <ul>
                      {task.results.map((result) => (
                        <li key={result.requestId}>
                          {result.asset.name ?? '已准备声音'} ·{' '}
                          {result.cached ? '复用缓存' : '本次制作'} ·{' '}
                          {(result.asset.durationMs / 1000).toFixed(1)} 秒
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="row">
                  {task.lessonId && task.inputRevision !== undefined && (
                    <Button
                      busy={taskBusy.includes(task.taskId)}
                      onClick={() => {
                        void viewTaskResult(task);
                      }}
                    >
                      查看旧成果（只读）
                    </Button>
                  )}
                  {['queued', 'running'].includes(task.state) && (
                    <Button
                      busy={taskBusy.includes(task.taskId)}
                      onClick={() => {
                        void updateTask(task, false);
                      }}
                    >
                      取消任务
                    </Button>
                  )}
                  {!['queued', 'running', 'cancelling'].includes(task.state) && (
                    <Button
                      variant="text"
                      busy={taskBusy.includes(task.taskId)}
                      onClick={() => {
                        void updateTask(task, true);
                      }}
                    >
                      清除记录
                    </Button>
                  )}
                  {task.lessonId &&
                    (() => {
                      const document = lessons.find((item) => item.id === task.lessonId);
                      return (
                        <Button
                          onClick={() => {
                            setTasksOpen(false);
                            if (document) {
                              void openEditor(document);
                              return;
                            }
                            setPage('dashboard');
                            setTasksOpen(false);
                            setTaskView(null);
                          }}
                        >
                          {document ? '返回当前课件' : '返回工作台'}
                        </Button>
                      );
                    })()}
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>
      <Modal
        open={!!taskView && !taskClassroom}
        onOpenChange={(open) => {
          if (!open && !taskPreviewOperation.current) closeTaskResult();
        }}
        title="制作成果（只读）"
        footer={
          <>
            <Button disabled={taskPreviewBusy} onClick={closeTaskResult}>
              关闭成果
            </Button>
            <Button
              busy={taskPreviewBusy}
              onClick={() => {
                void previewTaskResult();
              }}
            >
              检查并预演原成果
            </Button>
          </>
        }
      >
        {taskView && (
          <div className="stack">
            <h3>
              {taskView.lesson.name} · v{taskView.lesson.revision}
            </h3>
            <p>{summaryLine(taskView.lesson, taskView.assets)}</p>
            <Notice>
              {lessons.some((document) => document.id === taskView.lesson.id)
                ? '这里只查看任务原版本与当时成功的声音，不覆盖当前草稿。未完成资源须回当前课件重新制作。'
                : '原课件已删除；这里只保留任务原稿和当时成功的声音。关闭后返回工作台。'}
            </Notice>
            {error && (
              <Notice tone="error" role="alert">
                {error}
              </Notice>
            )}
            {ReadonlyLessonView && (
              <ReadonlyLessonView
                lesson={taskView.lesson}
                assets={taskView.assets}
                onListen={(id) => {
                  void previewAudio(taskView.assets[id]).catch((cause) =>
                    setError(errorMessage(cause)),
                  );
                }}
              />
            )}
          </div>
        )}
      </Modal>
      <CommonWordsDialog
        entries={commonDraft}
        existing={commonWords}
        onClose={() => setCommonDraft(null)}
        onRegisterLeaveGuard={registerCommonGuard}
        onSave={async (value) => {
          await persistMetadata('commonWords', value);
          notify('教师常用词已保存。');
        }}
      />
      <Modal
        open={!!openLessonMenu}
        onOpenChange={(open) => {
          if (!open && !menuOperation.current)
            void canDiscardRename().then((allowed) => {
              if (allowed) setOpenLessonMenu(null);
            });
        }}
        title={openLessonMenu?.name ?? '课件操作'}
        small
      >
        <div className="stack">
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
          <InputField
            label="课件名称"
            value={rename}
            onChange={(event) => setRename(event.target.value)}
            disabled={menuBusy}
            error={
              !rename.trim() || [...rename.trim()].length > 80
                ? '名称须为 1～80 个字符。'
                : undefined
            }
          />
          <Button
            disabled={!rename.trim() || [...rename.trim()].length > 80}
            busy={menuBusy}
            onClick={() => {
              void performLessonAction(async (latest) => {
                await saveLesson({ ...latest, name: rename.trim() }, latest.revision);
                await queryClient.invalidateQueries({ queryKey: ['lessons'] });
                setOpenLessonMenu(null);
                notify('课件名称已更新。');
              });
            }}
          >
            保存名称
          </Button>
          <Button
            busy={menuBusy}
            onClick={() => {
              void performLessonAction(
                async (latest) => {
                  setCopySource(latest);
                  setCopyName(`${[...latest.name].slice(0, 77).join('')} 副本`);
                  setCopyMaterials('keep');
                  setOpenLessonMenu(null);
                },
                { discardRename: true },
              );
            }}
          >
            复制并改编
          </Button>
          <Button
            busy={menuBusy}
            onClick={() => {
              void performLessonAction(
                async (latest) => {
                  setPackageExportSource(latest);
                  setOpenLessonMenu(null);
                },
                { discardRename: true },
              );
            }}
          >
            导出可编辑包
          </Button>
          <Button
            variant="danger"
            busy={menuBusy}
            onClick={() => {
              void performLessonAction(
                async (latest) => {
                  if (
                    !(await confirm({
                      title: '删除课件',
                      message: `删除「${latest.name}」及其修订记录；已导出的课堂文件保留。`,
                      danger: true,
                    }))
                  )
                    return;
                  await deleteLesson(latest.id);
                  await queryClient.invalidateQueries({ queryKey: ['lessons'] });
                  setOpenLessonMenu(null);
                },
                { discardRename: true },
              );
            }}
          >
            删除课件
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!copySource}
        onOpenChange={(open) => {
          if (!open && !copyOperation.current)
            void canDiscardCopy().then((allowed) => {
              if (allowed) setCopySource(null);
            });
        }}
        title="复制并改编"
        footer={
          <>
            <Button
              disabled={copyBusy}
              onClick={() => {
                void canDiscardCopy().then((allowed) => {
                  if (allowed) setCopySource(null);
                });
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              busy={copyBusy}
              disabled={!copyName.trim() || [...copyName.trim()].length > 80}
              onClick={() => {
                void createCopy();
              }}
            >
              创建独立副本
            </Button>
          </>
        }
      >
        {copySource && (
          <div className="stack">
            <p>
              来源：{copySource.name} · v{copySource.revision}
            </p>
            <p className="muted">{summaryLine(copySource, assets)}</p>
            <InputField
              label="副本名称"
              value={copyName}
              onChange={(event) => setCopyName(event.target.value)}
              disabled={copyBusy}
              error={
                !copyName.trim() || [...copyName.trim()].length > 80
                  ? '名称须为 1～80 个字符。'
                  : undefined
              }
            />
            <fieldset className="stack-sm">
              <legend>教学材料</legend>
              <label className="check">
                <input
                  type="radio"
                  name="copy-materials"
                  checked={copyMaterials === 'keep'}
                  disabled={copyBusy}
                  onChange={() => setCopyMaterials('keep')}
                />
                沿用原内容
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="copy-materials"
                  checked={copyMaterials === 'replace'}
                  disabled={copyBusy}
                  onChange={() => setCopyMaterials('replace')}
                />
                替换材料
              </label>
            </fieldset>
            <Notice>
              {copyMaterials === 'keep'
                ? '副本保留原内容、手动设置、锁定与可复用声音，可独立编辑。'
                : '先保存独立副本，再进入材料校对；确认替换前会列出保留与重置范围。'}
            </Notice>
            {error && (
              <Notice tone="error" role="alert">
                {error}
              </Notice>
            )}
          </div>
        )}
      </Modal>
      <LessonExportDialog
        open={!!packageExportSource}
        initialKind="package"
        assets={assets}
        getCurrent={async () => {
          if (!packageExportSource) throw new Error('请重新选择课件。');
          return structuredClone(packageExportSource);
        }}
        onClose={() => setPackageExportSource(null)}
      />
      {taskClassroom &&
        taskView &&
        TaskClassroomView &&
        createPortal(
          <TaskClassroomView
            lesson={taskView.lesson}
            assets={taskView.assets}
            resolveAsset={readAssetData}
            onExit={() => setTaskClassroom(false)}
            exitLabel="返回成果"
          />,
          document.body,
        )}
    </div>
  );
}
