/**
 * 本地词表的解析、列映射和校对。解析不等于接受建议：未知义项保持为空，
 * 重复只提示不合并，英文及教师提供的义项始终保留原始来源。
 * @author ahui
 */
import type { TeachingEntry, ValidationIssue } from '../types';
import type {
  ColumnMapping,
  ImportPreview,
  MaterialColumnPurpose,
  MaterialRow,
  ParseOptions,
} from './types';

const MAX_TEXT_CHARACTERS = 20_000;
/** 材料集和文件预览的硬上限；单课默认采用更小的 100 条范围。 */
export const MAX_MATERIAL_ENTRIES = 2_000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const FIELD_NAMES = ['english', 'meaning', 'partOfSpeech', 'tags', 'unit', 'priority'] as const;

/** 整理检索空白而不改写大小写、连字符或撇号；配音及显示不能使用小写检索键。 */
export function normalizeTeachingText(value: string): string {
  return value
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

/**
 * 按独立标签规则整理输入；只以中英文逗号分隔，完全相同项去重并保留首次顺序。
 * @param value 编辑框原始文本或已存标签；不截断超限值，供调用方校验并保留输入。
 * @returns 已去首尾空白和空项的标签，保留大小写与标签内部文本。
 */
export function normalizeTeachingTags(value: string | readonly string[]): string[] {
  const parts = typeof value === 'string' ? value.split(/[,，]/u) : value;
  return [...new Set(parts.map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * 在教师确认/保存时统一教学字段；编辑中的原始输入仍由各表单保留。
 * @param entry 当前内容副本，可以携带游戏字段；这些字段和来源快照均保持原值。
 * @returns 仅规范化空白与标签的新对象，不截断或默默修复越界内容。
 */
export function normalizeTeachingEntry<T extends TeachingEntry>(entry: T): T {
  return {
    ...entry,
    english: normalizeTeachingText(entry.english),
    meaning: normalizeTeachingText(entry.meaning),
    partOfSpeech: entry.partOfSpeech?.trim(),
    unit: entry.unit?.trim(),
    tags: entry.tags ? normalizeTeachingTags(entry.tags) : undefined,
  };
}

/**
 * 按用户选择的编码解码文本；UTF-8 错误不能悄悄成为替换字符。
 * @param bytes 原始 CSV/TXT 字节，文件大小由读取入口限制。
 * @param encoding 首选 UTF-8，教师预览后可切换 GB18030。
 * @returns 保留换行的原文，UTF-8 BOM 被解码器正常移除。
 * @throws TypeError 编码错误或当前运行环境不支持所选编码。
 */
export function decodeMaterialText(
  bytes: Uint8Array,
  encoding: 'utf-8' | 'gb18030' = 'utf-8',
): string {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/**
 * 解析 RFC 4180 风格分隔文本，支持引号内分隔符、换行与双引号转义。
 * @param text 原始文本；不执行公式或链接。
 * @param delimiter CSV 使用逗号；词表粘贴使用 Tab。
 * @returns 按源顺序返回全部行；末尾空行不额外生成空词。
 * @throws Error 引号不配对或引号后混入非分隔字符时拒绝猜测列位置。
 */
export function parseDelimitedRows(text: string, delimiter: ',' | '\t' = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        value += character;
      }
      continue;
    }
    if (character === delimiter || character === '\r' || character === '\n') {
      row.push(value);
      value = '';
      closedQuote = false;
      if (character !== delimiter) {
        rows.push(row);
        row = [];
        if (character === '\r' && text[index + 1] === '\n') index += 1;
      }
    } else if (character === '"') {
      if (value.length !== 0 || closedQuote)
        throw new Error('引号必须从字段开头开始，请检查分隔格式。');
      quoted = true;
    } else {
      if (closedQuote && character.trim() !== '') throw new Error('闭合引号后出现了额外字符。');
      if (!closedQuote) value += character;
    }
  }
  if (quoted) throw new Error('存在未闭合的引号，请修正后重新预览。');
  if (value.length > 0 || row.length > 0 || closedQuote) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

/** 猜测常见表头仅作为映射初值；UI 必须展示映射让教师确认。 */
export function suggestColumnMapping(header: string[]): ColumnMapping {
  const aliases: Record<keyof ColumnMapping, string[]> = {
    english: ['英文', '单词', '词汇', 'english', 'word', 'phrase'],
    meaning: ['中文释义', '中文', '释义', '词义', 'meaning', 'translation'],
    partOfSpeech: ['词性', 'pos', 'partofspeech', 'part of speech'],
    tags: ['标签', 'tags', 'tag'],
    unit: ['单元', 'unit'],
    priority: ['重点', '重点标记', 'priority'],
  };
  const mapping: ColumnMapping = { english: 0 };
  for (const field of FIELD_NAMES) {
    const column = header.findIndex((cell) => aliases[field].includes(cell.trim().toLowerCase()));
    if (column >= 0) mapping[field] = column;
  }
  return mapping;
}

/**
 * 仅为无歧义的双列中英词表提供建议，不自动采用、不推断其他字段。
 * 全部非空行都须满足同一语言分布；空释义或混合列交回教师逐列确认。
 */
export function suggestBilingualColumns(rows: string[][]): MaterialColumnPurpose[] | undefined {
  const values = rows.filter((row) => row.some((cell) => cell.trim()));
  if (!values.length || values.some((row) => row.length !== 2)) return undefined;
  const english = (value: string) => /[a-z]/iu.test(value) && !/\p{Script=Han}/u.test(value);
  const chinese = (value: string) => /\p{Script=Han}/u.test(value);
  if (values.every((row) => english(row[0]) && chinese(row[1]))) return ['english', 'meaning'];
  if (values.every((row) => chinese(row[0]) && english(row[1]))) return ['meaning', 'english'];
  return undefined;
}

/**
 * Suggest only content-supported columns, without assigning unknown text to tags
 * or ignoring it. Sparse optional columns are allowed. Competing language columns
 * stay unresolved; a Chinese label column must not silently become the meaning.
 * The UI merges suggestions only into unassigned fields after teacher acceptance.
 */
export function suggestMaterialColumns(rows: string[][]): MaterialColumnPurpose[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const columns = Array.from({ length: width }, (_, column) =>
    rows.map((row) => (row[column] ?? '').trim()).filter(Boolean),
  );
  const result: MaterialColumnPurpose[] = columns.map((values) => {
    if (!values.length) return '';
    if (
      values.every((value) =>
        /^(?:n|v|vi|vt|adj|adv|prep|pron|conj|interj|num|art|phr)\.$/iu.test(value),
      )
    )
      return 'partOfSpeech';
    if (values.every((value) => /^(?:unit\s+\d+|第[一二三四五六七八九十\d]+单元)$/iu.test(value)))
      return 'unit';
    if (values.every((value) => /^(?:是|否)$/u.test(value))) return 'priority';
    return '';
  });
  for (const [purpose, matches] of [
    ['english', (value: string) => /[a-z]/iu.test(value) && !/\p{Script=Han}/u.test(value)],
    ['meaning', (value: string) => /\p{Script=Han}/u.test(value)],
  ] as const) {
    const candidates = columns
      .map((values, column) =>
        !result[column] && values.length > 0 && values.every(matches) ? column : -1,
      )
      .filter((column) => column >= 0);
    if (candidates.length === 1) result[candidates[0]] = purpose;
  }
  // Two POS/unit/priority columns are equally plausible; never choose the first.
  return result.map((purpose) =>
    purpose && result.filter((item) => item === purpose).length === 1 ? purpose : '',
  );
}

/**
 * 将教师逐列确认的用途转换为字段映射；不能依据列数或内容猜测旧模板。
 * @param purposes 与源列一一对应的选择；ignore 为明确放弃，空值仍须教师处理。
 * @returns 英文恰有一列、其他字段最多一列的映射，不包含明确忽略的来源列。
 * @throws Error 存在未指定列、重复用途或缺少英文列时阻止导入，保留原表供修改。
 */
export function createMaterialColumnMapping(purposes: MaterialColumnPurpose[]): ColumnMapping {
  const mapping: Partial<ColumnMapping> = {};
  purposes.forEach((purpose, column) => {
    if (!purpose) throw new Error(`请确认第 ${column + 1} 列用途，或明确选择“忽略”。`);
    if (purpose === 'ignore') return;
    if (mapping[purpose] !== undefined)
      throw new Error(`第 ${column + 1} 列用途重复，每个教学字段只能对应一列。`);
    mapping[purpose] = column;
  });
  if (mapping.english === undefined) throw new Error('请将且仅将一列指定为英文。');
  return mapping as ColumnMapping;
}

/**
 * 将文件读取器返回的二维表格映射成校对预览，可用于 XLSX 工作表及 CSV。
 * @param inputRows 按源顺序保留的字符串字段，表头由 headerRows 明确排除。
 * @param options 列用途、表头行数和来源；默认英文第 1 列、释义第 2 列。
 * @returns 全部非空源行与错误、疑似重复分组；不静默截到 100 条。
 */
export function mapMaterialRows(inputRows: string[][], options: ParseOptions = {}): ImportPreview {
  const mapping = options.mapping ?? { english: 0, meaning: 1 };
  const sourceName = options.sourceName ?? '粘贴词表';
  const headerRows = options.headerRows ?? 0;
  if (!Number.isInteger(headerRows) || headerRows < 0) throw new Error('表头行数必须为非负整数。');
  if (!Number.isInteger(mapping.english) || mapping.english < 0)
    throw new Error('英文必须映射到有效列。');
  for (const column of Object.values(mapping)) {
    // 可选字段明确选“不使用”时会保留 undefined；这不应使仅英文练习无法导入。
    if (column === undefined) continue;
    if (!Number.isInteger(column) || column < 0) throw new Error('列用途必须指向有效列。');
  }
  const mappedColumns = Object.values(mapping).filter((column) => column !== undefined);
  if (new Set(mappedColumns).size !== mappedColumns.length)
    throw new Error('列用途重复，同一来源列不能映射为多个教学字段。');
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const rows: MaterialRow[] = [];
  const duplicates = new Map<string, number[]>();
  inputRows.forEach((rawFields, index) => {
    if (index < headerRows || rawFields.every((field) => field.trim() === '')) return;
    if (rows.length >= MAX_MATERIAL_ENTRIES)
      throw new Error('材料集最多 2,000 条，请缩减或拆分原材料后重新预览；不会截取部分内容。');
    const rowNumber = index + 1;
    const field = (name: keyof ColumnMapping) => {
      const column = mapping[name];
      return column === undefined ? '' : normalizeTeachingText(rawFields[column] ?? '');
    };
    const entry: TeachingEntry = {
      id: idFactory(),
      english: field('english'),
      meaning: field('meaning'),
      partOfSpeech: field('partOfSpeech'),
      priority: field('priority') === '是',
      tags: normalizeTeachingTags(field('tags')),
      unit: field('unit'),
      source: { name: sourceName, original: rawFields[mapping.english] ?? '', line: rowNumber },
      confirmed: false,
    };
    entry.entryType = entry.english.split(/\s+/u).length >= 2 ? 'phrase' : 'word';
    const issues = validateTeachingEntry(entry);
    const priority = field('priority');
    if (priority && priority !== '是' && priority !== '否') {
      issues.push({
        code: 'INVALID_PRIORITY',
        severity: 'error',
        field: 'priority',
        objectId: entry.id,
        message: '重点标记请填写“是”或“否”。',
      });
    }
    const duplicateKey = entry.english.toLowerCase();
    if (duplicateKey)
      duplicates.set(duplicateKey, [...(duplicates.get(duplicateKey) ?? []), rowNumber]);
    rows.push({ entry, row: rowNumber, rawFields: [...rawFields], issues, duplicateKey });
  });
  return {
    sourceName,
    originalText: options.originalText,
    rows,
    issues: rows.flatMap((row) => row.issues),
    duplicateGroups: [...duplicates.values()].filter((group) => group.length > 1),
  };
}

/** 粘贴词表不受 CSV 引号规则干扰，英文缩写或引号本身保留为教学文本。 */
export function parseVocabularyText(text: string, options: ParseOptions = {}): ImportPreview {
  if ([...text].length > MAX_TEXT_CHARACTERS)
    throw new Error('每次粘贴最多 20,000 字符，请分批导入。');
  const rows = text
    .replace(/^\uFEFF/u, '')
    .split(/\r\n|\r|\n/u)
    .map((line) => line.split('\t'));
  return mapMaterialRows(rows, { ...options, originalText: text });
}

/** CSV 保留引号内原文；字段换行只在教学字段中整理为空格。 */
export function parseCsvText(text: string, options: ParseOptions = {}): ImportPreview {
  return mapMaterialRows(parseDelimitedRows(text.replace(/^\uFEFF/u, '')), {
    ...options,
    originalText: text,
  });
}

/**
 * 校验可发布的教学字段。无义项仅提醒，不能用猜测释义阻塞英语练习。
 * @param entry 当前教学条目，字符数按 Unicode 码点计算。
 * @returns 带字段及对象定位的错误和提醒；此函数不更改输入。
 */
export function validateTeachingEntry(entry: TeachingEntry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report = (field: string, message: string, severity: 'error' | 'warning' = 'error') => {
    issues.push({
      code: severity === 'error' ? 'INVALID_FIELD' : 'MEANING_OPTIONAL',
      severity,
      field,
      objectId: entry.id,
      message,
    });
  };
  const englishLength = [...entry.english.trim()].length;
  if (englishLength === 0 || englishLength > 120) report('english', '英文应为 1～120 字符。');
  if ([...entry.meaning.trim()].length > 200) report('meaning', '中文释义最多 200 字符。');
  if ([...(entry.partOfSpeech ?? '').trim()].length > 40)
    report('partOfSpeech', '词性最多 40 字符。');
  if ([...(entry.unit ?? '').trim()].length > 80) report('unit', '单元最多 80 字符。');
  const tags = normalizeTeachingTags(entry.tags ?? []);
  if (tags.length > 10) report('tags', '标签最多 10 个。');
  if (tags.some((tag) => [...tag].length > 24)) report('tags', '每个标签最多 24 字符。');
  for (const field of ['english', 'meaning', 'partOfSpeech', 'unit'] as const) {
    if (CONTROL_CHARACTERS.test(entry[field] ?? ''))
      report(field, '字段中含不可见控制字符，请删除后重试。');
  }
  if (entry.tags?.some((tag) => CONTROL_CHARACTERS.test(tag)))
    report('tags', '标签含不可见控制字符，请删除后重试。');
  if (typeof entry.priority !== 'boolean') report('priority', '请明确选择是否为重点词。');
  if (!entry.meaning) report('meaning', '可补充教学释义；仅英文练习可以继续。', 'warning');
  return issues;
}

/** 字段校验由当前值重算；源格式错误必须在对应字段明确修正后才能解除。 */
function currentMaterialIssues(row: MaterialRow): ValidationIssue[] {
  return [
    ...validateTeachingEntry(row.entry),
    ...row.issues.filter(
      (issue) => issue.code !== 'INVALID_FIELD' && issue.code !== 'MEANING_OPTIONAL',
    ),
  ];
}

/**
 * 校对一行并刷新当前错误，保留原始字段、来源行号及未修正的源格式问题。
 * @param row 当前预览行；此函数不修改传入对象。
 * @param patch 教师本次明确编辑的字段。非法“重点”源值只有显式设置布尔值才消除错误。
 * @returns 修正后的行，英文改动重新计算单词/短语默认标记；手选标记可在同次 patch 指定。
 */
export function updateMaterialRow(row: MaterialRow, patch: Partial<TeachingEntry>): MaterialRow {
  const entry = updateTeachingEntry(row.entry, patch);
  const pendingIssues = row.issues.filter(
    (issue) =>
      !(
        issue.code === 'INVALID_PRIORITY' &&
        Object.hasOwn(patch, 'priority') &&
        typeof patch.priority === 'boolean'
      ),
  );
  const next = {
    ...row,
    entry,
    issues: pendingIssues,
    duplicateKey: normalizeTeachingText(entry.english).toLowerCase(),
  };
  return { ...next, issues: currentMaterialIssues(next) };
}

/** 材料和常用词共用的教师编辑规则：保留身份与来源，英文变化刷新短语标记。 */
export function updateTeachingEntry(
  previous: TeachingEntry,
  patch: Partial<TeachingEntry>,
): TeachingEntry {
  const entry = { ...previous, ...patch, id: previous.id };
  if (Object.hasOwn(patch, 'english') && !Object.hasOwn(patch, 'entryType')) {
    entry.entryType =
      normalizeTeachingText(entry.english).split(/\s+/u).length >= 2 ? 'phrase' : 'word';
  }
  // 手工改写不丢失依据：原候选仍可查看，教学值明确标记为教师修订。
  if (
    !Object.hasOwn(patch, 'meaningSource') &&
    (['english', 'meaning', 'partOfSpeech'] as const).some(
      (key) => Object.hasOwn(patch, key) && patch[key] !== previous[key],
    ) &&
    entry.meaningSource
  ) {
    entry.meaningSource = { ...entry.meaningSource, teacherRevised: true };
  }
  return entry;
}

/**
 * 校对后同步页级问题和疑似重复分组，避免英文已经修正而旧分组/提示继续显示。
 * @param preview 保留的来源与原文。
 * @param rows 当前全部行，排除状态由调用方另存；默认复核原预览全部行。
 * @returns 新预览，不删行、不合并大小写或不同义项。
 */
export function rebuildImportPreview(preview: ImportPreview, rows = preview.rows): ImportPreview {
  const duplicates = new Map<string, number[]>();
  const refreshed = rows.map((row) => {
    const next = updateMaterialRow(row, {});
    if (next.duplicateKey)
      duplicates.set(next.duplicateKey, [...(duplicates.get(next.duplicateKey) ?? []), next.row]);
    return next;
  });
  return {
    ...preview,
    rows: refreshed,
    issues: refreshed.flatMap((row) => row.issues),
    duplicateGroups: [...duplicates.values()].filter((group) => group.length > 1),
  };
}

/**
 * 校验本次确认的数量，不静默截断；上限由材料集或课件入口明确传入。
 * @param count 本次实际选中数量，必须为整数。
 * @param maxEntries 默认单课 100；材料库可指定最多 2,000。
 * @throws Error 配置无效或选中数量超出范围，调用方应保留原输入供缩减。
 */
export function validateMaterialEntryLimit(count: number, maxEntries = 100): void {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_MATERIAL_ENTRIES)
    throw new Error('材料确认上限必须为 1～2,000 的整数。');
  if (!Number.isInteger(count) || count < 1 || count > maxEntries)
    throw new Error(
      `${maxEntries === 100 ? '单词节拍每课' : '本次材料'}需要 1～${maxEntries.toLocaleString('en-US')} 条，请明确选择范围。`,
    );
}

/** 校对确认时才应用本次范围上限；材料库传入 2,000，课件入口默认 100。 */
export function confirmImportedEntries(
  preview: ImportPreview,
  excludedRows: number[] = [],
  maxEntries = 100,
): TeachingEntry[] {
  const excluded = new Set(excludedRows);
  const rows = preview.rows.filter((row) => !excluded.has(row.row));
  validateMaterialEntryLimit(rows.length, maxEntries);
  if (rows.some((row) => currentMaterialIssues(row).some((issue) => issue.severity === 'error'))) {
    throw new Error('请修正或明确排除有错误的行后再确认。');
  }
  return rows.map((row) => ({ ...normalizeTeachingEntry(row.entry), confirmed: true }));
}
