/**
 * 材料校对共用入口。工作台、材料库及编辑器都先预览再确认，不能静默合并、
 * 截断或覆盖教学范围；未知词义保持为空，候选由教师明确接受。
 * @author ahui
 */
import { FileArrowUp, ListChecks, Sparkle } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TeachingEntry, ValidationIssue } from '../platform/types';
import type {
  ColumnMapping,
  DictionaryEntry,
  ImportPreview,
  MaterialColumnPurpose,
  ReadingCandidate,
} from '../platform/materials/types';
import {
  confirmImportedEntries,
  createMaterialColumnMapping,
  decodeMaterialText,
  mapMaterialRows,
  parseDelimitedRows,
  rebuildImportPreview,
  suggestColumnMapping,
  suggestMaterialColumns,
  updateMaterialRow,
  validateTeachingEntry,
} from '../platform/materials/parser';
import {
  createDictionaryIndex,
  acceptMaterialMeaning,
  chooseReadingMeaning,
  getSingleAcceptableMeaning,
  lookupDictionary,
  parseReadingText,
  selectedReadingEntries,
  updateReadingMeaning,
  dictionaryMeaningSource,
} from '../platform/materials/dictionary';
import * as native from '../platform/native';
import { desktopAvailable } from '../platform/repository';
import { Badge, Button, Check, Field, InputField, Modal, Notice, errorMessage } from '../shared/ui';
import { MeaningSourceBadges, TeachingEntrySource, TeachingTagsField } from './TeachingEntryFields';

const EXAMPLE =
  '英文\t释义\t词性\t单元\t标签\t重点\nachievement\t成就；成绩\tn.\tUnit 1\t高中\t是\nconcentrate\t集中（注意力）\tv.\nresponsibility\t责任\tn.\nmake a difference\t产生影响\tphr.\tUnit 1\t短语\t是\nindependent\t独立的\tadj.\nchallenge\t挑战\tn.';

const COLUMN_LABELS: Record<keyof ColumnMapping, string> = {
  english: '英文',
  meaning: '释义',
  partOfSpeech: '词性',
  unit: '单元',
  tags: '标签',
  priority: '重点',
};

/** 只把完整的常用列名当表头，不能因 homework 中包含 word 就丢掉首条教学内容。 */
function sheetDefaults(rows: string[][]): {
  purposes: MaterialColumnPurpose[];
  headerRows: number;
} {
  const header = rows[0] ?? [];
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const hasHeader =
    header.some((cell) =>
      ['英文', '单词', '词汇', 'english', 'word', 'phrase'].includes(cell.trim().toLowerCase()),
    ) &&
    header.every((cell) =>
      [
        '英文',
        '单词',
        '词汇',
        'english',
        'word',
        'phrase',
        '中文释义',
        '中文',
        '释义',
        '词义',
        'meaning',
        'translation',
        '词性',
        'pos',
        'partofspeech',
        'part of speech',
        '单元',
        'unit',
        '标签',
        'tags',
        'tag',
        '重点',
        '重点标记',
        'priority',
      ].includes(cell.trim().toLowerCase()),
    );
  const suggested = hasHeader ? suggestColumnMapping(header) : undefined;
  return {
    purposes: Array.from({ length: columnCount }, (_, column) =>
      suggested
        ? ((Object.keys(COLUMN_LABELS) as (keyof ColumnMapping)[]).find(
            (key) => suggested[key] === column,
          ) ?? '')
        : columnCount === 1
          ? 'english'
          : '',
    ),
    headerRows: hasHeader ? 1 : 0,
  };
}

interface ImportPanelProps {
  dictionary: DictionaryEntry[];
  commonWords: TeachingEntry[];
  onConfirm: (entries: TeachingEntry[], source: { name: string; original: string }) => void;
  actionLabel?: string;
  /** 材料集可保留2,000条，单课确认仍限100条；超限由教师缩减，不截断。 */
  maxEntries?: number;
  /** 宿主只在关闭会丢失输入时询问；AI 步骤会话不注册此回调，继续保留现有输入。 */
  onDraftChange?: (dirty: boolean) => void;
  /** 宿主正在持久化已确认材料时冻结此表单，避免保存成功关闭后丢失新输入。 */
  disabled?: boolean;
}

/** 源数据校对、候选选择及字段修改都只作用于预览，确认后才写入目标。 */
export function ImportPanel({
  dictionary,
  commonWords,
  onConfirm,
  actionLabel = '确认内容',
  maxEntries = 100,
  onDraftChange,
  disabled = false,
}: ImportPanelProps) {
  const [mode, setMode] = useState<'vocabulary' | 'reading'>('vocabulary');
  const [pendingMode, setPendingMode] = useState<'vocabulary' | 'reading' | null>(null);
  const [text, setText] = useState('');
  const [sourceName, setSourceName] = useState('粘贴词表');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [reading, setReading] = useState<ReadingCandidate[] | null>(null);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [showFunctions, setShowFunctions] = useState(false);
  const [keepOccurrences, setKeepOccurrences] = useState(false);
  const [error, setError] = useState('');
  const [errorFocusRequest, setErrorFocusRequest] = useState(0);
  /** 类型切换说明就近展示；不能把反馈放到长校对列表之后，造成点击似乎无响应。 */
  const [sourceModeError, setSourceModeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [encoding, setEncoding] = useState<'utf-8' | 'gb18030'>('utf-8');
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [columnPurposes, setColumnPurposes] = useState<MaterialColumnPurpose[]>([]);
  const [headerRows, setHeaderRows] = useState(0);
  const [fileWarnings, setFileWarnings] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [expandedProperties, setExpandedProperties] = useState<string[]>([]);
  const [submitIssues, setSubmitIssues] = useState<ValidationIssue[]>([]);
  const [pendingFocus, setPendingFocus] = useState<ValidationIssue | null>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  /** 每次失败都是独立定位请求；相同错误重复出现也不能停留在视口外。 */
  const showError = (cause: unknown) => {
    setError(errorMessage(cause));
    setErrorFocusRequest((previous) => previous + 1);
  };
  useEffect(() => {
    if (!error) return;
    const frame = requestAnimationFrame(() => {
      const summary = errorSummary.current;
      if (!summary) return;
      // 原生 focus/scrollIntoView 可能滚动固定模态及背景；先禁止隐式滚动，
      // 再只移动最近的滚动正文。制作页没有局部正文时才使用页面滚动。
      summary.focus({ preventScroll: true });
      let scrollBody = summary.parentElement;
      while (
        scrollBody &&
        (!/(auto|scroll)/u.test(getComputedStyle(scrollBody).overflowY) ||
          scrollBody.scrollHeight <= scrollBody.clientHeight)
      )
        scrollBody = scrollBody.parentElement;
      const summaryTop = summary.getBoundingClientRect().top;
      if (scrollBody)
        scrollBody.scrollTop += summaryTop - scrollBody.getBoundingClientRect().top - 12;
      else if (document.scrollingElement) document.scrollingElement.scrollTop += summaryTop - 80;
    });
    // 改正输入、重置来源或退出后，旧失败不能再抢走教师焦点。
    return () => cancelAnimationFrame(frame);
  }, [error, errorFocusRequest]);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const hasReview = !!preview || !!reading;
  const [sourceExpanded, setSourceExpanded] = useState(false);
  useEffect(() => {
    if (!hasReview) return;
    setSourceExpanded(false);
    // A newly generated review replaces the current task, so move to its heading.
    // Depend on presence, not edited rows: typing must never trigger scrolling.
    const frame = requestAnimationFrame(() => {
      reviewHeading.current?.scrollIntoView?.({ block: 'nearest' });
      reviewHeading.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hasReview]);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceToken = useRef<string>();
  const sourceBytes = useRef<Uint8Array>();
  /** 原生纯工作表不含文章原文；显式记录来源，避免误拦截由普通粘贴生成的预览工作表。 */
  const sourceKind = useRef<'text' | 'worksheets'>('text');
  const sourceEpoch = useRef(0);
  const index = useMemo(
    () => createDictionaryIndex(dictionary, commonWords),
    [dictionary, commonWords],
  );
  useEffect(() => {
    onDraftChange?.(!!text || sheets.length > 0 || !!preview || !!reading);
  }, [onDraftChange, text, sheets, preview, reading]);

  const clearResult = () => {
    setPreview(null);
    setReading(null);
    setExcluded([]);
    setError('');
    setSourceModeError('');
    setPage(0);
    setSubmitIssues([]);
    setExpandedProperties([]);
  };
  /** 新来源不继承旧文件的编码、工作表、映射及校对选择，原始文本由调用方保留或替换。 */
  const resetSourceSettings = (name: string) => {
    sourceKind.current = 'text';
    setEncoding('utf-8');
    setSourceName(name);
    setSheets([]);
    setSheetIndex(0);
    setColumnPurposes([]);
    setHeaderRows(0);
    setFileWarnings([]);
    clearResult();
  };
  /** 手工输入立即使迟到读取失效，之后切换编码也不能重新载入旧文件。 */
  const resetPastedSource = (name: string) => {
    sourceEpoch.current += 1;
    setBusy(false);
    sourceToken.current = undefined;
    sourceBytes.current = undefined;
    resetSourceSettings(name);
  };
  /**
   * Text can be reinterpreted after confirming review loss. A worksheet-only
   * native source has no article to retain, so reject that switch before any
   * source/review reset. Re-selecting the same type always remains a no-op.
   */
  const changeMode = (next: 'vocabulary' | 'reading') => {
    if (next === mode) return;
    if (next === 'reading' && sourceKind.current === 'worksheets' && sheets.length > 0) {
      setSourceModeError(
        '当前导入的是工作表，没有阅读文章原文。全部工作表和校对已保留；请先粘贴或导入阅读文章，再选择“阅读选词”。',
      );
      return;
    }
    if (hasReview) {
      setPendingMode(next);
      return;
    }
    setMode(next);
    resetPastedSource(next === 'reading' ? '阅读文本' : '粘贴词表');
  };
  useEffect(
    () => () => {
      sourceEpoch.current += 1;
    },
    [],
  );
  const analyze = () => {
    setError('');
    try {
      if (!text.trim() && !sheets.length) throw new Error('请先粘贴词表、阅读文本或导入文件。');
      if (mode === 'reading') {
        setReading(parseReadingText(text, index));
        setPreview(null);
      } else {
        let rows = sheets[sheetIndex]?.rows;
        let purposes = columnPurposes;
        let headers = headerRows;
        if (!rows) {
          if ([...text].length > 20_000) throw new Error('每次粘贴最多 20,000 字符，请分批导入。');
          rows = text
            .replace(/^\uFEFF/u, '')
            .split(/\r\n|\r|\n/u)
            .map((line) => line.split('\t'));
          const defaults = sheetDefaults(rows);
          setSheets([{ name: '粘贴内容', rows }]);
          setColumnPurposes(defaults.purposes);
          setHeaderRows(defaults.headerRows);
          purposes = defaults.purposes;
          headers = defaults.headerRows;
          // 无表头多列一律由教师确认，不根据列数或示例内容自动接受用途。
          if (purposes.some((purpose) => !purpose)) return;
        }
        const mapping = createMaterialColumnMapping(purposes);
        const next = mapMaterialRows(rows, {
          sourceName,
          mapping,
          headerRows: headers,
          originalText: text,
        });
        setPreview(next);
        setReading(null);
        setExcluded([]);
      }
    } catch (cause) {
      showError(cause);
    }
  };

  /** 选择文件不等于确认导入；先读取受限数据，再展示工作表和列映射。 */
  const chooseFile = async () => {
    if (!desktopAvailable) {
      fileInput.current?.click();
      return;
    }
    const epoch = ++sourceEpoch.current;
    setBusy(true);
    setError('');
    try {
      const selected = await native.selectFile('material');
      if (!selected || epoch !== sourceEpoch.current) return;
      resetSourceSettings(selected.name);
      setText('');
      sourceToken.current = selected.token;
      sourceBytes.current = undefined;
      const material = await native.readMaterial(selected.token, 'utf-8');
      if (epoch !== sourceEpoch.current) return;
      loadMaterial(
        material.name,
        material.rawText ?? '',
        material.sheets,
        material.warnings,
        material.rawText ? 'text' : 'worksheets',
      );
    } catch (cause) {
      if (epoch === sourceEpoch.current) showError(cause);
    } finally {
      if (epoch === sourceEpoch.current) setBusy(false);
    }
  };

  const loadMaterial = (
    name: string,
    original: string,
    nextSheets: { name: string; rows: string[][] }[],
    warnings: string[],
    kind: 'text' | 'worksheets' = 'text',
  ) => {
    clearResult();
    // CSV/TXT 与手工文本仍可切换；只有原生未提供 rawText 的工作表受保护。
    sourceKind.current = kind;
    setSourceName(name);
    setText(original);
    setSheets(nextSheets);
    setSheetIndex(0);
    setMode('vocabulary');
    setFileWarnings(warnings);
    const defaults = sheetDefaults(nextSheets[0]?.rows ?? []);
    setColumnPurposes(defaults.purposes);
    setHeaderRows(defaults.headerRows);
  };

  /** 浏览器开发预览只读取选定的文本文件；XLSX 正式解析由 Rust 的受限解压服务执行。 */
  const readBrowserFile = async (file: File | undefined) => {
    if (!file) return;
    const epoch = ++sourceEpoch.current;
    setBusy(true);
    resetSourceSettings(file.name);
    setText('');
    sourceToken.current = undefined;
    sourceBytes.current = undefined;
    try {
      if (!/\.(csv|txt)$/i.test(file.name))
        throw new Error('XLSX 导入请在 Windows 备课软件中使用。');
      if (file.size > 5_000_000) throw new Error('文本文件不能超过 5 MB。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (epoch !== sourceEpoch.current) return;
      sourceBytes.current = bytes;
      loadBrowserText(file.name, decodeMaterialText(bytes, 'utf-8'));
    } catch (cause) {
      if (epoch === sourceEpoch.current) showError(cause);
    } finally {
      if (epoch === sourceEpoch.current) setBusy(false);
    }
  };

  /** 文本文件也展示真实列映射；浏览器预览与原生读取使用同一后续校对流程。 */
  const loadBrowserText = (name: string, original: string) => {
    const rows = name.toLowerCase().endsWith('.csv')
      ? parseDelimitedRows(original.replace(/^\uFEFF/u, ''))
      : original.split(/\r\n|\r|\n/u).map((line) => line.split('\t'));
    loadMaterial(name, original, [{ name, rows }], []);
  };

  const changeEncoding = async (value: 'utf-8' | 'gb18030') => {
    // 粘贴内容已经是字符串，没有可重解码的文件；不能因无关的编码操作清空教师输入。
    if (!sourceToken.current && !sourceBytes.current) return;
    const epoch = ++sourceEpoch.current;
    setEncoding(value);
    clearResult();
    // 旧解码结果不能在重读失败后被重新提交；文件身份和原始字节仍保留，便于切回正确编码。
    setSheets([]);
    setText('');
    setFileWarnings([]);
    setBusy(true);
    try {
      if (desktopAvailable && sourceToken.current) {
        const material = await native.readMaterial(sourceToken.current, value);
        if (epoch !== sourceEpoch.current) return;
        loadMaterial(
          material.name,
          material.rawText ?? '',
          material.sheets,
          material.warnings,
          material.rawText ? 'text' : 'worksheets',
        );
      } else if (sourceBytes.current) {
        loadBrowserText(sourceName, decodeMaterialText(sourceBytes.current, value));
      }
    } catch (cause) {
      if (epoch === sourceEpoch.current) showError(cause);
    } finally {
      if (epoch === sourceEpoch.current) setBusy(false);
    }
  };

  const updateRow = (id: string, patch: Partial<TeachingEntry>) => {
    setError('');
    setPreview((previous) =>
      previous
        ? rebuildImportPreview(
            previous,
            previous.rows.map((row) => (row.entry.id === id ? updateMaterialRow(row, patch) : row)),
          )
        : previous,
    );
  };
  const acceptMeanings = () =>
    setPreview((previous) =>
      previous
        ? rebuildImportPreview(
            previous,
            previous.rows.map((row) => {
              if (excluded.includes(row.row) || row.entry.meaning.trim()) return row;
              const candidate = getSingleAcceptableMeaning(
                lookupDictionary(index, row.entry.english),
              );
              return candidate ? acceptMaterialMeaning(row, candidate) : row;
            }),
          )
        : previous,
    );
  /** 阅读属性只改教师本次编辑项，不连带勾选候选或替教师接受词义。 */
  const patchReading = (id: string, patch: Partial<ReadingCandidate>) => {
    setError('');
    setReading(
      (previous) =>
        previous?.map((item) => (item.id === id ? { ...item, ...patch } : item)) ?? null,
    );
  };
  const readingFieldError = (candidate: ReadingCandidate, field: string) =>
    validateTeachingEntry({
      id: candidate.id,
      english: candidate.english,
      meaning: candidate.teachingMeaning ?? '',
      partOfSpeech: candidate.teachingPartOfSpeech,
      unit: candidate.unit,
      tags: candidate.tags,
      priority: candidate.group === 'priority',
    }).find((issue) => issue.severity === 'error' && issue.field === field)?.message;
  const fieldId = (id: string, field: string) => `material-${id}-${field}`;
  const toggleProperties = (id: string) =>
    setExpandedProperties((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  /** 教师点击定位才切页/展开；后台校验只更新错误，不抢走当前输入焦点。 */
  const locateIssue = (issue: ValidationIssue) => {
    if (!issue.objectId) return;
    if (reading) {
      const target = reading.findIndex((candidate) => candidate.id === issue.objectId);
      setShowFunctions(true);
      setPage(Math.max(0, Math.floor(target / 50)));
    } else if (preview) {
      const target = preview.rows.findIndex((row) => row.entry.id === issue.objectId);
      setPage(Math.max(0, Math.floor(target / 50)));
    }
    setExpandedProperties((previous) => [...new Set([...previous, issue.objectId!])]);
    setPendingFocus(issue);
  };
  useEffect(() => {
    if (!pendingFocus?.objectId || !pendingFocus.field) return;
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById(fieldId(pendingFocus.objectId!, pendingFocus.field!));
      input?.scrollIntoView?.({ block: 'center' });
      input?.focus();
      setPendingFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, page, expandedProperties]);
  const completionCount =
    preview?.rows.filter(
      (row) =>
        !excluded.includes(row.row) &&
        !row.entry.meaning.trim() &&
        !!getSingleAcceptableMeaning(lookupDictionary(index, row.entry.english)),
    ).length ?? 0;

  const visibleReading =
    reading?.filter(
      (candidate) =>
        showFunctions ||
        candidate.group === 'priority' ||
        (!candidate.functionWord && !candidate.hiddenByPhrase),
    ) ?? [];
  const rowsOnPage = preview?.rows.slice(page * 50, (page + 1) * 50) ?? [];
  const readingOnPage = visibleReading.slice(page * 50, (page + 1) * 50);
  const selectedCount = reading
    ? reading.filter((item) => item.selected).length
    : (preview?.rows.filter((row) => !excluded.includes(row.row)).length ?? 0);
  const visibleSelected = reading
    ? readingOnPage.filter((item) => item.selected).length
    : rowsOnPage.filter((row) => !excluded.includes(row.row)).length;
  const pageCount = Math.max(
    1,
    Math.ceil((reading ? visibleReading.length : (preview?.rows.length ?? 0)) / 50),
  );

  const columnSuggestions = suggestMaterialColumns(
    sheets[sheetIndex]?.rows.slice(headerRows) ?? [],
  );
  let columnProblem = '';
  if (sheets.length) {
    const missing = columnPurposes.filter((purpose) => !purpose).length;
    if (missing) columnProblem = `还需确认 ${missing} 列用途；可先采用建议，再补充不确定列。`;
    else {
      try {
        createMaterialColumnMapping(columnPurposes);
      } catch (cause) {
        columnProblem = errorMessage(cause);
      }
    }
  }

  const confirm = () => {
    // 异步读取尚未结束时，不能把上一来源的预览当成本次已校对内容提交。
    if (busy) return;
    setError('');
    try {
      const issues = reading
        ? reading
            .filter((item) => item.selected)
            .flatMap((candidate) =>
              validateTeachingEntry({
                id: candidate.id,
                english: candidate.english,
                meaning: candidate.teachingMeaning ?? '',
                partOfSpeech: candidate.teachingPartOfSpeech,
                unit: candidate.unit,
                tags: candidate.tags,
                priority: candidate.group === 'priority',
              }),
            )
        : (preview?.rows
            .filter((row) => !excluded.includes(row.row))
            .flatMap((row) => row.issues) ?? []);
      const errors = issues.filter((issue) => issue.severity === 'error');
      setSubmitIssues(errors);
      if (errors.length) throw new Error('请修正或明确排除有错误的行后再确认。');
      const entries = reading
        ? selectedReadingEntries(reading, keepOccurrences, maxEntries)
        : preview
          ? confirmImportedEntries(preview, excluded, maxEntries)
          : [];
      if (!entries.length) throw new Error('请至少选择一个有效词条。');
      if (entries.length > maxEntries)
        throw new Error(`已选择 ${entries.length} 条，此处最多 ${maxEntries} 条，请调整选择。`);
      onConfirm(entries, {
        name: sourceName,
        original: text || JSON.stringify(sheets[sheetIndex]?.rows ?? []),
      });
    } catch (cause) {
      showError(cause);
    }
  };

  return (
    <fieldset className="import-panel stack" disabled={disabled} data-review={hasReview}>
      {hasReview && (
        <div className="row spread import-source-summary">
          <div className="row">
            <strong>{sourceName}</strong>
            <Button variant="text" onClick={() => setSourceExpanded((value) => !value)}>
              {sourceExpanded ? '收起原文与列设置' : '查看或修改原文与列设置'}
            </Button>
          </div>
          <Button variant="primary" onClick={confirm} disabled={busy}>
            {actionLabel}
          </Button>
        </div>
      )}
      <div className="stack import-source-body" hidden={hasReview && !sourceExpanded}>
        <div className="row spread">
          <div className="row" role="group" aria-label="材料类型">
            <Button
              variant={mode === 'vocabulary' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'vocabulary'}
              onClick={() => changeMode('vocabulary')}
            >
              词表 / 表格
            </Button>
            <Button
              variant={mode === 'reading' ? 'primary' : 'secondary'}
              aria-pressed={mode === 'reading'}
              onClick={() => changeMode('reading')}
            >
              阅读选词
            </Button>
          </div>
          <Button onClick={chooseFile} busy={busy}>
            <FileArrowUp size={18} aria-hidden="true" />
            导入文件
          </Button>
        </div>
        {sourceModeError && (
          <Notice tone="error" role="alert">
            {sourceModeError}
          </Notice>
        )}
        <input
          type="file"
          ref={fileInput}
          hidden
          accept=".csv,.txt"
          onChange={(event) => {
            void readBrowserFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Field
          label={mode === 'reading' ? '高中阅读文本' : '教学词表'}
          hint={
            mode === 'reading'
              ? '先匹配当前词库中的连续短语，再提取单词；未匹配不代表短语不存在。可在词表中手工加入完整短语，确认后保存到常用词库复用。只有选中的候选才加入课件。'
              : '每行一个单词或短语；英文、释义、词性、单元、标签、重点可用 Tab 分列。Shift+Tab 向前离开；Ctrl+Enter 前往整理并预览。单元与标签独立。'
          }
        >
          <textarea
            aria-label={mode === 'reading' ? '高中阅读文本' : '教学词表'}
            className="input"
            rows={7}
            value={text}
            onKeyDown={(event) => {
              if (mode !== 'vocabulary' || event.nativeEvent.isComposing) return;
              if (
                event.key === 'Enter' &&
                event.ctrlKey &&
                !event.altKey &&
                !event.metaKey &&
                !event.shiftKey
              ) {
                event.preventDefault();
                // 通过表单内的语义动作定位，跨制作页和导入弹窗保持同一种键盘行为。
                event.currentTarget
                  .closest('.import-panel')
                  ?.querySelector<HTMLButtonElement>('[data-vocabulary-preview]')
                  ?.focus();
                return;
              }
              if (
                event.key !== 'Tab' ||
                event.shiftKey ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey
              )
                return;
              event.preventDefault();
              const input = event.currentTarget;
              // 原生插入保留撤销栈，并触发既有 onChange / 来源失效逻辑；不支持时安全降级。
              // 不在阅读文本拦截 Tab，且提供双向离开键，避免形成键盘陷阱。
              if (!document.execCommand('insertText', false, '\t')) {
                input.setRangeText('\t', input.selectionStart, input.selectionEnd, 'end');
                const caret = input.selectionStart;
                setText(input.value);
                resetPastedSource('粘贴词表');
                requestAnimationFrame(() => {
                  if (input.isConnected && document.activeElement === input)
                    input.setSelectionRange(caret, caret);
                });
              }
            }}
            onChange={(event) => {
              setText(event.target.value);
              resetPastedSource(mode === 'reading' ? '阅读文本' : '粘贴词表');
            }}
            placeholder={
              mode === 'reading'
                ? '粘贴本节课使用的阅读段落……'
                : 'achievement\t成就\nmake a difference\t产生影响'
            }
          />
        </Field>
        <div className="row spread">
          <div className="row">
            <Button data-vocabulary-preview onClick={analyze} disabled={busy}>
              <ListChecks size={18} aria-hidden="true" />
              整理并预览
            </Button>
            {mode === 'vocabulary' && (
              <Button
                variant="text"
                onClick={() => {
                  setText(EXAMPLE);
                  resetPastedSource('内置示例词表');
                }}
              >
                使用示例词表
              </Button>
            )}
          </div>
          <label className="row">
            文件编码
            <select
              className="input"
              style={{ width: 130 }}
              value={encoding}
              disabled={!sourceToken.current && !sourceBytes.current}
              onChange={(event) => {
                void changeEncoding(event.target.value as 'utf-8' | 'gb18030');
              }}
            >
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030</option>
            </select>
          </label>
        </div>
        {sheets.length > 0 && (
          <div className="panel panel-compact stack-sm">
            <div className="row">
              <Field label="工作表">
                <select
                  aria-label="工作表"
                  className="input"
                  value={sheetIndex}
                  disabled={busy}
                  onChange={(event) => {
                    setSheetIndex(Number(event.target.value));
                    const defaults = sheetDefaults(sheets[Number(event.target.value)]?.rows ?? []);
                    setColumnPurposes(defaults.purposes);
                    setHeaderRows(defaults.headerRows);
                    clearResult();
                  }}
                >
                  {sheets.map((sheet, position) => (
                    <option key={position} value={position}>
                      {sheet.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Check
                label="首行是表头"
                checked={headerRows === 1}
                disabled={busy}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setHeaderRows(checked ? 1 : 0);
                  if (checked) setColumnPurposes(sheetDefaults(sheets[sheetIndex].rows).purposes);
                  clearResult();
                }}
              />
            </div>
            <small>
              请确认每列用途；不需要的列选“忽略”。英文只能指定一列，其他字段可以不提供。
            </small>
            {columnSuggestions.some((purpose, column) => purpose && !columnPurposes[column]) && (
              <div className="notice notice-info stack-sm">
                <span>
                  本地列用途建议：
                  {columnSuggestions
                    .map((purpose, column) =>
                      purpose
                        ? `第${column + 1}列${COLUMN_LABELS[purpose as keyof ColumnMapping]}`
                        : '',
                    )
                    .filter(Boolean)
                    .join(' · ')}
                  。依据文字类型、词性缩写、单元格式和是／否标记；不确定列仍需你确认。
                </span>
                <Button
                  disabled={busy}
                  onClick={() => {
                    // Accept only unassigned purposes; never replace a teacher choice.
                    const used = new Set(columnPurposes.filter(Boolean));
                    setColumnPurposes(
                      columnPurposes.map(
                        (purpose, column) =>
                          purpose ||
                          (used.has(columnSuggestions[column]) ? '' : columnSuggestions[column]),
                      ),
                    );
                    clearResult();
                  }}
                >
                  采用列用途建议
                </Button>
              </div>
            )}
            <div className="row">
              {columnPurposes.map((purpose, column) => (
                <Field key={column} label={`第 ${column + 1} 列用途`}>
                  <select
                    aria-label={`第 ${column + 1} 列用途`}
                    className="input"
                    value={purpose}
                    disabled={busy}
                    onChange={(event) => {
                      setColumnPurposes((previous) =>
                        previous.map((value, index) =>
                          index === column ? (event.target.value as MaterialColumnPurpose) : value,
                        ),
                      );
                      clearResult();
                    }}
                  >
                    <option value="">请选择用途</option>
                    {(Object.keys(COLUMN_LABELS) as (keyof ColumnMapping)[]).map((key) => (
                      <option key={key} value={key}>
                        {COLUMN_LABELS[key]}
                      </option>
                    ))}
                    <option value="ignore">忽略</option>
                  </select>
                  <small>
                    {sheets[sheetIndex].rows
                      .slice(headerRows, headerRows + 2)
                      .map((row) => row[column] ?? '（空）')
                      .join(' / ')}
                  </small>
                </Field>
              ))}
            </div>
            <div className="row spread import-next-step">
              <span role="status">
                {columnProblem || '列用途已齐全，下一步查看并确认教学内容。'}
              </span>
              <Button variant="primary" disabled={busy || !!columnProblem} onClick={analyze}>
                下一步：校对内容
              </Button>
            </div>
          </div>
        )}
        {fileWarnings.map((warning, position) => (
          <Notice tone="warning" key={position}>
            {warning}
          </Notice>
        ))}
      </div>
      {preview && (
        <div className="stack-sm">
          <div className="row spread">
            <h3 ref={reviewHeading} tabIndex={-1}>
              校对 {preview.rows.length} 条教学内容
            </h3>
            {completionCount > 0 && (
              <Button variant="text" onClick={acceptMeanings}>
                <Sparkle size={18} aria-hidden="true" />
                接受 {completionCount} 项单一词义候选
              </Button>
            )}
          </div>
          {preview.duplicateGroups.length > 0 && (
            <Notice tone="warning">
              发现 {preview.duplicateGroups.length} 组疑似重复，已保留全部；取消勾选才会排除。
            </Notice>
          )}
          <div className="material-review-container">
            <div className="table-shell material-review">
              <table>
                <thead>
                  <tr>
                    <th className="check-cell">选</th>
                    <th>英文 / 短语</th>
                    <th>教学释义与候选</th>
                    <th style={{ width: 88 }}>重点</th>
                    <th style={{ width: 140 }}>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsOnPage.map((row) => {
                    const candidates = lookupDictionary(index, row.entry.english);
                    const fieldError = (field: string) =>
                      row.issues.find(
                        (issue) => issue.severity === 'error' && issue.field === field,
                      )?.message;
                    return (
                      <tr className="review-row" key={row.entry.id}>
                        <td className="review-choice">
                          <input
                            aria-label={`选择第${row.row}行`}
                            type="checkbox"
                            checked={!excluded.includes(row.row)}
                            onChange={(event) =>
                              setExcluded((previous) =>
                                event.target.checked
                                  ? previous.filter((value) => value !== row.row)
                                  : [...previous, row.row],
                              )
                            }
                          />
                        </td>
                        <td className="review-english">
                          <InputField
                            label="英文 / 短语"
                            id={fieldId(row.entry.id, 'english')}
                            aria-label={`第${row.row}行英文`}
                            error={fieldError('english')}
                            value={row.entry.english}
                            onChange={(event) =>
                              updateRow(row.entry.id, { english: event.target.value })
                            }
                          />
                          {row.issues
                            .filter((issue) => issue.field === 'priority')
                            .map((issue, position) => (
                              <small className="error-text" key={position}>
                                {issue.message}
                              </small>
                            ))}
                          <details open={expandedProperties.includes(row.entry.id)}>
                            <summary
                              onClick={(event) => {
                                event.preventDefault();
                                toggleProperties(row.entry.id);
                              }}
                            >
                              词性、单元与标签
                              {row.issues.some(
                                (issue) =>
                                  issue.severity === 'error' &&
                                  ['partOfSpeech', 'unit', 'tags'].includes(issue.field ?? ''),
                              ) && (
                                <span className="error-text">
                                  {' '}
                                  ·{' '}
                                  {
                                    row.issues.filter(
                                      (issue) =>
                                        issue.severity === 'error' &&
                                        ['partOfSpeech', 'unit', 'tags'].includes(
                                          issue.field ?? '',
                                        ),
                                    ).length
                                  }{' '}
                                  项错误
                                </span>
                              )}
                            </summary>
                            {expandedProperties.includes(row.entry.id) && (
                              <div className="stack-sm">
                                <InputField
                                  label="词性"
                                  id={fieldId(row.entry.id, 'partOfSpeech')}
                                  aria-label={`第${row.row}行词性`}
                                  value={row.entry.partOfSpeech ?? ''}
                                  error={fieldError('partOfSpeech')}
                                  onChange={(event) =>
                                    updateRow(row.entry.id, { partOfSpeech: event.target.value })
                                  }
                                />
                                <InputField
                                  label="单元"
                                  id={fieldId(row.entry.id, 'unit')}
                                  aria-label={`第${row.row}行单元`}
                                  value={row.entry.unit ?? ''}
                                  error={fieldError('unit')}
                                  onChange={(event) =>
                                    updateRow(row.entry.id, { unit: event.target.value })
                                  }
                                />
                                <TeachingTagsField
                                  id={fieldId(row.entry.id, 'tags')}
                                  value={row.entry.tags}
                                  error={fieldError('tags')}
                                  onChange={(tags) => updateRow(row.entry.id, { tags })}
                                />
                              </div>
                            )}
                          </details>
                        </td>
                        <td className="review-meaning">
                          <InputField
                            label="教学释义"
                            id={fieldId(row.entry.id, 'meaning')}
                            aria-label={`第${row.row}行释义`}
                            error={fieldError('meaning')}
                            value={row.entry.meaning}
                            onChange={(event) =>
                              updateRow(row.entry.id, { meaning: event.target.value })
                            }
                          />
                          {!candidates.length && !row.entry.meaning && (
                            <small>未收录，可手动补充或仅练英文</small>
                          )}
                          {candidates.length > 0 && (
                            <details className="meaning-candidates">
                              <summary>查看词典参考（{candidates.length} 条）</summary>
                              <select
                                className="input"
                                aria-label={`第${row.row}行词义候选`}
                                value=""
                                onChange={(event) => {
                                  const candidate = candidates[Number(event.target.value)];
                                  if (candidate)
                                    setPreview((previous) =>
                                      previous
                                        ? rebuildImportPreview(
                                            previous,
                                            previous.rows.map((item) =>
                                              item.entry.id === row.entry.id
                                                ? acceptMaterialMeaning(item, candidate)
                                                : item,
                                            ),
                                          )
                                        : previous,
                                    );
                                }}
                              >
                                <option value="">选择词义候选（{candidates.length}）</option>
                                {candidates.map((candidate, position) => (
                                  <option value={position} key={position}>
                                    {candidate.partOfSpeech} {candidate.meaning} ·{' '}
                                    {candidate.source}
                                  </option>
                                ))}
                              </select>
                              {candidates.map((candidate, position) => (
                                <div key={position} className="stack-sm">
                                  <p>
                                    {candidate.partOfSpeech} {candidate.meaning}
                                  </p>
                                  <MeaningSourceBadges
                                    source={dictionaryMeaningSource(candidate)}
                                  />
                                  <small>
                                    {candidate.source} · {candidate.sourceVersion}
                                  </small>
                                </div>
                              ))}
                            </details>
                          )}
                        </td>
                        <td className="review-priority">
                          <label className="check">
                            <input
                              type="checkbox"
                              id={fieldId(row.entry.id, 'priority')}
                              aria-label={`${row.entry.english}设为重点`}
                              checked={row.entry.priority}
                              onChange={(event) =>
                                updateRow(row.entry.id, { priority: event.target.checked })
                              }
                            />
                            重点
                          </label>
                        </td>
                        <td className="review-source">
                          <small>
                            {sourceName}
                            <br />第 {row.row} 行
                          </small>
                          <TeachingEntrySource entry={row.entry} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {reading && (
        <div className="stack-sm">
          <div className="row spread">
            <h3 ref={reviewHeading} tabIndex={-1}>
              阅读候选 · {reading.filter((item) => item.selected).length} 项已选
            </h3>
            <Check
              label="显示功能词与短语内部词"
              checked={showFunctions}
              onChange={(event) => {
                setShowFunctions(event.target.checked);
                setPage(0);
              }}
            />
          </div>
          <Check
            label="保留各次重复出现的位置"
            checked={keepOccurrences}
            onChange={(event) => setKeepOccurrences(event.target.checked)}
          />
          <div className="row" role="group" aria-label="按候选分组选词">
            {(['priority', 'high-school', 'other'] as const).map((group, position) => {
              const ids = new Set(
                visibleReading.filter((item) => item.group === group).map((item) => item.id),
              );
              return (
                <Button
                  key={group}
                  disabled={!ids.size}
                  onClick={() => {
                    setError('');
                    setReading(
                      (previous) =>
                        previous?.map((item) =>
                          ids.has(item.id) ? { ...item, selected: true } : item,
                        ) ?? null,
                    );
                  }}
                >
                  选中{['教师重点', '高中词库', '其他原词'][position]}当前结果（{ids.size}项）
                </Button>
              );
            })}
          </div>
          <div className="material-review-container">
            <div className="table-shell material-review material-review-reading">
              <table>
                <thead>
                  <tr>
                    <th className="check-cell">选</th>
                    <th>原文候选</th>
                    <th>词义依据</th>
                    <th style={{ width: 120 }}>出现情况</th>
                  </tr>
                </thead>
                <tbody>
                  {readingOnPage.map((candidate) => (
                    <tr className="review-row" key={candidate.id}>
                      <td className="review-choice">
                        <input
                          type="checkbox"
                          aria-label={`选择${candidate.english}`}
                          checked={candidate.selected}
                          onChange={(event) =>
                            setReading(
                              (previous) =>
                                previous?.map((item) =>
                                  item.id === candidate.id
                                    ? { ...item, selected: event.target.checked }
                                    : item,
                                ) ?? null,
                            )
                          }
                        />
                      </td>
                      <td className="review-english">
                        <strong>{candidate.english}</strong>
                        <div>
                          <Badge>
                            {candidate.group === 'priority'
                              ? '教师重点'
                              : candidate.group === 'high-school'
                                ? '高中词库'
                                : '其他原词'}
                          </Badge>
                        </div>
                        {candidate.lemma && <small>词形候选：{candidate.lemma}（保留原文）</small>}
                      </td>
                      <td className="review-meaning">
                        <small>
                          {candidate.dictionaryEntries.length}{' '}
                          条词典参考记录（可能含多个词性／义项，请确认本课释义）
                        </small>
                        {candidate.dictionaryEntries.length ? (
                          <select
                            aria-label={`${candidate.english}候选义项`}
                            className="input"
                            value={candidate.selectedDictionaryEntry ?? ''}
                            onChange={(event) => {
                              setError('');
                              setReading(
                                (previous) =>
                                  previous?.map((item) =>
                                    item.id === candidate.id
                                      ? chooseReadingMeaning(
                                          item,
                                          event.target.value === ''
                                            ? null
                                            : Number(event.target.value),
                                        )
                                      : item,
                                  ) ?? null,
                              );
                            }}
                          >
                            <option value="">未选择教学义项（仅练英文）</option>
                            {candidate.dictionaryEntries.map((entry, position) => (
                              <option key={position} value={position}>
                                {entry.partOfSpeech} {entry.meaning} · {entry.source}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <small>未收录，可手动补充或仅练英文</small>
                        )}
                        <Field label="教学释义" error={readingFieldError(candidate, 'meaning')}>
                          <textarea
                            id={fieldId(candidate.id, 'meaning')}
                            className="input"
                            rows={2}
                            aria-label={`${candidate.english}教学释义`}
                            value={candidate.teachingMeaning ?? ''}
                            placeholder="可编辑本课教学释义"
                            onChange={(event) => {
                              setError('');
                              setReading(
                                (previous) =>
                                  previous?.map((item) =>
                                    item.id === candidate.id
                                      ? updateReadingMeaning(item, event.target.value)
                                      : item,
                                  ) ?? null,
                              );
                            }}
                          />
                        </Field>
                        <MeaningSourceBadges
                          source={candidate.meaningSource}
                          confirmed={candidate.selectedDictionaryEntry !== undefined}
                        />
                        <details open={expandedProperties.includes(candidate.id)}>
                          <summary
                            onClick={(event) => {
                              event.preventDefault();
                              toggleProperties(candidate.id);
                            }}
                          >
                            词性、单元与标签
                            {['partOfSpeech', 'unit', 'tags'].some((field) =>
                              readingFieldError(candidate, field),
                            ) && (
                              <span className="error-text">
                                {' '}
                                ·{' '}
                                {
                                  ['partOfSpeech', 'unit', 'tags'].filter((field) =>
                                    readingFieldError(candidate, field),
                                  ).length
                                }{' '}
                                项错误
                              </span>
                            )}
                          </summary>
                          {expandedProperties.includes(candidate.id) && (
                            <div className="stack-sm">
                              <InputField
                                label="词性"
                                id={fieldId(candidate.id, 'partOfSpeech')}
                                aria-label={`${candidate.english}教学词性`}
                                value={candidate.teachingPartOfSpeech ?? ''}
                                error={readingFieldError(candidate, 'partOfSpeech')}
                                onChange={(event) =>
                                  patchReading(
                                    candidate.id,
                                    updateReadingMeaning(
                                      candidate,
                                      candidate.teachingMeaning ?? '',
                                      event.target.value,
                                    ),
                                  )
                                }
                              />
                              <InputField
                                label="单元"
                                id={fieldId(candidate.id, 'unit')}
                                aria-label={`${candidate.english}单元`}
                                value={candidate.unit ?? ''}
                                error={readingFieldError(candidate, 'unit')}
                                onChange={(event) =>
                                  patchReading(candidate.id, { unit: event.target.value })
                                }
                              />
                              <TeachingTagsField
                                id={fieldId(candidate.id, 'tags')}
                                value={candidate.tags}
                                error={readingFieldError(candidate, 'tags')}
                                onChange={(tags) => patchReading(candidate.id, { tags })}
                              />
                            </div>
                          )}
                        </details>
                        {candidate.dictionaryEntries.length > 0 && (
                          <details>
                            <summary>完整候选与来源</summary>
                            {candidate.dictionaryEntries.map((entry, position) => (
                              <div key={position} className="stack-sm">
                                <p>
                                  {entry.partOfSpeech} {entry.meaning}
                                </p>
                                <MeaningSourceBadges source={dictionaryMeaningSource(entry)} />
                                <small>
                                  {entry.source} · {entry.sourceVersion}
                                </small>
                              </div>
                            ))}
                          </details>
                        )}
                      </td>
                      <td className="review-source">
                        <small>
                          {candidate.occurrences.length} 次<br />第 {candidate.occurrences[0].line}{' '}
                          行
                        </small>
                        <details>
                          <summary>查看原文</summary>
                          {candidate.occurrences.map((occurrence, position) => (
                            <p key={position}>
                              {text.slice(Math.max(0, occurrence.start - 24), occurrence.end + 24)}
                            </p>
                          ))}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {error && (
        <div ref={errorSummary} tabIndex={-1} className="error-summary">
          <Notice tone="error" role="alert">
            {error}
            {submitIssues.map((issue, index) => (
              <Button
                key={`${issue.objectId}-${issue.field}-${index}`}
                variant="text"
                onClick={() => locateIssue(issue)}
              >
                定位：{issue.message}
              </Button>
            ))}
          </Notice>
        </div>
      )}
      {(preview || reading) && (
        <>
          <div className="row spread import-confirm-bar">
            <div className="row">
              <Button
                onClick={() =>
                  reading
                    ? setReading(
                        (previous) =>
                          previous?.map((item) =>
                            readingOnPage.some((candidate) => candidate.id === item.id)
                              ? { ...item, selected: true }
                              : item,
                          ) ?? null,
                      )
                    : setExcluded((previous) =>
                        previous.filter((row) => !rowsOnPage.some((item) => item.row === row)),
                      )
                }
              >
                全选本页
              </Button>
              <Button
                onClick={() =>
                  reading
                    ? setReading(
                        (previous) =>
                          previous?.map((item) => ({ ...item, selected: false })) ?? null,
                      )
                    : setExcluded(preview?.rows.map((row) => row.row) ?? [])
                }
              >
                清空选择
              </Button>
              <small>
                已选 {selectedCount} 项
                {selectedCount > visibleSelected &&
                  ` · 其他页或隐藏项 ${selectedCount - visibleSelected} 项`}
              </small>
            </div>
            <div className="row" hidden={pageCount === 1}>
              <Button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>
                上一页
              </Button>
              <small>
                第 {page + 1} / {pageCount} 页
              </small>
              <Button
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
      <Modal
        open={pendingMode !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMode(null);
        }}
        title="切换材料类型？"
        description="原文会保留，当前校对修改、词义选择和勾选范围将清除，需要重新整理。"
        small
        footer={
          <>
            <Button data-modal-safe-action onClick={() => setPendingMode(null)}>
              保留当前校对
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                // This is the only destructive switch boundary. Cancel never
                // changes source identity or review state; confirmation also
                // invalidates any late file read through resetPastedSource.
                if (pendingMode === null) return;
                setMode(pendingMode);
                resetPastedSource(pendingMode === 'reading' ? '阅读文本' : '粘贴词表');
                setPendingMode(null);
              }}
            >
              确认切换
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </fieldset>
  );
}
