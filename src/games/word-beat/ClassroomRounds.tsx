/**
 * 课堂词语管理与练习安排：选词、搜索、增删排序及逐词／范围草稿共用提交边界。
 * 所有修改只交给父级草稿，底部完成设置才保存与安装，不由组件重启课堂。
 * @author ahui
 */
import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  MagnifyingGlass,
  Plus,
  Trash,
  ArrowCounterClockwise,
} from '@phosphor-icons/react';
import type { AssetMap } from '../../platform/types';
import type { WordBeatEntry, WordBeatLesson } from './model';
import { createWordBeatEntry, getEntries, getEntryTiming } from './rules';
import { HelpTip } from '../../shared/ui/HelpTip';
import { WORD_BEAT_HELP } from './settingHelp';
import { ClassroomRhythmFields, ClassroomRhythmRange } from './ClassroomRhythm';
import { ClassroomWords } from './ClassroomWords';
import { classroomWordError } from './classroom-words';
import {
  getClassroomChorus,
  previewClassroomRhythm,
  type ClassroomRhythmBulk,
  type ClassroomRhythmDraft,
} from './classroom-rhythm';

/** 原始输入有效才可提交；空白、小数和越界不能静默夹取。 */
export function validClassroomRounds(raw: string): boolean {
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 8;
}

/** 范围与原始目标由父级保留，收起／重开不丢失；null或缺失表示未修改该项。 */
export interface ClassroomBulkDraft {
  raw: string;
  scope: string;
  dirty: boolean;
  error?: string;
  /** 教师明确选择时才覆盖手动值；锁定值始终保留。 */
  includeManual?: boolean;
  modelBeats?: string | null;
  follow?: string | null;
}

/** 创建实际范围的共同轮数，不把混合值伪装为默认一轮。 */
export function createClassroomBulkDraft(
  lesson: WordBeatLesson,
  scope = 'all',
): ClassroomBulkDraft {
  const scoped = getEntries(lesson).filter(
    (item) => scope === 'all' || item.priority === (scope === 'priority'),
  );
  const common = scoped[0]?.rounds.value;
  const uniform = common !== undefined && scoped.every((item) => item.rounds.value === common);
  return { raw: uniform ? String(common) : '', scope, dirty: false };
}

/** 单个字段未完成的原始输入；缺失field兼容原有轮数草稿。 */
export interface ClassroomRoundDraft {
  id: string;
  raw: string;
  error?: string;
  field?: 'rounds' | 'modelBeats' | 'follow';
}

/** 范围预览与最终提交使用相同保护，不能把手动跳过项说成已经统一。 */
export function getClassroomBulkSelection(lesson: WordBeatLesson, draft: ClassroomBulkDraft) {
  const scoped = getEntries(lesson).filter(
    (item) => draft.scope === 'all' || item.priority === (draft.scope === 'priority'),
  );
  const eligible = scoped.filter(
    (item) => !item.rounds.locked && (draft.includeManual || item.rounds.source !== 'manual'),
  );
  return {
    scoped,
    eligible,
    changed: eligible.filter((item) => item.rounds.value !== Number(draft.raw)),
  };
}

/**
 * 非齐读范围拍数候选，与逐词相同的1～32拍边界。示范仅文字领读可调；
 * 配音示范由真实录音决定，不能把一个数值设置伪装成录音变速。
 */
export function previewClassroomFollow(lesson: WordBeatLesson, draft: ClassroomBulkDraft) {
  const next = structuredClone(lesson);
  let error = '';
  let changed = 0;
  let protectedFields = 0;
  if (lesson.gameData.soundMode === 'chorus')
    return { lesson: next, error, changed, protectedFields };
  // 先检查原输入，避免0词范围或后续删词使非法目标在遍历中被跳过。
  for (const field of ['modelBeats', 'follow'] as const) {
    const raw = draft[field];
    if (raw == null || (field === 'modelBeats' && lesson.gameData.soundMode !== 'teacher'))
      continue;
    if (!validBeats(raw)) {
      error = `${field === 'modelBeats' ? '统一教师示范' : '统一学生跟读'}拍数需为 1～32 的整数。`;
      return { lesson: next, error, changed, protectedFields };
    }
  }
  for (const entry of getEntries(next)) {
    if (draft.scope !== 'all' && entry.priority !== (draft.scope === 'priority')) continue;
    let entryChanged = false;
    for (const field of ['modelBeats', 'follow'] as const) {
      const raw = draft[field];
      if (
        raw === null ||
        raw === undefined ||
        (field === 'modelBeats' && lesson.gameData.soundMode !== 'teacher')
      )
        continue;
      const value = Number(raw);
      const manual =
        field === 'modelBeats'
          ? entry.modelBeats.source === 'manual'
          : entry.follow.mode === 'manual';
      if (entry[field].locked || (manual && !draft.includeManual)) {
        protectedFields += 1;
        continue;
      }
      if (field === 'modelBeats') {
        if (entry.modelBeats.value !== value) {
          entry.modelBeats = { ...entry.modelBeats, value, source: 'manual' };
          entryChanged = true;
        }
      } else if (entry.follow.beats !== value || entry.follow.mode !== 'manual') {
        entry.follow = { ...entry.follow, beats: value, mode: 'manual' };
        entryChanged = true;
      }
    }
    if (entryChanged) changed += 1;
  }
  return { lesson: next, error, changed, protectedFields };
}

/** 1～32拍的原输入检查；与正式编排边界一致。 */
function validBeats(raw: string): boolean {
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 32;
}

/**
 * 只撤销最近的增删／顺序，不撤回操作后已修改的文字、轮数、拍数或课堂偏好。
 * 仍存在的ID从当前草稿取值；删除的条目才从操作前快照找回。
 */
export function undoClassroomWordStructure(
  current: WordBeatLesson,
  before: WordBeatLesson,
): WordBeatLesson {
  const next = structuredClone(current);
  const currentEntries = new Map(getEntries(current).map((item) => [item.id, item]));
  next.gameData.segments = before.gameData.segments.map((group) => ({
    ...structuredClone(group),
    entries: group.entries.map((item) => structuredClone(currentEntries.get(item.id) ?? item)),
  }));
  return next;
}

/**
 * 左侧找词、中央编辑、右侧统一安排。结构操作可撤销一次；原课件及音频均不修改。
 * 非法文字保留在对应词中；数值半输入存于父级单项草稿，修复前不切换到别词覆盖它。
 */
export function ClassroomRounds({
  lesson,
  previewLesson,
  savedLesson,
  durationMs,
  pending,
  started,
  activeEntryId,
  onApply,
  draft,
  onDraft,
  undo,
  onUndo,
  bulkDraft,
  onBulkDraft,
  rhythmDraft,
  onRhythmDraft,
  rhythmBulk,
  onRhythmBulk,
  rhythmUndo,
  onRhythmUndo,
  assets = {},
  originalLesson,
}: {
  lesson: WordBeatLesson;
  /** 原HTML课件的固定身份基准；最近完成的本地新增词仍不是原词。 */
  originalLesson: WordBeatLesson;
  savedLesson: WordBeatLesson;
  previewLesson: WordBeatLesson;
  durationMs: number | null;
  pending: boolean;
  started: boolean;
  activeEntryId?: string;
  onApply: (lesson: WordBeatLesson) => void;
  draft: ClassroomRoundDraft | null;
  onDraft: (draft: ClassroomRoundDraft | null) => void;
  undo: Map<string, WordBeatEntry['rounds']> | null;
  onUndo: (value: Map<string, WordBeatEntry['rounds']> | null) => void;
  bulkDraft: ClassroomBulkDraft;
  onBulkDraft: (value: ClassroomBulkDraft) => void;
  rhythmDraft: ClassroomRhythmDraft | null;
  onRhythmDraft: (value: ClassroomRhythmDraft | null) => void;
  rhythmBulk: ClassroomRhythmBulk;
  onRhythmBulk: (value: ClassroomRhythmBulk) => void;
  rhythmUndo: Map<string, ReturnType<typeof getClassroomChorus>> | null;
  onRhythmUndo: (value: Map<string, ReturnType<typeof getClassroomChorus>> | null) => void;
  assets?: AssetMap;
}) {
  const entries = getEntries(lesson);
  const previewEntries = getEntries(previewLesson);
  const [selected, setSelected] = useState(activeEntryId ?? entries[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [managerUndo, setManagerUndo] = useState<WordBeatLesson | null>(null);
  const entry =
    entries.find((item) => item.id === (draft?.id ?? rhythmDraft?.id ?? selected)) ?? entries[0];
  const previewEntry = previewEntries.find((item) => item.id === entry?.id) ?? entry;
  const chorusMode = lesson.gameData.soundMode === 'chorus';
  const invalidRound = draft && (!draft.field || draft.field === 'rounds') ? draft.raw : null;
  const hasUnfinishedNumber = !!draft || !!rhythmDraft;
  const { scope } = bulkDraft;
  const bulk = bulkDraft.dirty ? bulkDraft.raw : createClassroomBulkDraft(lesson, scope).raw;
  const mixedPriorities =
    entries.some((item) => item.priority) && entries.some((item) => !item.priority);
  const { scoped, eligible, changed } = getClassroomBulkSelection(lesson, bulkDraft);
  const followPreview = previewClassroomFollow(lesson, bulkDraft);
  const filtered = entries.filter((item) =>
    `${item.english} ${item.meaning}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const segment = lesson.gameData.segments.find((item) =>
    item.entries.some((word) => word.id === entry?.id),
  );
  const segmentIndex = segment?.entries.findIndex((item) => item.id === entry?.id) ?? -1;
  // 原位置锁是绝对组内索引；删除锁定词之前的词也会移动其位置，故提前禁用。
  const canDelete =
    !!entry &&
    !!segment &&
    !entry.positionLocked &&
    !segment.entries.slice(segmentIndex + 1).some((item) => item.positionLocked);
  const canMove = (direction: -1 | 1) =>
    !!entry &&
    !!segment &&
    !entry.positionLocked &&
    !!segment.entries[segmentIndex + direction] &&
    !segment.entries[segmentIndex + direction].positionLocked;
  const wordError = entries.find((item) => classroomWordError(item.english, item.meaning));
  const timing = entry ? getEntryTiming(previewLesson, previewEntry, assets) : null;
  const values = previewEntries.map((item) => item.rounds.value);
  const structureChanged = savedLesson.gameData.segments.some((group, index) => {
    const current = lesson.gameData.segments[index];
    return (
      !current ||
      group.entries.length !== current.entries.length ||
      group.entries.some((item, position) => item.id !== current.entries[position]?.id)
    );
  });
  const selectWord = (id: string) => {
    setSelected(id);
  };
  const bulkPending =
    bulkDraft.dirty ||
    bulkDraft.modelBeats != null ||
    bulkDraft.follow != null ||
    rhythmBulk.beats !== null ||
    rhythmBulk.beatsPerRead !== null;
  const validBulk =
    (!bulkDraft.dirty || validClassroomRounds(bulkDraft.raw)) &&
    !followPreview.error &&
    !previewClassroomRhythm(lesson, rhythmBulk, scope).error;
  // 结构操作不能将非法范围字段变成单词课的隐藏项，必须先修正原始输入。
  const structureBlocked = hasUnfinishedNumber || !validBulk;
  // 逐词后改必须赢过先前批量意图。只把合法的批量候选移入草稿；
  // 非法输入继续留在原字段，不能用旧值静默替代它而放行完成。
  const editingLesson = bulkPending && validBulk ? previewLesson : lesson;
  const settleBulk = (next: WordBeatLesson) => {
    if (!bulkPending || !validBulk) return;
    onBulkDraft({
      ...createClassroomBulkDraft(next, scope),
      includeManual: bulkDraft.includeManual,
    });
    onRhythmBulk({ beats: null, beatsPerRead: null, includeManual: rhythmBulk.includeManual });
  };
  const updateEntry = (change: (item: WordBeatEntry) => void) => {
    if (!entry) return;
    const next = structuredClone(editingLesson);
    change(getEntries(next).find((item) => item.id === entry.id)!);
    onApply(next);
    settleBulk(next);
    setSelected(entry.id);
  };
  const applyRounds = (values: Map<string, WordBeatEntry['rounds']>) => {
    const next = structuredClone(editingLesson);
    const before = new Map(entries.map((item) => [item.id, { ...item.rounds }]));
    for (const item of getEntries(next)) {
      const value = values.get(item.id);
      if (value) item.rounds = { ...value };
    }
    try {
      onApply(next);
      settleBulk(next);
      onUndo(before);
      return '';
    } catch (failure) {
      return failure instanceof Error ? failure.message : '当前安排无法应用，请恢复或修正输入。';
    }
  };
  const editNumber = (field: 'rounds' | 'modelBeats' | 'follow', raw: string) => {
    if (!entry) return;
    if (!(field === 'rounds' ? validClassroomRounds(raw) : validBeats(raw))) {
      onDraft({
        id: entry.id,
        field,
        raw,
        error: `${field === 'rounds' ? '轮数需为 1～8' : '拍数需为 1～32'} 的整数。`,
      });
      return;
    }
    if (field === 'rounds') {
      const error = applyRounds(
        new Map([[entry.id, { ...entry.rounds, value: Number(raw), source: 'manual' }]]),
      );
      if (error) {
        onDraft({ id: entry.id, field, raw, error });
        return;
      }
    } else
      updateEntry((item) => {
        if (field === 'modelBeats')
          item.modelBeats = { ...item.modelBeats, value: Number(raw), source: 'manual' };
        else item.follow = { ...item.follow, beats: Number(raw), mode: 'manual' };
      });
    onDraft(null);
  };
  const structuralChange = (next: WordBeatLesson, nextId?: string) => {
    setManagerUndo(structuredClone(editingLesson));
    onApply(next);
    settleBulk(next);
    onDraft(null);
    onRhythmDraft(null);
    setSelected(nextId ?? getEntries(next)[0]?.id ?? '');
    setQuery('');
  };
  const addWord = () => {
    if (entries.length >= 100 || structureBlocked) return;
    const next = structuredClone(editingLesson);
    const group =
      next.gameData.segments.find((item) => item.id === segment?.id) ?? next.gameData.segments[0];
    if (!group) return;
    const added = createWordBeatEntry(
      { id: '', english: '', meaning: '', priority: false, entryType: 'word' },
      lesson.gameData.preset,
    );
    added.entryTypeSource = 'manual';
    added.chorus = getClassroomChorus(added);
    group.entries.push(added);
    structuralChange(next, added.id);
  };
  const deleteWord = () => {
    if (!canDelete || !entry || !segment || structureBlocked) return;
    const next = structuredClone(editingLesson);
    next.gameData.segments.find((item) => item.id === segment.id)!.entries.splice(segmentIndex, 1);
    structuralChange(
      next,
      getEntries(next)[
        Math.min(
          entries.findIndex((item) => item.id === entry.id),
          entries.length - 2,
        )
      ]?.id,
    );
  };
  const moveWord = (direction: -1 | 1) => {
    if (!canMove(direction) || !entry || !segment || structureBlocked) return;
    const next = structuredClone(editingLesson);
    const group = next.gameData.segments.find((item) => item.id === segment.id)!;
    [group.entries[segmentIndex], group.entries[segmentIndex + direction]] = [
      group.entries[segmentIndex + direction],
      group.entries[segmentIndex],
    ];
    structuralChange(next, entry.id);
  };
  const selectedSummary = (item: WordBeatEntry) => {
    const rhythm = getClassroomChorus(item);
    return `${item.rounds.value}轮${chorusMode ? ` · ${rhythm.beats.value}拍 · 读${rhythm.beats.value / rhythm.beatsPerRead.value}次` : ''}`;
  };
  const includeManual = !!bulkDraft.includeManual || !!rhythmBulk.includeManual;
  const setIncludeManual = (value: boolean) => {
    onBulkDraft({ ...bulkDraft, includeManual: value });
    onRhythmBulk({ ...rhythmBulk, includeManual: value });
  };
  const commonFollow = (field: 'modelBeats' | 'follow') => {
    const numbers = scoped.map((item) => {
      const actual = getEntryTiming(lesson, item, assets);
      return field === 'modelBeats' ? actual.modelBeats : actual.followBeats;
    });
    return numbers.length &&
      Number.isFinite(numbers[0]) &&
      numbers.every((value) => value === numbers[0])
      ? String(numbers[0])
      : '';
  };
  return (
    <section
      id="classroom-settings-rounds"
      tabIndex={-1}
      className="ecg-settings-section ecg-settings-rounds"
    >
      <div className="setting-label">
        <h3>词语与练习安排</h3>
        <HelpTip label="每词练习轮数">{WORD_BEAT_HELP.rounds}</HelpTip>
      </div>
      <p className="ecg-rounds-summary">
        {entries.length} 个词语
        {values.length > 0
          ? ` · ${Math.min(...values) === Math.max(...values) ? `每词 ${values[0]} 轮` : `各词 ${Math.min(...values)}～${Math.max(...values)} 轮`}`
          : ''}{' '}
        ·{' '}
        {durationMs === null
          ? '参数待修正，暂不能计算新编排时长'
          : `预计编排 ${(durationMs / 1000).toFixed(1)} 秒（不含教师等待）`}
      </p>
      <p>
        {started
          ? structureChanged
            ? '词表已调整：完成后返回开始页，按新词表从头开始。'
            : pending
              ? '待生效：下一词或重玩使用新安排；当前词与重读保持原安排。'
              : '课中修改从下一词或重玩生效，不打断当前词。'
          : '调整后点底部完成设置，一起保存到当前浏览器。'}
      </p>
      <div className="ecg-word-manager" data-single={entries.length <= 1}>
        <aside className="ecg-word-manager-list">
          <div className="ecg-word-manager-toolbar">
            <h4>课堂词表</h4>
            <button
              type="button"
              onClick={addWord}
              disabled={entries.length >= 100 || structureBlocked}
            >
              <Plus size={16} aria-hidden="true" />
              新增词语
            </button>
          </div>
          {entries.length > 1 && (
            <>
              <label className="ecg-word-search">
                <span>
                  <MagnifyingGlass size={16} aria-hidden="true" />
                  搜索词语
                </span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="英文或释义"
                />
              </label>
              <div
                className="ecg-word-list"
                role="listbox"
                aria-label="选择要调整的词"
                onKeyDown={(event) => {
                  if (
                    !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
                    hasUnfinishedNumber ||
                    !filtered.length
                  )
                    return;
                  event.preventDefault();
                  const current = filtered.findIndex((item) => item.id === entry?.id);
                  const index =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? filtered.length - 1
                        : Math.max(
                            0,
                            Math.min(
                              filtered.length - 1,
                              current + (event.key === 'ArrowDown' ? 1 : -1),
                            ),
                          );
                  selectWord(filtered[index].id);
                  Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-entry-id]'),
                  )
                    .find((button) => button.dataset.entryId === filtered[index].id)
                    ?.focus();
                }}
              >
                {filtered.map((item) => {
                  const visible = previewEntries.find((word) => word.id === item.id) ?? item;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      data-entry-id={item.id}
                      aria-selected={item.id === entry?.id}
                      disabled={hasUnfinishedNumber && item.id !== entry?.id}
                      onClick={() => selectWord(item.id)}
                    >
                      <span className="ecg-word-list-name">
                        <span>{entries.indexOf(item) + 1}.</span>
                        <strong>{item.english || '待输入英文'}</strong>
                        {classroomWordError(item.english, item.meaning) && <em>待修正</em>}
                      </span>
                      <small>
                        {selectedSummary(visible)}
                        {item.priority ? ' · 重点' : ''}
                        {item.positionLocked ? ' · 位置锁定' : ''}
                      </small>
                    </button>
                  );
                })}
              </div>
              {!filtered.length && (
                <div className="ecg-word-manager-empty">
                  <p>没有匹配的词语。</p>
                  <button type="button" onClick={() => setQuery('')}>
                    清空搜索
                  </button>
                </div>
              )}
              <p>
                显示 {filtered.length} / {entries.length} 词
              </p>
            </>
          )}
          {entries.length <= 1 && (
            <p>
              {entry
                ? '当前只有一个词，直接在右侧调整；需要更多词可新增。'
                : '词表已空，请新增词语或撤销删除后再完成设置。'}
            </p>
          )}
          {managerUndo && (
            <button
              type="button"
              disabled={structureBlocked}
              onClick={() => {
                const previous = undoClassroomWordStructure(editingLesson, managerUndo);
                setManagerUndo(null);
                onApply(previous);
                settleBulk(previous);
                onDraft(null);
                onRhythmDraft(null);
                setSelected(getEntries(previous)[0]?.id ?? '');
                setQuery('');
              }}
            >
              <ArrowCounterClockwise size={16} aria-hidden="true" />
              撤销上次词表操作
            </button>
          )}
          {hasUnfinishedNumber && (
            <p className="ecg-volume-error">请先修正或恢复当前数值，再切换词语。</p>
          )}
          {!validBulk && (
            <p className="ecg-volume-error">请先修正右侧统一设置，再增删、排序或撤销词表。</p>
          )}
        </aside>
        {entry && (
          <div className="ecg-word-manager-main">
            <div className="ecg-word-editor-heading">
              <div>
                <h4>{entry.english || '新增词语'}</h4>
                <p>
                  {lesson.gameData.segments.filter((item) => item.entries.length).length > 1
                    ? `${segment?.name} · 第 ${segmentIndex + 1} 词`
                    : `第 ${entries.findIndex((item) => item.id === entry.id) + 1} 词 / 共 ${entries.length} 词`}
                </p>
              </div>
              <div className="ecg-word-actions">
                <button
                  type="button"
                  aria-label="上移当前词"
                  title="在当前组内向前移动一位；位置锁定时不可移动"
                  disabled={!canMove(-1) || structureBlocked}
                  onClick={() => moveWord(-1)}
                >
                  <ArrowUp size={17} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="下移当前词"
                  title="在当前组内向后移动一位；位置锁定时不可移动"
                  disabled={!canMove(1) || structureBlocked}
                  onClick={() => moveWord(1)}
                >
                  <ArrowDown size={17} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="删除当前词"
                  title="从本课课堂词表删除，可撤销；不删除原课件或声音素材"
                  disabled={!canDelete || structureBlocked}
                  onClick={deleteWord}
                >
                  <Trash size={17} aria-hidden="true" />
                </button>
              </div>
            </div>
            {!canDelete && <p>当前词或后续词位置已锁定，不能移动其位置；请回编辑器解锁。</p>}
            <ClassroomWords
              entry={entry}
              savedEntry={getEntries(savedLesson).find((item) => item.id === entry.id)}
              lesson={lesson}
              onChange={(english, meaning) =>
                updateEntry((item) => {
                  Object.assign(item, { english, meaning });
                  if (item.meaningSource && meaning !== entry.meaning)
                    item.meaningSource = { ...item.meaningSource, teacherRevised: true };
                })
              }
              onRestore={() => {
                const saved = getEntries(savedLesson).find((item) => item.id === entry.id);
                if (saved)
                  updateEntry((item) =>
                    Object.assign(item, {
                      english: saved.english,
                      meaning: saved.meaning,
                      meaningSource: saved.meaningSource
                        ? structuredClone(saved.meaningSource)
                        : undefined,
                    }),
                  );
              }}
            />
            <div className="ecg-word-detail-fields">
              <label>
                词语类型
                <select
                  value={entry.entryType}
                  onChange={(event) =>
                    updateEntry((item) => {
                      item.entryType = event.target.value as 'word' | 'phrase';
                      item.entryTypeSource = 'manual';
                      // 本地新增的身份以原HTML为准，保存后再换类型仍使用同一重建规则。
                      // 英文置空以免工厂的材料词型推断覆盖教师明确类型；手动值继续保留。
                      if (!getEntries(originalLesson).some((saved) => saved.id === item.id)) {
                        const defaults = createWordBeatEntry(
                          { ...item, english: '', entryType: item.entryType },
                          lesson.gameData.preset,
                          () => item.id,
                        );
                        if (item.modelBeats.source === 'preset')
                          item.modelBeats = defaults.modelBeats;
                        if (item.follow.mode === 'preset') item.follow = defaults.follow;
                      }
                    })
                  }
                >
                  <option value="word">单词</option>
                  <option value="phrase">短语</option>
                </select>
              </label>
              <label className="ecg-checkbox">
                <input
                  type="checkbox"
                  checked={entry.priority}
                  onChange={(event) =>
                    updateEntry((item) => {
                      item.priority = event.target.checked;
                    })
                  }
                />
                重点词
              </label>
              <label>
                当前词轮数
                <input
                  id="classroom-rounds-input"
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  disabled={entry.rounds.locked}
                  value={invalidRound ?? previewEntry.rounds.value}
                  aria-invalid={invalidRound !== null}
                  aria-describedby="rounds-input-feedback"
                  onChange={(event) => editNumber('rounds', event.target.value)}
                />
              </label>
            </div>
            <p
              id="rounds-input-feedback"
              className={invalidRound !== null ? 'ecg-volume-error' : undefined}
            >
              {entry.rounds.locked
                ? '此词轮数已锁定，请回编辑器解锁。'
                : invalidRound !== null
                  ? draft?.error || '请输入 1～8 的整数；修正或恢复当前值后再继续。'
                  : '逐词修改记为手动值，统一调整时默认保留。'}
            </p>
            {draft && (
              <button type="button" onClick={() => onDraft(null)}>
                {draft.field === 'modelBeats' || draft.field === 'follow'
                  ? '恢复当前词示范或跟读拍数'
                  : '恢复当前词轮数'}
              </button>
            )}
            {chorusMode ? (
              <ClassroomRhythmFields
                entry={entry}
                previewEntry={previewEntry}
                draft={rhythmDraft}
                onDraft={onRhythmDraft}
                onChange={(chorus) => {
                  onRhythmUndo(
                    new Map(
                      entries.map((item) => [item.id, structuredClone(getClassroomChorus(item))]),
                    ),
                  );
                  updateEntry((item) => {
                    item.chorus = chorus;
                  });
                }}
              />
            ) : (
              <div className="ecg-rhythm-fields">
                {lesson.gameData.soundMode === 'teacher' ? (
                  <label>
                    教师示范拍数
                    <input
                      id="classroom-model-beats-input"
                      type="number"
                      min={1}
                      max={32}
                      step={1}
                      value={
                        draft?.field === 'modelBeats' ? draft.raw : previewEntry.modelBeats.value
                      }
                      disabled={entry.modelBeats.locked}
                      aria-invalid={draft?.field === 'modelBeats'}
                      onChange={(event) => editNumber('modelBeats', event.target.value)}
                    />
                  </label>
                ) : (
                  <div>
                    <strong>配音示范</strong>
                    <p>
                      {timing && Number.isFinite(timing.modelBeats)
                        ? `${timing.modelBeats} 拍（按实际录音计算）`
                        : '由词语配音决定，缺失配音需先处理'}
                    </p>
                  </div>
                )}
                <label>
                  学生跟读拍数
                  <input
                    id="classroom-follow-beats-input"
                    type="number"
                    min={1}
                    max={32}
                    step={1}
                    value={
                      draft?.field === 'follow'
                        ? draft.raw
                        : timing && Number.isFinite(timing.followBeats)
                          ? timing.followBeats
                          : ''
                    }
                    placeholder="声音待准备"
                    disabled={entry.follow.locked}
                    aria-invalid={draft?.field === 'follow'}
                    onChange={(event) => editNumber('follow', event.target.value)}
                  />
                </label>
                <p>
                  {draft?.field === 'modelBeats' || draft?.field === 'follow'
                    ? draft.error
                    : '输入固定拍数用于本词；未修改的跟读拍数继续沿用原有预设公式。'}
                </p>
              </div>
            )}
            <p className="ecg-rounds-example">
              {entry.english || '当前词'}：
              {chorusMode
                ? durationMs === null
                  ? '参数待修正，当前草稿未形成可用编排。'
                  : (() => {
                      const rhythm = getClassroomChorus(previewEntry);
                      return rhythm.beats.value % rhythm.beatsPerRead.value === 0
                        ? `每轮 ${rhythm.beats.value} 拍 · 读 ${rhythm.beats.value / rhythm.beatsPerRead.value} 次 · 每次 ${rhythm.beatsPerRead.value} 拍 · 共 ${previewEntry.rounds.value} 轮（合计提示 ${(rhythm.beats.value / rhythm.beatsPerRead.value) * previewEntry.rounds.value} 次）`
                        : '当前组合不能整除，请修正后查看朗读次数。';
                    })()
                : `示范 → 跟读，重复 ${previewEntry.rounds.value} 轮。`}
            </p>
            {wordError && wordError.id !== entry.id && (
              <button
                type="button"
                onClick={() => {
                  setSelected(wordError.id);
                  setQuery('');
                }}
              >
                定位待修正词：{wordError.english || '未输入英文'}
              </button>
            )}
          </div>
        )}
        {entries.length > 1 && (
          <aside className="ecg-word-manager-range">
            <h4>按范围统一</h4>
            {mixedPriorities || scope !== 'all' ? (
              <label>
                统一调整范围
                <select
                  value={scope}
                  onChange={(event) =>
                    onBulkDraft({ ...bulkDraft, scope: event.target.value, error: undefined })
                  }
                >
                  <option value="all">全部词语</option>
                  <option value="normal">
                    仅普通词（{entries.filter((item) => !item.priority).length}词）
                  </option>
                  <option value="priority">
                    仅重点词（{entries.filter((item) => item.priority).length}词）
                  </option>
                </select>
              </label>
            ) : (
              <strong className="ecg-rounds-single-word">全部词语</strong>
            )}
            {!scoped.length && (
              <p className="ecg-volume-error">
                当前范围没有词语，请重新选择调整范围；不会自动扩大到全部词语。
              </p>
            )}
            <label className="ecg-checkbox">
              <input
                type="checkbox"
                checked={includeManual}
                onChange={(event) => setIncludeManual(event.target.checked)}
              />
              同时调整手动值（保留锁定）
            </label>
            <label>
              统一轮数
              <input
                id="classroom-bulk-input"
                type="number"
                min={1}
                max={8}
                step={1}
                value={bulk}
                aria-invalid={bulkDraft.dirty && !validClassroomRounds(bulk)}
                aria-describedby="rounds-bulk-feedback"
                placeholder="各词不同，输入统一轮数"
                onChange={(event) =>
                  onBulkDraft({
                    ...bulkDraft,
                    raw: event.target.value,
                    dirty: true,
                    error: undefined,
                  })
                }
              />
            </label>
            <p
              id="rounds-bulk-feedback"
              className={
                bulkDraft.dirty && !validClassroomRounds(bulk) ? 'ecg-volume-error' : undefined
              }
            >
              {!bulkDraft.dirty
                ? `${bulk ? `当前范围每词 ${bulk} 轮` : '当前范围各词轮数不同'}；编辑后才统一调整，${includeManual ? '仅保留锁定值' : '保留手动和锁定值'}。`
                : validClassroomRounds(bulk)
                  ? `完成时统一调整：将调整 ${changed.length} 词；保留 ${scoped.length - eligible.length} 个手动或锁定值。`
                  : '请输入 1～8 的整数，尚未应用。'}
            </p>
            {chorusMode ? (
              <ClassroomRhythmRange
                lesson={lesson}
                scope={scope}
                draft={rhythmBulk}
                onChange={(value) => {
                  onRhythmBulk(value);
                  if (!!value.includeManual !== !!bulkDraft.includeManual)
                    onBulkDraft({ ...bulkDraft, includeManual: value.includeManual });
                }}
              />
            ) : (
              <div className="ecg-rhythm-range">
                {(['modelBeats', 'follow'] as const)
                  .filter(
                    (field) => field !== 'modelBeats' || lesson.gameData.soundMode === 'teacher',
                  )
                  .map((field) => (
                    <label key={field}>
                      {field === 'modelBeats' ? '统一教师示范拍数' : '统一学生跟读拍数'}
                      <input
                        type="number"
                        min={1}
                        max={32}
                        step={1}
                        value={bulkDraft[field] ?? commonFollow(field)}
                        placeholder="各词不同"
                        aria-invalid={bulkDraft[field] != null && !validBeats(bulkDraft[field]!)}
                        onChange={(event) =>
                          onBulkDraft({ ...bulkDraft, [field]: event.target.value })
                        }
                      />
                    </label>
                  ))}
                <p className={followPreview.error ? 'ecg-volume-error' : undefined}>
                  {followPreview.error ||
                    (bulkDraft.modelBeats != null || bulkDraft.follow != null
                      ? `将调整 ${followPreview.changed} 词，保留 ${followPreview.protectedFields} 个受保护字段。`
                      : '输入才统一拍数；未编辑的项目保留原安排。')}
                </p>
              </div>
            )}
            <p>范围输入不会修改词语内容或顺序；所有改动随底部完成设置一起保存。</p>
          </aside>
        )}
      </div>
      {undo && (
        <button
          type="button"
          disabled={hasUnfinishedNumber}
          onClick={() => {
            const error = applyRounds(undo);
            if (!error) {
              onUndo(null);
              onBulkDraft(createClassroomBulkDraft(lesson, scope));
            } else if (entry) onDraft({ id: entry.id, raw: String(entry.rounds.value), error });
          }}
        >
          撤销上次轮数调整
        </button>
      )}
      {chorusMode && rhythmUndo && (
        <button
          type="button"
          disabled={hasUnfinishedNumber}
          onClick={() => {
            const next = structuredClone(lesson);
            for (const item of getEntries(next)) {
              const previous = rhythmUndo.get(item.id);
              if (previous) item.chorus = structuredClone(previous);
            }
            onApply(next);
            onRhythmUndo(null);
            onRhythmBulk({ beats: null, beatsPerRead: null });
          }}
        >
          撤销上次齐读拍数调整
        </button>
      )}
      {(draft?.error || bulkDraft.error) && (
        <p role="alert" className="ecg-volume-error">
          {draft?.error || bulkDraft.error}
        </p>
      )}
    </section>
  );
}
