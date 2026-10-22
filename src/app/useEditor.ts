/** 串行自动保存与会话撤销。保存回包只推进修订，不用旧快照覆盖正在编辑的内容。 @author ahui */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { saveLesson } from '../platform/repository';
import { desktopAvailable } from '../platform/repository';
import * as native from '../platform/native';
import { refreshAudioDependencies } from '../games/word-beat/rules';
import type { WordBeatLesson } from '../games/word-beat/model';
import { errorMessage } from '../shared/ui';

/** 草稿中的关闭/失效声音仍需保留，不能仅使用课堂启用素材清单保护撤销。 */
function referencedAssets(documents: WordBeatLesson[]): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'assetId' && typeof child === 'string' && child) ids.add(child);
      else if (typeof child === 'object') walk(child);
    }
  };
  documents.forEach(walk);
  return [...ids];
}

/**
 * 管理一次编辑会话的本地草稿、最多 50 步撤销及串行保存；声音匹配在恢复后重查。
 * 保存冲突保留脏输入并停止自动重试，只有明确接受已保存版本或独立副本才能重建基线。
 * @param initial 打开会话时的完整保存版；后续父组件刷新不重置正在输入的草稿。
 * @returns 草稿、编辑与历史操作、保存状态和安全切换方法；flush 失败以拒绝返回，不丢弃输入。
 */
export function useEditor(initial: WordBeatLesson) {
  const [lesson, setLesson] = useState(initial);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState('');
  const [saveConflict, setSaveConflict] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const current = useRef(initial);
  const serverRevision = useRef(initial.revision);
  const sequence = useRef(0);
  const savedSequence = useRef(0);
  const history = useRef<WordBeatLesson[]>([]);
  const future = useRef<WordBeatLesson[]>([]);
  const pending = useRef<Promise<WordBeatLesson> | null>(null);
  // 冲突后本地修订已不再是合法写入基线，编辑和撤销都不能重新开启自动重试。
  const conflictError = useRef<unknown>(null);
  // 本地服务以UUID校验所有者，并自行添加会话命名空间。
  const ownerId = useRef(crypto.randomUUID());
  const retained = useRef<Promise<unknown>>(Promise.resolve());
  const editingField = useRef<Element | null>(null);
  const queryClient = useQueryClient();

  /** 先建立编辑会话引用再允许保存，快速输入的引用更新保持串行。 */
  const retain = useCallback(() => {
    if (!desktopAvailable) return;
    const ids = referencedAssets([current.current, ...history.current, ...future.current]);
    const lessonId = current.current.id;
    const revision = serverRevision.current;
    retained.current = retained.current
      .catch(() => undefined)
      .then(() => native.retainAssets(ownerId.current, ids, lessonId, revision));
    // 错误由flush统一呈现；这里消费拒绝，防500ms自动保存窗口内出现未处理拒绝。
    void retained.current.catch(() => undefined);
  }, []);

  const replace = useCallback(
    (document: WordBeatLesson) => {
      const next = refreshAudioDependencies(document);
      current.current = next;
      retain();
      sequence.current += 1;
      setSaveState(conflictError.current ? 'error' : 'saving');
      setLesson(next);
    },
    [retain],
  );

  const edit = useCallback(
    (
      update: WordBeatLesson | ((previous: WordBeatLesson) => WordBeatLesson),
      grouping?: 'separate',
    ) => {
      // 先计算更新，再压历史；校验失败的整批操作不得污染撤销栈。
      const next = typeof update === 'function' ? update(structuredClone(current.current)) : update;
      const active = document.activeElement;
      const isTextField =
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement &&
          !['checkbox', 'radio', 'button', 'submit'].includes(active.type));
      if (grouping === 'separate' || !isTextField || editingField.current !== active) {
        history.current.push(structuredClone(current.current));
        if (history.current.length > 50) history.current.shift();
      }
      editingField.current = grouping !== 'separate' && isTextField ? active : null;
      future.current = [];
      replace(next);
      setHistoryVersion((value) => value + 1);
    },
    [replace],
  );

  const undo = useCallback(() => {
    editingField.current = null;
    const previous = history.current.pop();
    if (!previous) return;
    future.current.push(structuredClone(current.current));
    replace({ ...previous, revision: serverRevision.current });
    setHistoryVersion((value) => value + 1);
  }, [replace]);

  const redo = useCallback(() => {
    editingField.current = null;
    const next = future.current.pop();
    if (!next) return;
    history.current.push(structuredClone(current.current));
    replace({ ...next, revision: serverRevision.current });
    setHistoryVersion((value) => value + 1);
  }, [replace]);

  /** flush 可在离开/运行前调用，等待在途保存并继续保存期间产生的新修改。 */
  const flush = useCallback((): Promise<WordBeatLesson> => {
    if (pending.current) return pending.current;
    if (conflictError.current) return Promise.reject(conflictError.current);
    // 显式重试须重新建立引用，不能一直等待上次已拒绝的 promise。
    retain();
    const drain = async (): Promise<WordBeatLesson> => {
      try {
        const awaitRetention = async () => {
          let latest: Promise<unknown>;
          do {
            latest = retained.current;
            await latest;
          } while (latest !== retained.current);
        };
        await awaitRetention();
        while (savedSequence.current !== sequence.current) {
          // 等到最新引用稳定后再同步取得快照，覆盖等待期间发生的编辑。
          await awaitRetention();
          const snapshot = structuredClone(current.current);
          const snapshotSequence = sequence.current;
          snapshot.revision = serverRevision.current;
          setSaveState('saving');
          setSaveError('');
          const saved = await saveLesson(snapshot, serverRevision.current);
          serverRevision.current = saved.revision;
          savedSequence.current = snapshotSequence;
          current.current = {
            ...current.current,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
            // 已准备指针由仓库头维护，不能沿用较早草稿带回的旧指针。
            preparedRevision: saved.preparedRevision,
          };
          setLesson(current.current);
          void queryClient.invalidateQueries({ queryKey: ['lessons'] });
        }
        setSaveState('saved');
        setSaveError('');
        return structuredClone(current.current);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'REVISION_CONFLICT'
        ) {
          conflictError.current = error;
          setSaveConflict(true);
        }
        setSaveState('error');
        setSaveError(errorMessage(error));
        throw error;
      }
    };
    // 整个排空过程共用同一 promise，自动保存、Ctrl+S 和离开不能并发提交相同修订。
    const operation = drain().finally(() => {
      pending.current = null;
    });
    pending.current = operation;
    return operation;
  }, [queryClient, retain]);

  /**
   * 只在教师确认重载或独立副本确实保存成功后切换基线；不能只抬高旧草稿修订号。
   * expected 是发起读取/另存前的本地快照，异步期间若仍有编辑则拒绝替换，保留新输入。
   * 清掉旧撤销栈，避免恢复旧对象身份或绕过新的并发检查。
   * @param document 已成功读取或落盘的完整版本，修订号与对象身份来自仓库实际结果。
   * @param expected 异步操作开始时捕获的本地草稿，必须仍与会话当前内容完全相同。
   * @throws Error 保存仍在进行或当前输入已变化时拒绝切换；原内容和未保存状态保留。
   */
  const replaceWithSaved = useCallback(
    (document: WordBeatLesson, expected: WordBeatLesson) => {
      if (pending.current || JSON.stringify(current.current) !== JSON.stringify(expected))
        throw new Error('处理期间本地内容已变化，当前输入已保留，请重新查看后操作。');
      current.current = structuredClone(document);
      serverRevision.current = document.revision;
      sequence.current += 1;
      savedSequence.current = sequence.current;
      history.current = [];
      future.current = [];
      editingField.current = null;
      conflictError.current = null;
      setSaveConflict(false);
      setSaveState('saved');
      setSaveError('');
      setLesson(current.current);
      setHistoryVersion((value) => value + 1);
      retain();
      void queryClient.invalidateQueries({ queryKey: ['lessons'] });
    },
    [queryClient, retain],
  );

  useEffect(() => {
    retain();
    const owner = ownerId.current;
    return () => {
      if (desktopAvailable)
        void retained.current
          .catch(() => undefined)
          .then(() => native.releaseAssets(owner))
          .catch(() => undefined);
    };
  }, [retain]);

  useEffect(() => {
    const finishField = () => {
      editingField.current = null;
    };
    const finishOnEnter = (event: KeyboardEvent) => {
      // 多行 Enter 只是换行，输入法确认及调用方已接管的按键也不拆开本次连续编辑。
      if (
        event.key === 'Enter' &&
        !event.isComposing &&
        !event.defaultPrevented &&
        event.target instanceof HTMLInputElement
      )
        finishField();
    };
    document.addEventListener('focusout', finishField);
    document.addEventListener('keydown', finishOnEnter);
    return () => {
      document.removeEventListener('focusout', finishField);
      document.removeEventListener('keydown', finishOnEnter);
    };
  }, []);

  useEffect(() => {
    if (sequence.current === savedSequence.current || saveConflict) return;
    const timer = setTimeout(() => {
      void flush().catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [lesson, flush, saveConflict]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (sequence.current !== savedSequence.current || pending.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, []);

  /**
   * 接收实际检查完成的修订，只更新本课准备指针；后台任务可能晚于另存副本或更新检查返回。
   * @param revision 已检查通过的正整数保存修订，不得晚于本会话保存基线或倒退已有准备指针。
   * @param lessonId 完成检查的课件身份，必须与当前编辑对象相同，不能沿用另存前的任务结果。
   */
  const acceptPrepared = useCallback((revision: number, lessonId: string) => {
    if (
      lessonId !== current.current.id ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > serverRevision.current ||
      revision < (current.current.preparedRevision ?? 0)
    )
      return;
    // 准备完成不替换教师的新输入、不结束连续编辑，也不把未保存内容标成已保存。
    current.current = { ...current.current, preparedRevision: revision };
    setLesson(current.current);
  }, []);

  return {
    lesson,
    edit,
    undo,
    redo,
    canUndo: history.current.length > 0,
    canRedo: future.current.length > 0,
    flush,
    saveState,
    saveError,
    saveConflict,
    replaceWithSaved,
    acceptPrepared,
  };
}
