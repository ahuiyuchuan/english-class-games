/** 教学材料导入和词库的公共结构；仅表示教学数据，不执行用户文本中的指令。 @author ahui */
import type { MaterialAnalysis, TeachingEntry, ValidationIssue } from '../types';

/** 导入页由教师将源列映射为教学字段；未映射的可选列保持为空。 */
export interface ColumnMapping {
  english: number;
  meaning?: number;
  partOfSpeech?: number;
  tags?: number;
  unit?: number;
  priority?: number;
}

/** 每个实际来源列均须明确选择用途或忽略；空字符串表示教师尚未确认该列。 */
export type MaterialColumnPurpose = keyof ColumnMapping | 'ignore' | '';

/** 单行保留原始字段和定位；格式错误不使其他有效行消失。 */
export interface MaterialRow {
  entry: TeachingEntry;
  row: number;
  rawFields: string[];
  issues: ValidationIssue[];
  duplicateKey?: string;
}

/** 校对预览默认包含全部行，教师明确排除后才减少教学范围。 */
export interface ImportPreview {
  sourceName: string;
  originalText?: string;
  rows: MaterialRow[];
  issues: ValidationIssue[];
  duplicateGroups: number[][];
}

/** ECDICT 固定提交的原始词义；教师保存词条可以复用相同结构且标记自己的来源。 */
export interface DictionaryEntry {
  english: string;
  meaning: string;
  partOfSpeech: string;
  forms: string[];
  tags: string[];
  source: string;
  sourceVersion: string;
  /** 缺省或 reference 仅作完整参考；只有独立校对义项 / 教师明确保存值参与单义批量接受。 */
  reviewStatus?: 'reviewed-sense' | 'reference' | 'teacher-confirmed';
  /** 常用词携带原始词库快照；教师确认不等于词库已经完成教学校对。 */
  meaningSource?: TeachingEntry['meaningSource'];
  /** 加工前的原始释文；校对后的独立义项仍可追溯词典原记录。 */
  referenceMeaning?: string;
  reviewVersion?: string;
  priority?: boolean;
}

/** 阅读中的字符位置按 JavaScript UTF-16 索引记录，回显时直接截取原文。 */
export interface ReadingOccurrence {
  start: number;
  end: number;
  line: number;
  original: string;
}

/** 候选分组只用于展示，进入课件时依原文位置排序；候选义项须由教师选择。 */
export interface ReadingCandidate {
  id: string;
  english: string;
  entryType: 'word' | 'phrase';
  group: 'priority' | 'high-school' | 'other';
  functionWord: boolean;
  occurrences: ReadingOccurrence[];
  dictionaryEntries: DictionaryEntry[];
  /** 仅由教师明确选择后记录；缺省表示仍未接受任何候选，绝不默认第一义项。 */
  selectedDictionaryEntry?: number;
  /** 教师接受后可独立改写的教学值；undefined 表示尚未接受或填写，空字符串表示明确仅英文。 */
  teachingMeaning?: string;
  teachingPartOfSpeech?: string;
  /** 阅读候选也可在确认前补充独立单元和标签，不从文章内容推断。 */
  unit?: string;
  tags?: string[];
  /** 保存原候选快照；教师改写教学字段时保留依据并标记修订。 */
  meaningSource?: TeachingEntry['meaningSource'];
  lemma?: string;
  selected: boolean;
  hiddenByPhrase?: string;
  /** 本次实际使用的整理依据，选择入课后随来源保存；旧候选可缺省。 */
  analysis?: MaterialAnalysis;
}

/** 解析选项允许测试固定标识；生产默认创建 UUID，绝不按英文将重复条目共用身份。 */
export interface ParseOptions {
  sourceName?: string;
  mapping?: ColumnMapping;
  headerRows?: number;
  idFactory?: () => string;
  originalText?: string;
}
