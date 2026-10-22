/** 材料集与教师常用词维护。所有课件使用内容副本，改删材料不会追改已有课件。 @author ahui */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { FileArrowUp, MagnifyingGlass, Plus, Sparkle, Trash } from '@phosphor-icons/react';
import type { TeachingEntry, ValidationIssue } from '../platform/types';
import type { DictionaryEntry } from '../platform/materials/types';
import type { MaterialCollection } from '../platform/repository';
import {
  createDictionaryIndex,
  dictionaryMeaningSource,
  lookupDictionary,
} from '../platform/materials/dictionary';
import {
  normalizeTeachingText,
  normalizeTeachingEntry,
  updateTeachingEntry,
  validateMaterialEntryLimit,
  validateTeachingEntry,
} from '../platform/materials/parser';
import {
  Badge,
  Button,
  Check,
  InputField,
  Modal,
  Notice,
  errorMessage,
  useFeedback,
} from '../shared/ui';
import { ImportPanel } from './ImportPanel';
import { TeachingEntrySource, TeachingTagsField } from './TeachingEntryFields';

interface MaterialsPageProps {
  dictionary: DictionaryEntry[];
  commonWords: TeachingEntry[];
  materials: MaterialCollection[];
  onMaterials: (materials: MaterialCollection[]) => Promise<void>;
  onCommonWords: (entries: TeachingEntry[]) => Promise<void>;
  onMake: (entries: TeachingEntry[]) => void;
  onSaveCommon: (entries: TeachingEntry[]) => void;
  /** 宿主在导航/关闭前调用；只确认离开许可，不提前清空尚未保存的表单。 */
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}

/** 可搜索、校对、复用原文和教学条目，不在后台自行积累个人画像。 */
export function MaterialsPage({
  dictionary,
  commonWords,
  materials,
  onMaterials,
  onCommonWords,
  onMake,
  onSaveCommon,
  onRegisterLeaveGuard,
}: MaterialsPageProps) {
  const [query, setQuery] = useState('');
  // 清除筛选后回到搜索框，避免被移除的按钮使键盘焦点掉回文档开头。
  const searchInput = useRef<HTMLInputElement>(null);
  const [tag, setTag] = useState('');
  const [tab, setTab] = useState('materials');
  const [importOpen, setImportOpen] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  const [detail, setDetail] = useState<MaterialCollection | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [detailPage, setDetailPage] = useState(0);
  const [detailQuery, setDetailQuery] = useState('');
  const [detailTag, setDetailTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailIssues, setDetailIssues] = useState<ValidationIssue[]>([]);
  const [detailFocus, setDetailFocus] = useState<ValidationIssue | null>(null);
  const [detailExpanded, setDetailExpanded] = useState<string[]>([]);
  const detailErrorSummary = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  const discardPrompt = useRef(false);
  const leaveGuard = useRef<() => Promise<boolean>>(async () => true);
  const { confirm, notify } = useFeedback();
  const dictionaryIndex = useMemo(
    () => createDictionaryIndex(dictionary, commonWords),
    [dictionary, commonWords],
  );
  const detailDirty =
    !!detail &&
    JSON.stringify(materials.find((material) => material.id === detail.id)) !==
      JSON.stringify(detail);
  /** 同一关闭操作只开一个确认；允许离开后由宿主真正导航，此处不销毁原输入。 */
  const mayDiscard = async (title: string): Promise<boolean> => {
    if (operation.current || discardPrompt.current) return false;
    discardPrompt.current = true;
    try {
      return await confirm({
        title,
        message: '尚未保存的本次修改将丢失，已保存材料与课件保留。',
        cancelLabel: '继续编辑',
        confirmLabel: '放弃修改',
        danger: true,
      });
    } finally {
      discardPrompt.current = false;
    }
  };
  leaveGuard.current = async () => {
    if (busy || operation.current) return false;
    if (detailDirty) return mayDiscard('放弃材料校对？');
    if (importOpen && importDirty) return mayDiscard('放弃导入材料？');
    return true;
  };
  useEffect(() => {
    onRegisterLeaveGuard?.(() => leaveGuard.current());
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!detailDirty && !(importOpen && importDirty) && !busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [detailDirty, importOpen, importDirty, busy]);
  const filteredWords = useMemo(
    () =>
      commonWords.filter(
        (entry) =>
          (!query ||
            `${entry.english} ${entry.meaning}`.toLowerCase().includes(query.toLowerCase())) &&
          (!tag || entry.tags?.includes(tag)),
      ),
    [commonWords, query, tag],
  );
  const filteredMaterials = materials.filter(
    (material) =>
      !query ||
      `${material.name} ${material.entries.map((entry) => `${entry.english} ${entry.meaning}`).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  // Only expose filters backed by real metadata; search and clear-filter recovery remain available.
  const tags = [...new Set(commonWords.flatMap((entry) => entry.tags ?? []))];
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const detailEntries =
    detail?.entries.filter(
      (entry) =>
        (!detailQuery ||
          `${entry.english} ${entry.meaning} ${entry.partOfSpeech ?? ''}`
            .toLowerCase()
            .includes(detailQuery.toLowerCase())) &&
        (!detailTag || entry.tags?.includes(detailTag) || entry.unit === detailTag),
    ) ?? [];
  const detailTags = [
    ...new Set(
      detail?.entries
        .flatMap((entry) => [entry.unit, ...(entry.tags ?? [])])
        .filter((value): value is string => !!value) ?? [],
    ),
  ];
  const currentDetailPage = Math.min(
    detailPage,
    Math.max(0, Math.ceil(detailEntries.length / 50) - 1),
  );
  const visibleDetailEntries = detailEntries.slice(
    currentDetailPage * 50,
    currentDetailPage * 50 + 50,
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filteredWords.length / 50) - 1));
  const openDetail = (material: MaterialCollection) => {
    setDetail(structuredClone(material));
    // 大材料集不代教师截取前 100 条；先明确选择教学范围。
    setSelected(material.entries.length <= 100 ? material.entries.map((entry) => entry.id) : []);
    setDetailPage(0);
    setDetailQuery('');
    setDetailTag('');
    setError('');
    setDetailIssues([]);
    setDetailExpanded([]);
  };
  const editDetail = (id: string, patch: Partial<TeachingEntry>) => {
    setError('');
    setDetailIssues([]);
    setDetail((previous) =>
      previous
        ? {
            ...previous,
            entries: previous.entries.map((entry) =>
              entry.id === id ? updateTeachingEntry(entry, patch) : entry,
            ),
          }
        : previous,
    );
  };
  /** 保存先聚焦摘要；只有教师点击定位时才清除筛选并切到实际错误所在页。 */
  const reportDetailIssues = (issues: ValidationIssue[]) => {
    setDetailIssues(issues);
    requestAnimationFrame(() => detailErrorSummary.current?.focus());
    throw new Error('请修正材料中的错误后再保存。');
  };
  const locateDetailIssue = (issue: ValidationIssue) => {
    if (!detail || !issue.objectId) return;
    setDetailQuery('');
    setDetailTag('');
    const index = detail.entries.findIndex((entry) => entry.id === issue.objectId);
    setDetailPage(Math.max(0, Math.floor(index / 50)));
    setDetailExpanded((previous) => [...new Set([...previous, issue.objectId!])]);
    setDetailFocus(issue);
  };
  useEffect(() => {
    if (!detailFocus) return;
    const frame = requestAnimationFrame(() => {
      const id =
        detailFocus.field === 'name'
          ? 'material-detail-name'
          : `detail-${detailFocus.objectId}-${detailFocus.field}`;
      const input = document.getElementById(id);
      input?.scrollIntoView?.({ block: 'center' });
      input?.focus();
      setDetailFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [detailFocus, detailPage, detailQuery, detailTag, detailExpanded]);
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  /**
   * 保存整份材料的已确认快照；用于制作时也必须保存名称和未选词的修改。
   * 校验或持久化失败会由 run 保留当前表单，调用方不得提前关闭或交接部分内容。
   */
  const saveDetail = async (material: MaterialCollection): Promise<MaterialCollection> => {
    if (![...material.name.trim()].length || [...material.name.trim()].length > 80)
      reportDetailIssues([
        {
          code: 'INVALID_FIELD',
          severity: 'error',
          field: 'name',
          objectId: material.id,
          message: '材料名称应为 1～80 字符。',
        },
      ]);
    validateMaterialEntryLimit(material.entries.length, 2000);
    const invalid = material.entries
      .flatMap(validateTeachingEntry)
      .filter((issue) => issue.severity === 'error');
    if (invalid.length) reportDetailIssues(invalid);
    const saved: MaterialCollection = {
      ...material,
      name: material.name.trim(),
      entries: material.entries.map(normalizeTeachingEntry),
      revision: material.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await onMaterials(materials.map((item) => (item.id === saved.id ? saved : item)));
    return saved;
  };

  return (
    <div className="page stack">
      <div className="page-heading">
        <div>
          <h1>教学材料</h1>
          <p>保存自己的教学内容，让下一次备课从已有材料开始。</p>
        </div>
        <Button variant="primary" onClick={() => setImportOpen(true)}>
          <FileArrowUp size={18} aria-hidden="true" />
          导入材料
        </Button>
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setPage(0);
        }}
      >
        <Tabs.List className="tabs-list" aria-label="材料分类">
          <Tabs.Trigger className="tab" value="materials">
            材料集 · {materials.length}
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="common">
            常用词库 · {commonWords.length}
          </Tabs.Trigger>
        </Tabs.List>
        <div className="row">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <input
            className="input grow"
            style={{ maxWidth: 440 }}
            aria-label="搜索教学材料"
            ref={searchInput}
            placeholder="搜索名称、英文或释义"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          {tab === 'common' && tags.length > 0 && (
            <select
              className="input"
              style={{ width: 180 }}
              aria-label="标签筛选"
              value={tag}
              onChange={(event) => {
                setTag(event.target.value);
                setPage(0);
              }}
            >
              <option value="">全部标签</option>
              {tags.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          )}
          {(query || (tab === 'common' && tag)) && (
            <Button
              variant="text"
              onClick={() => {
                setQuery('');
                if (tab === 'common') setTag('');
                setPage(0);
                searchInput.current?.focus();
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
        <Tabs.Content value="materials" style={{ marginTop: 16 }}>
          {!filteredMaterials.length ? (
            <div className="panel empty">
              <FileArrowUp size={40} aria-hidden="true" />
              <h2>{materials.length ? '没有匹配的教学材料' : '把本节课的材料放进来'}</h2>
              <p>
                {materials.length
                  ? '已有材料仍然保留。调整搜索内容，或清除筛选查看全部材料。'
                  : '词表、表格或阅读文本都可先校对，再用于智能制作。'}
              </p>
              {!materials.length && (
                <Button onClick={() => setImportOpen(true)}>
                  <Plus size={18} aria-hidden="true" />
                  粘贴 / 导入
                </Button>
              )}
            </div>
          ) : (
            <div className="grid-three">
              {filteredMaterials.map((material) => (
                <div className="lesson-card" key={material.id}>
                  <button className="card-main" onClick={() => openDetail(material)}>
                    <Badge>教师材料</Badge>
                    <h3>{material.name}</h3>
                    <small>
                      {material.entries.length} 条 ·{' '}
                      {new Date(material.updatedAt).toLocaleDateString()} · v{material.revision}
                    </small>
                  </button>
                  <div className="row">
                    <Button onClick={() => openDetail(material)}>
                      <Sparkle size={16} aria-hidden="true" />
                      用于制作
                    </Button>
                    <Button
                      variant="text"
                      aria-label={`删除材料${material.name}`}
                      onClick={() => {
                        void run(async () => {
                          if (
                            !(await confirm({
                              title: '删除材料',
                              message: `删除「${material.name}」及其原文，已有课件内容保留。`,
                              danger: true,
                            }))
                          )
                            return;
                          await onMaterials(materials.filter((item) => item.id !== material.id));
                        });
                      }}
                    >
                      <Trash size={18} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Tabs.Content>
        <Tabs.Content value="common" style={{ marginTop: 16 }}>
          {!filteredWords.length ? (
            <div className="panel empty">
              <h2>{commonWords.length ? '没有匹配的常用词' : '还没有常用词'}</h2>
              <p>
                {commonWords.length
                  ? '已有常用词仍然保留。调整搜索或标签，或清除筛选查看全部词条。'
                  : '在材料校对或课件编辑时，可主动保存已确认的教学词义与重点。'}
              </p>
            </div>
          ) : (
            <div className="stack">
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>英文 / 短语</th>
                      <th>教学释义</th>
                      <th>重点与标签</th>
                      <th style={{ width: 180 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWords.slice(currentPage * 50, currentPage * 50 + 50).map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <strong>{entry.english}</strong>
                          <small> {entry.partOfSpeech}</small>
                        </td>
                        <td>{entry.meaning || '释义未提供'}</td>
                        <td>
                          {entry.priority && <Badge tone="ai">重点</Badge>} {entry.tags?.join('、')}
                        </td>
                        <td>
                          <div className="row">
                            <Button variant="text" onClick={() => onSaveCommon([entry])}>
                              编辑 / 更新
                            </Button>
                            <Button
                              variant="text"
                              aria-label={`删除常用词${entry.english}`}
                              onClick={() => {
                                void run(async () => {
                                  if (
                                    !(await confirm({
                                      title: '删除常用词',
                                      message: `删除常用词「${entry.english}」的此义项，已有课件保留。`,
                                      danger: true,
                                    }))
                                  )
                                    return;
                                  await onCommonWords(
                                    commonWords.filter((item) => item.id !== entry.id),
                                  );
                                });
                              }}
                            >
                              <Trash size={16} aria-hidden="true" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row spread">
                <small>
                  共 {filteredWords.length} 条{filteredWords.length > 50 && '，每页 50 条'}
                </small>
                {filteredWords.length > 50 && (
                  <div className="row">
                    <Button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
                      上一页
                    </Button>
                    <span>{currentPage + 1}</span>
                    <Button
                      disabled={(currentPage + 1) * 50 >= filteredWords.length}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </Tabs.Content>
      </Tabs.Root>
      {error && !detail && !importOpen && (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      )}
      <Modal
        open={importOpen}
        wide
        onOpenChange={(open) => {
          if (open || busy || operation.current) return;
          void (async () => {
            if (!importDirty || (await mayDiscard('放弃导入材料？'))) {
              setImportOpen(false);
              setImportDirty(false);
            }
          })();
        }}
        title="导入教学材料"
      >
        <ImportPanel
          maxEntries={2000}
          dictionary={dictionary}
          commonWords={commonWords}
          actionLabel="保存材料集"
          onDraftChange={setImportDirty}
          disabled={busy}
          onConfirm={(entries, source) => {
            void run(async () => {
              const now = new Date().toISOString();
              const material: MaterialCollection = {
                id: crypto.randomUUID(),
                name: source.name,
                original: source.original,
                entries,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              };
              await onMaterials([material, ...materials]);
              setImportOpen(false);
              setImportDirty(false);
              notify('材料已保存，可随时用于制作。');
            });
          }}
        />
        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
      </Modal>
      <Modal
        open={!!detail}
        wide
        onOpenChange={(open) => {
          if (!open && !busy && !operation.current && detail) {
            void (async () => {
              if (!detailDirty || (await mayDiscard('放弃材料校对？'))) setDetail(null);
            })();
          }
        }}
        title="材料详情与校对"
        footer={
          <>
            <Button
              disabled={busy || !selected.length}
              onClick={() => {
                if (detail)
                  onSaveCommon(detail.entries.filter((entry) => selected.includes(entry.id)));
              }}
            >
              所选词存为常用词
            </Button>
            <Button
              busy={busy}
              onClick={() => {
                void run(async () => {
                  if (!detail) return;
                  await saveDetail(detail);
                  setDetail(null);
                  notify('材料已更新，已有课件不受影响。');
                });
              }}
            >
              保存校对
            </Button>
            <Button
              variant="primary"
              disabled={busy || !selected.length || selected.length > 100}
              onClick={() => {
                void run(async () => {
                  if (!detail) return;
                  const entries = detail.entries.filter((entry) => selected.includes(entry.id));
                  if (!entries.length || entries.length > 100) {
                    throw new Error('请勾选 1～100 条词汇。');
                  }
                  const invalid = entries
                    .flatMap(validateTeachingEntry)
                    .filter((issue) => issue.severity === 'error');
                  if (invalid.length) reportDetailIssues(invalid);
                  const source = detailDirty ? await saveDetail(detail) : detail;
                  const selectedEntries = source.entries.filter((entry) =>
                    selectedIds.has(entry.id),
                  );
                  // 修改已完整保存，交接独立内容副本；宿主不再为刚保存的表单重复确认。
                  leaveGuard.current = async () => true;
                  setDetail(null);
                  onMake(structuredClone(selectedEntries));
                });
              }}
            >
              {detailDirty ? '保存并用于智能制作' : '用于智能制作'}
            </Button>
          </>
        }
      >
        {/* 保存的是本次确认的快照；落盘期间仅暂停此表单编辑，防止成功关闭后丢掉新输入。 */}
        <fieldset
          className="stack"
          disabled={busy}
          aria-label="材料校对内容"
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          {detail && (
            <>
              <InputField
                label="材料名称"
                id="material-detail-name"
                value={detail.name}
                onChange={(event) => setDetail({ ...detail, name: event.target.value })}
              />
              <Notice>
                材料集可保存 2,000 条；用于单词节拍时明确选择 1～100 条。已选择 {selected.length}{' '}
                条，其中本页外{' '}
                {
                  selected.filter((id) => !visibleDetailEntries.some((entry) => entry.id === id))
                    .length
                }{' '}
                条；筛选不会改变既有选择。
              </Notice>
              {detailDirty && (
                <Notice>
                  “保存并用于智能制作”会先保存材料名称和全部词条修改，再使用所选词条制作。取消制作不会撤销这次保存。
                </Notice>
              )}
              <div className="row">
                <input
                  className="input grow"
                  aria-label="筛选材料词条"
                  placeholder="搜索英文、释义或词性"
                  value={detailQuery}
                  onChange={(event) => {
                    setDetailQuery(event.target.value);
                    setDetailPage(0);
                  }}
                />
                {detailTags.length > 0 && (
                  <select
                    className="input"
                    style={{ width: 180 }}
                    aria-label="材料单元或标签筛选"
                    value={detailTag}
                    onChange={(event) => {
                      setDetailTag(event.target.value);
                      setDetailPage(0);
                    }}
                  >
                    <option value="">全部单元 / 标签</option>
                    {detailTags.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="row spread">
                <div className="row">
                  <Button
                    onClick={() =>
                      setSelected((previous) => [
                        ...new Set([...previous, ...visibleDetailEntries.map((entry) => entry.id)]),
                      ])
                    }
                  >
                    选择本页
                  </Button>
                  <Button
                    onClick={() => {
                      const visible = new Set(visibleDetailEntries.map((entry) => entry.id));
                      setSelected((previous) => previous.filter((id) => !visible.has(id)));
                    }}
                  >
                    取消本页
                  </Button>
                  <Button onClick={() => setSelected([])} disabled={!selected.length}>
                    清空选择
                  </Button>
                </div>
                <small>
                  匹配 {detailEntries.length} / {detail.entries.length} 条
                  {detailEntries.length > 50 && ' · 每页 50 条'}
                </small>
              </div>
              <details>
                <summary>查看原始教学材料</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {detail.original}
                </pre>
              </details>
              <div className="material-detail-list">
                {visibleDetailEntries.map((entry) => {
                  const candidates = lookupDictionary(dictionaryIndex, entry.english);
                  const issues = validateTeachingEntry(entry).filter(
                    (issue) => issue.severity === 'error',
                  );
                  const extraErrors = issues.filter((issue) =>
                    ['partOfSpeech', 'unit', 'tags'].includes(issue.field ?? ''),
                  );
                  const expanded = detailExpanded.includes(entry.id);
                  return (
                    <div className="stack-sm property-group material-detail-entry" key={entry.id}>
                      <div className="material-detail-heading">
                        <Check
                          label="选择"
                          aria-label={`选择 ${entry.english}`}
                          checked={selectedIds.has(entry.id)}
                          onChange={(event) =>
                            setSelected((previous) =>
                              event.target.checked
                                ? [...previous, entry.id]
                                : previous.filter((id) => id !== entry.id),
                            )
                          }
                        />
                        <InputField
                          label="英文"
                          id={`detail-${entry.id}-english`}
                          value={entry.english}
                          error={
                            validateTeachingEntry(entry).find(
                              (issue) => issue.severity === 'error' && issue.field === 'english',
                            )?.message
                          }
                          onChange={(event) =>
                            editDetail(entry.id, { english: event.target.value })
                          }
                        />
                        <Check
                          label="重点"
                          checked={entry.priority}
                          onChange={(event) =>
                            editDetail(entry.id, { priority: event.target.checked })
                          }
                        />
                      </div>
                      <div className="material-detail-summary">
                        <div className="stack-sm">
                          <InputField
                            label="教学释义"
                            id={`detail-${entry.id}-meaning`}
                            value={entry.meaning}
                            error={
                              validateTeachingEntry(entry).find(
                                (issue) => issue.severity === 'error' && issue.field === 'meaning',
                              )?.message
                            }
                            onChange={(event) =>
                              editDetail(entry.id, { meaning: event.target.value })
                            }
                          />
                          <small>{candidates.length} 项词义候选</small>
                          {candidates.length > 0 && (
                            <details>
                              <summary>选择词义候选与来源</summary>
                              <select
                                className="input"
                                aria-label={`${entry.english}材料词义候选`}
                                value=""
                                onChange={(event) => {
                                  if (event.target.value === '') return;
                                  const candidate = candidates[Number(event.target.value)];
                                  if (candidate)
                                    editDetail(entry.id, {
                                      meaning: candidate.meaning,
                                      partOfSpeech: candidate.partOfSpeech,
                                      meaningSource: dictionaryMeaningSource(candidate),
                                      confirmed: true,
                                    });
                                }}
                              >
                                <option value="">选择本课采用的义项</option>
                                {candidates.map((candidate, index) => (
                                  <option value={index} key={index}>
                                    {candidate.partOfSpeech} {candidate.meaning} ·{' '}
                                    {candidate.source}
                                  </option>
                                ))}
                              </select>
                              {candidates.map((candidate, index) => (
                                <p key={index}>
                                  {candidate.partOfSpeech} {candidate.meaning} · {candidate.source}{' '}
                                  · {candidate.sourceVersion}
                                </p>
                              ))}
                            </details>
                          )}
                        </div>
                        <TeachingEntrySource entry={entry} />
                      </div>
                      <details open={expanded}>
                        <summary
                          onClick={(event) => {
                            event.preventDefault();
                            setDetailExpanded((previous) =>
                              expanded
                                ? previous.filter((id) => id !== entry.id)
                                : [...previous, entry.id],
                            );
                          }}
                        >
                          词性、单元与标签
                          {extraErrors.length > 0 && (
                            <span className="error-text"> · {extraErrors.length} 项错误</span>
                          )}
                        </summary>
                        {expanded && (
                          <div className="stack-sm">
                            <InputField
                              label="词性"
                              id={`detail-${entry.id}-partOfSpeech`}
                              value={entry.partOfSpeech ?? ''}
                              error={
                                validateTeachingEntry(entry).find(
                                  (issue) =>
                                    issue.severity === 'error' && issue.field === 'partOfSpeech',
                                )?.message
                              }
                              onChange={(event) =>
                                editDetail(entry.id, { partOfSpeech: event.target.value })
                              }
                            />
                            <div className="row">
                              <InputField
                                label="单元"
                                id={`detail-${entry.id}-unit`}
                                value={entry.unit ?? ''}
                                error={
                                  validateTeachingEntry(entry).find(
                                    (issue) => issue.severity === 'error' && issue.field === 'unit',
                                  )?.message
                                }
                                onChange={(event) =>
                                  editDetail(entry.id, { unit: event.target.value })
                                }
                              />
                              <TeachingTagsField
                                id={`detail-${entry.id}-tags`}
                                value={entry.tags}
                                error={
                                  validateTeachingEntry(entry).find(
                                    (issue) => issue.severity === 'error' && issue.field === 'tags',
                                  )?.message
                                }
                                onChange={(tags) => editDetail(entry.id, { tags })}
                              />
                            </div>
                          </div>
                        )}
                      </details>
                      {issues
                        .filter(
                          (issue) =>
                            !['partOfSpeech', 'unit', 'tags'].includes(issue.field ?? '') ||
                            expanded,
                        )
                        .map((issue) => (
                          <small role="alert" key={issue.field} className="error-text">
                            {issue.message}
                          </small>
                        ))}
                    </div>
                  );
                })}
              </div>
              {!visibleDetailEntries.length && (
                <Notice>没有匹配词条，请调整筛选；已有选择保持不变。</Notice>
              )}
              {detailEntries.length > 50 && (
                <div className="row spread">
                  <Button
                    disabled={!currentDetailPage}
                    onClick={() => setDetailPage(currentDetailPage - 1)}
                  >
                    上一页词条
                  </Button>
                  <span>
                    {currentDetailPage + 1} / {Math.max(1, Math.ceil(detailEntries.length / 50))}
                  </span>
                  <Button
                    disabled={(currentDetailPage + 1) * 50 >= detailEntries.length}
                    onClick={() => setDetailPage(currentDetailPage + 1)}
                  >
                    下一页词条
                  </Button>
                </div>
              )}
            </>
          )}
          {error && (
            <div ref={detailErrorSummary} tabIndex={-1} className="error-summary">
              <Notice tone="error" role="alert">
                {error}
                {detailIssues.map((issue, index) => (
                  <Button
                    key={`${issue.objectId}-${issue.field}-${index}`}
                    variant="text"
                    onClick={() => locateDetailIssue(issue)}
                  >
                    定位：{issue.message}
                  </Button>
                ))}
              </Notice>
            </div>
          )}
        </fieldset>
      </Modal>
    </div>
  );
}

/** 同义项的重点/标签变化允许明确更新，不同义项必须逐条选择新增/指定覆盖/跳过。 */
export function CommonWordsDialog({
  entries,
  existing,
  onClose,
  onSave,
  onRegisterLeaveGuard,
}: {
  entries: TeachingEntry[] | null;
  existing: TeachingEntry[];
  onClose: () => void;
  onSave: (entries: TeachingEntry[]) => Promise<void>;
  /** 窗口宿主在关闭前请求许可，不提前修改常用词库或清空当前编辑。 */
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, Partial<TeachingEntry>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const saving = useRef(false);
  const closing = useRef(false);
  const leaveGuard = useRef<() => Promise<boolean>>(async () => true);
  const { confirm } = useFeedback();
  const currentPage = Math.min(page, Math.max(0, Math.ceil((entries?.length ?? 0) / 50) - 1));
  const normalized = normalizeTeachingText;
  const matching = (entry: TeachingEntry) =>
    existing.filter((item) => normalized(item.english) === normalized(entry.english));
  const sameSense = (a: TeachingEntry, b: TeachingEntry) =>
    normalized(a.english) === normalized(b.english) &&
    (a.partOfSpeech ?? '') === (b.partOfSpeech ?? '') &&
    a.meaning === b.meaning;
  const same = (a: TeachingEntry, b: TeachingEntry) =>
    sameSense(a, b) &&
    a.priority === b.priority &&
    (a.unit ?? '') === (b.unit ?? '') &&
    JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []);
  const dirty =
    entries?.some((source) => {
      const entry = updateTeachingEntry(source, edited[source.id] ?? {});
      const defaultAction = existing.some((item) => item.id === source.id)
        ? source.id
        : matching(source).length
          ? 'skip'
          : 'new';
      return (
        JSON.stringify(entry) !== JSON.stringify(source) ||
        (choices[source.id] !== undefined && choices[source.id] !== defaultAction)
      );
    }) ?? false;
  /** 取消、Esc 和宿主窗口关闭共用许可；初始待保存内容不算额外编辑。 */
  const allowClose = async (): Promise<boolean> => {
    if (saving.current || closing.current) return false;
    if (!dirty) return true;
    closing.current = true;
    try {
      return await confirm({
        title: '放弃常用词修改？',
        message: '尚未保存的字段与保存方式修改将丢失，常用词库保留原内容。',
        cancelLabel: '继续编辑',
        confirmLabel: '放弃修改',
        danger: true,
      });
    } finally {
      closing.current = false;
    }
  };
  leaveGuard.current = allowClose;
  useEffect(() => {
    onRegisterLeaveGuard?.(() => leaveGuard.current());
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!dirty && !busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty, busy]);
  const close = async () => {
    if (!(await allowClose())) return;
    onClose();
    setChoices({});
    setEdited({});
    setPage(0);
    setError('');
  };
  const save = async () => {
    if (!entries || saving.current) return;
    saving.current = true;
    setError('');
    setBusy(true);
    try {
      const next = structuredClone(existing);
      for (const source of entries) {
        const entry = normalizeTeachingEntry(updateTeachingEntry(source, edited[source.id] ?? {}));
        const candidates = next.filter(
          (item) => normalized(item.english) === normalized(entry.english),
        );
        if (candidates.some((candidate) => same(candidate, entry))) continue;
        const action =
          choices[source.id] ??
          (existing.some((item) => item.id === source.id)
            ? source.id
            : matching(entry).length
              ? 'skip'
              : 'new');
        if (action === 'skip') continue;
        const invalid = validateTeachingEntry(entry).filter((issue) => issue.severity === 'error');
        if (invalid.length) throw new Error(invalid.map((issue) => issue.message).join('；'));
        const clean: TeachingEntry = {
          id: crypto.randomUUID(),
          english: normalized(entry.english),
          meaning: entry.meaning,
          partOfSpeech: entry.partOfSpeech,
          unit: entry.unit,
          priority: entry.priority,
          tags: entry.tags,
          entryType: entry.entryType,
          source: structuredClone(entry.source) ?? { name: '教师常用词库' },
          meaningSource: entry.meaningSource,
          confirmed: true,
        };
        if (action === 'new') next.push(clean);
        else {
          const position = next.findIndex((item) => item.id === action);
          // 编辑既有词本身时允许改正英文；从其他来源指定覆盖时，目标必须
          // 仍属于当前英文候选，不能把已失效的旧选择用于覆盖另一条词。
          if (
            position < 0 ||
            (action !== source.id &&
              normalized(next[position].english) !== normalized(entry.english))
          )
            throw new Error('指定常用词已变化，请重新检查差异。');
          next[position] = { ...clean, id: action };
        }
      }
      await onSave(next);
      onClose();
      setChoices({});
      setEdited({});
      setPage(0);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!entries}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
      title="保存常用词 · 检查差异"
      footer={
        <>
          <Button
            onClick={() => {
              void close();
            }}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              void save();
            }}
          >
            确认保存
          </Button>
        </>
      }
    >
      {/* 确认后写入的是固定内容；等待持久化时禁止继续修改这份待保存表单。 */}
      <fieldset
        className="stack"
        disabled={busy}
        aria-label="常用词校对内容"
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <Notice>仅保存教学字段，不保存本课轮数、声音或锁定。已有内容默认保留。</Notice>
        {entries?.slice(currentPage * 50, currentPage * 50 + 50).map((source) => {
          const entry = updateTeachingEntry(source, edited[source.id] ?? {});
          const candidates = matching(entry);
          const editingExisting = existing.find((item) => item.id === source.id);
          const identical = candidates.some((candidate) => same(candidate, entry));
          const sense = candidates.find((candidate) => sameSense(candidate, entry));
          return (
            <div key={source.id} className="stack-sm property-group">
              <div className="row spread">
                <strong>{entry.english}</strong>
                <Badge>
                  {identical
                    ? '完全相同，跳过'
                    : sense
                      ? '重点 / 标签变化'
                      : candidates.length
                        ? '不同义项'
                        : '新增'}
                </Badge>
              </div>
              <InputField
                label="英文 / 短语"
                value={entry.english}
                onChange={(event) => {
                  const english = event.target.value;
                  // 指定覆盖只对教师当时看到的同英文候选生效。改词后清除
                  // 不再显示的旧目标；显式新增、跳过和原条目更新仍然保留。
                  setChoices((previous) => {
                    const target = previous[source.id];
                    if (
                      !target ||
                      target === 'new' ||
                      target === 'skip' ||
                      target === source.id ||
                      existing.some(
                        (candidate) =>
                          candidate.id === target &&
                          normalized(candidate.english) === normalized(english),
                      )
                    )
                      return previous;
                    const next = { ...previous };
                    delete next[source.id];
                    return next;
                  });
                  setEdited((previous) => ({
                    ...previous,
                    [source.id]: { ...previous[source.id], english },
                  }));
                }}
              />
              <InputField
                label="词性"
                value={entry.partOfSpeech ?? ''}
                onChange={(event) =>
                  setEdited((previous) => ({
                    ...previous,
                    [source.id]: { ...previous[source.id], partOfSpeech: event.target.value },
                  }))
                }
              />
              <InputField
                label="教学释义"
                value={entry.meaning}
                onChange={(event) =>
                  setEdited((previous) => ({
                    ...previous,
                    [source.id]: { ...previous[source.id], meaning: event.target.value },
                  }))
                }
              />
              <Check
                label="重点"
                checked={entry.priority}
                onChange={(event) =>
                  setEdited((previous) => ({
                    ...previous,
                    [source.id]: { ...previous[source.id], priority: event.target.checked },
                  }))
                }
              />
              <InputField
                label="单元"
                value={entry.unit ?? ''}
                onChange={(event) =>
                  setEdited((previous) => ({
                    ...previous,
                    [source.id]: {
                      ...previous[source.id],
                      unit: event.target.value,
                    },
                  }))
                }
              />
              <TeachingTagsField
                label="标签"
                value={entry.tags}
                onChange={(tags) =>
                  setEdited((previous) => ({
                    ...previous,
                    [source.id]: { ...previous[source.id], tags },
                  }))
                }
              />
              {!identical && (
                <select
                  className="input"
                  aria-label={`${entry.english}保存方式`}
                  value={
                    choices[source.id] ??
                    editingExisting?.id ??
                    (candidates.length ? 'skip' : 'new')
                  }
                  onChange={(event) =>
                    setChoices((previous) => ({ ...previous, [source.id]: event.target.value }))
                  }
                >
                  <option value="skip">保留已有 / 跳过</option>
                  <option value="new">新增独立义项</option>
                  {editingExisting &&
                    !candidates.some((candidate) => candidate.id === editingExisting.id) && (
                      <option value={editingExisting.id}>
                        更新当前项：{editingExisting.english} ·{' '}
                        {editingExisting.meaning || '空释义'}
                      </option>
                    )}
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      更新指定项：{candidate.meaning || '空释义'}
                    </option>
                  ))}
                </select>
              )}
              {validateTeachingEntry(entry)
                .filter((issue) => issue.severity === 'error')
                .map((issue) => (
                  <small className="error-text" role="alert" key={issue.field}>
                    {issue.message}
                  </small>
                ))}
              <TeachingEntrySource entry={entry} />
            </div>
          );
        })}
        {!!entries?.length && (
          <div className="row spread">
            {entries.length > 50 && (
              <Button disabled={busy || !currentPage} onClick={() => setPage(currentPage - 1)}>
                上一页
              </Button>
            )}
            <small>
              共 {entries.length} 条
              {entries.length > 50 &&
                ` · ${currentPage + 1} / ${Math.ceil(entries.length / 50)} 页`}
            </small>
            {entries.length > 50 && (
              <Button
                disabled={busy || (currentPage + 1) * 50 >= entries.length}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </Button>
            )}
          </div>
        )}
        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
      </fieldset>
    </Modal>
  );
}
