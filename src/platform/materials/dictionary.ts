/**
 * 高中词库与教师常用词的离线检索。来源标签与原始义项一起返回，
 * 不根据阅读上下文臆测正确词义，也不把检索命中当作教师已确认。
 * @author ahui
 */
import type { MaterialAnalysis, TeachingEntry } from '../types';
import functionWords from '../../../resources/dictionary/function-words.json';
import { AI_RULES } from '../../shared/ai/catalog';
import type { DictionaryEntry, MaterialRow, ReadingCandidate, ReadingOccurrence } from './types';
import {
  MAX_MATERIAL_ENTRIES,
  normalizeTeachingText,
  updateMaterialRow,
  validateMaterialEntryLimit,
  validateTeachingEntry,
} from './parser';

/** 索引只负责检索：教学显示仍使用原文，大小写不进入自动改写流程。 */
export interface DictionaryIndex {
  entries: DictionaryEntry[];
  byText: Map<string, DictionaryEntry[]>;
  byForm: Map<string, DictionaryEntry[]>;
  maximumPhraseWords: number;
  /** 构建索引时固定的规则和来源，不随之后切换词库改写既有候选。 */
  analysis: MaterialAnalysis;
}

/** 清单与软件一起离线分发；只控制折叠，不能因未收录或低频而删掉候选。 */
const FUNCTION_WORDS = new Set(functionWords.words);
/** V1 明确限制相邻词只隔空格/Tab；变更匹配算法时单独提升此版本。 */
const MATERIAL_MATCH_RULE_VERSION = 1;
const dictionaryKey = (value: string) => normalizeTeachingText(value).toLowerCase();

/**
 * 为词库构建线性大小的索引；教师常用词放在前面，所有同形多义候选均保留。
 * @param entries 随安装包携带的有来源词库。
 * @param teacherEntries 教师主动保存的常用词，不能来自学生画像。
 * @returns 文本、词形和短语最大长度索引，不更改传入数据。
 */
export function createDictionaryIndex(
  entries: DictionaryEntry[],
  teacherEntries: TeachingEntry[] = [],
): DictionaryIndex {
  const teacherDictionary: DictionaryEntry[] = teacherEntries.map((entry) => ({
    english: entry.english,
    meaning: entry.meaning,
    partOfSpeech: entry.partOfSpeech ?? '',
    forms: [],
    tags: entry.tags ?? [],
    source: '教师常用词库',
    sourceVersion: 'teacher',
    reviewStatus: 'teacher-confirmed',
    meaningSource: structuredClone(entry.meaningSource),
    priority: entry.priority,
  }));
  const allEntries = [...teacherDictionary, ...entries];
  const byText = new Map<string, DictionaryEntry[]>();
  const byForm = new Map<string, DictionaryEntry[]>();
  let maximumPhraseWords = 1;
  for (const entry of allEntries) {
    const key = dictionaryKey(entry.english);
    if (!key) continue;
    byText.set(key, [...(byText.get(key) ?? []), entry]);
    maximumPhraseWords = Math.max(maximumPhraseWords, key.split(' ').length);
    for (const form of entry.forms) {
      const formKey = dictionaryKey(form);
      if (formKey && formKey !== key) byForm.set(formKey, [...(byForm.get(formKey) ?? []), entry]);
    }
  }
  const dictionaryVersions = new Map<string, { name: string; version: string }>();
  for (const entry of allEntries) {
    const source = { name: entry.source, version: entry.sourceVersion };
    dictionaryVersions.set(JSON.stringify(source), source);
  }
  return {
    entries: allEntries,
    byText,
    byForm,
    maximumPhraseWords,
    analysis: {
      ruleId: AI_RULES.material,
      ruleVersion: MATERIAL_MATCH_RULE_VERSION,
      functionWordsVersion: functionWords.version,
      dictionaryVersions: [...dictionaryVersions.values()],
    },
  };
}

/** 返回直接命中与词形候选；教师值排前面，但不自动选定多义词。 */
export function lookupDictionary(index: DictionaryIndex, english: string): DictionaryEntry[] {
  const key = dictionaryKey(english);
  const candidates = [...(index.byText.get(key) ?? []), ...(index.byForm.get(key) ?? [])];
  const seen = new Set<string>();
  return candidates.filter((entry) => {
    const identity = JSON.stringify([
      entry.english,
      entry.partOfSpeech,
      entry.meaning,
      entry.source,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** 有限索引搜索只返回真实词库条目；空关键词不生成或联网请求词义。 */
export function searchDictionary(
  index: DictionaryIndex,
  query: string,
  limit = 50,
): DictionaryEntry[] {
  const key = dictionaryKey(query);
  if (!key) return [];
  const exact = lookupDictionary(index, key);
  const prefix = index.entries.filter((entry) => dictionaryKey(entry.english).startsWith(key));
  const matches = [
    ...exact,
    ...prefix,
    ...index.entries.filter((entry) => entry.meaning.includes(query.trim())),
  ];
  const seen = new Set<DictionaryEntry>();
  return matches
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
}

/**
 * 从阅读文本提取可追溯候选，最长连续短语优先，内部单词折叠而不删除。
 * @param text 教师阅读原文，最多 20,000 个 Unicode 字符。
 * @param index 已加载的本地索引。
 * @param idFactory 测试可固定；生产使用 UUID。
 * @returns 按教师重点、高中命中、其他原词分组，组内按首次位置排序；默认不代教师勾选。
 */
export function parseReadingText(
  text: string,
  index: DictionaryIndex,
  idFactory = () => crypto.randomUUID(),
): ReadingCandidate[] {
  if ([...text].length > 20_000) throw new Error('阅读文本每次最多 20,000 字符，请分段选词。');
  const tokens = [...text.matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/gu)].map((match) => ({
    original: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const candidates = new Map<string, ReadingCandidate>();
  const append = (original: string, start: number, end: number, phraseId?: string) => {
    // 保留大小写作为候选身份，避免 US 与 us 因检索归一而被合并。
    const identity = normalizeTeachingText(original);
    const matches = lookupDictionary(index, identity);
    const occurrence: ReadingOccurrence = {
      start,
      end,
      original: text.slice(start, end),
      line: text.slice(0, start).split(/\r\n|\r|\n/u).length,
    };
    let candidate = candidates.get(identity);
    if (!candidate) {
      if (candidates.size >= MAX_MATERIAL_ENTRIES)
        throw new Error('阅读候选最多 2,000 条，请分段选词；不会截取部分内容。');
      const isPriority = matches.some((entry) => entry.priority);
      candidate = {
        id: idFactory(),
        english: identity,
        entryType: identity.includes(' ') ? 'phrase' : 'word',
        group: isPriority ? 'priority' : matches.length > 0 ? 'high-school' : 'other',
        functionWord:
          !isPriority && !identity.includes(' ') && FUNCTION_WORDS.has(identity.toLowerCase()),
        occurrences: [],
        dictionaryEntries: matches,
        selected: false,
        hiddenByPhrase: phraseId,
        lemma: index.byText.has(dictionaryKey(identity)) ? undefined : matches[0]?.english,
        analysis: structuredClone(index.analysis),
      };
      candidates.set(identity, candidate);
    } else if (!phraseId) {
      candidate.hiddenByPhrase = undefined;
    }
    candidate.occurrences.push(occurrence);
    return candidate;
  };
  for (let position = 0; position < tokens.length; position += 1) {
    const first = tokens[position];
    let phraseLength = 1;
    for (
      let length = Math.min(index.maximumPhraseWords, tokens.length - position);
      length >= 2;
      length -= 1
    ) {
      const portion = tokens.slice(position, position + length);
      const continuous = portion.every(
        (token, offset) =>
          // 换行和句末标点是教学文本边界，不能经空白归一后拼成原文不存在的短语。
          offset === 0 || /^[ \t]+$/u.test(text.slice(portion[offset - 1].end, token.start)),
      );
      if (
        continuous &&
        index.byText.has(dictionaryKey(portion.map((token) => token.original).join(' ')))
      ) {
        phraseLength = length;
        break;
      }
    }
    if (phraseLength === 1) {
      append(first.original, first.start, first.end);
    } else {
      const last = tokens[position + phraseLength - 1];
      const phrase = append(text.slice(first.start, last.end), first.start, last.end);
      for (const token of tokens.slice(position, position + phraseLength))
        append(token.original, token.start, token.end, phrase.id);
      position += phraseLength - 1;
    }
  }
  const order = { priority: 0, 'high-school': 1, other: 2 };
  return [...candidates.values()].sort(
    (left, right) =>
      order[left.group] - order[right.group] ||
      left.occurrences[0].start - right.occurrences[0].start,
  );
}

/**
 * 明确接受或清空一个阅读候选义项，不改变词库候选顺序。
 * @param candidate 当前阅读候选，必须使用其自身提供的义项下标。
 * @param index 义项下标；null 表示仅练英文，清除此前选择。
 * @returns 新候选；未选中任何义项时不补入默认释义。
 * @throws Error 下标不指向实际候选时拒绝接受，防止旧选择套在新词库结果上。
 */
export function chooseReadingMeaning(
  candidate: ReadingCandidate,
  index: number | null,
): ReadingCandidate {
  if (index === null)
    return {
      ...candidate,
      selectedDictionaryEntry: undefined,
      teachingMeaning: '',
      teachingPartOfSpeech: '',
      meaningSource: undefined,
    };
  if (!Number.isInteger(index) || index < 0 || index >= candidate.dictionaryEntries.length) {
    throw new Error('该词义候选已不可用，请重新选择。');
  }
  const dictionaryEntry = candidate.dictionaryEntries[index];
  const meaning = normalizeTeachingText(dictionaryEntry.meaning);
  const partOfSpeech =
    candidate.teachingPartOfSpeech?.trim() &&
    (!candidate.meaningSource?.acceptedFields?.includes('partOfSpeech') ||
      candidate.meaningSource.teacherRevised)
      ? candidate.teachingPartOfSpeech
      : normalizeTeachingText(dictionaryEntry.partOfSpeech);
  return {
    ...candidate,
    selectedDictionaryEntry: index,
    teachingMeaning: meaning,
    teachingPartOfSpeech: partOfSpeech,
    meaningSource: {
      ...dictionaryMeaningSource(dictionaryEntry),
      teacherRevised:
        dictionaryEntry.meaningSource?.teacherRevised ||
        partOfSpeech !== normalizeTeachingText(dictionaryEntry.partOfSpeech),
      acceptedFields: completedMeaningFields(
        candidate.teachingMeaning,
        candidate.teachingPartOfSpeech,
        meaning,
        partOfSpeech,
        candidate.meaningSource?.acceptedFields,
      ),
    },
  };
}

/**
 * 只记录接受候选实际补齐的空字段，原有教师值或重复接受不能增加成果数量。
 * 已确认字段按集合保留，换选候选不把同一个字段重复计数，也不抹掉本次材料已有成果。
 */
function completedMeaningFields(
  previousMeaning: string | undefined,
  previousPartOfSpeech: string | undefined,
  meaning: string,
  partOfSpeech: string,
  previousAccepted: ('meaning' | 'partOfSpeech')[] = [],
): ('meaning' | 'partOfSpeech')[] {
  const fields = new Set(previousAccepted);
  if (!previousMeaning?.trim() && meaning) fields.add('meaning');
  if (!previousPartOfSpeech?.trim() && partOfSpeech) fields.add('partOfSpeech');
  return [...fields];
}

/** 记录完整原候选，教学字段的整理或后续改写不改变该快照。 */
export function dictionaryMeaningSource(
  entry: DictionaryEntry,
): NonNullable<TeachingEntry['meaningSource']> {
  // 复用常用词仍保留其词库校对快照；旧接受计数属于原材料，不能带入本次补全成果。
  if (entry.reviewStatus === 'teacher-confirmed' && entry.meaningSource) {
    const source = structuredClone(entry.meaningSource);
    delete source.acceptedFields;
    return { ...source, candidateSource: 'common' };
  }
  return {
    name: entry.source,
    version: entry.sourceVersion,
    english: entry.english,
    originalMeaning: entry.meaning,
    originalPartOfSpeech: entry.partOfSpeech,
    teacherRevised: false,
    candidateSource: entry.reviewStatus === 'teacher-confirmed' ? 'common' : 'dictionary',
    ...(entry.reviewStatus === 'reviewed-sense' || entry.reviewStatus === 'reference'
      ? { reviewStatus: entry.reviewStatus }
      : {}),
  };
}

/** 显式接受词表候选；超长义项保留完整值和报错，供教师修订，绝不截断。 */
export function acceptMaterialMeaning(row: MaterialRow, candidate: DictionaryEntry): MaterialRow {
  const meaning = normalizeTeachingText(candidate.meaning);
  // 接受释义不连带覆盖教师已经填写的词性；候选原词性仍保存在来源快照中供查看。
  const partOfSpeech =
    row.entry.partOfSpeech?.trim() &&
    (!row.entry.meaningSource?.acceptedFields?.includes('partOfSpeech') ||
      row.entry.meaningSource.teacherRevised)
      ? row.entry.partOfSpeech
      : normalizeTeachingText(candidate.partOfSpeech);
  return updateMaterialRow(row, {
    meaning,
    partOfSpeech,
    confirmed: true,
    meaningSource: {
      ...dictionaryMeaningSource(candidate),
      teacherRevised:
        candidate.meaningSource?.teacherRevised ||
        partOfSpeech !== normalizeTeachingText(candidate.partOfSpeech),
      acceptedFields: completedMeaningFields(
        row.entry.meaning,
        row.entry.partOfSpeech,
        meaning,
        partOfSpeech,
        row.entry.meaningSource?.acceptedFields,
      ),
    },
  });
}

/**
 * 批量接受只适用于恰好一个、非空且满足教学字段限制的候选。
 * 多义候选即使部分超长也不能据此暗选另一义项；由教师逐项决定。
 */
export function getSingleAcceptableMeaning(
  candidates: DictionaryEntry[],
): DictionaryEntry | undefined {
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (candidate.reviewStatus !== 'reviewed-sense' && candidate.reviewStatus !== 'teacher-confirmed')
    return undefined;
  const entry: TeachingEntry = {
    id: 'candidate-check',
    english: candidate.english,
    meaning: normalizeTeachingText(candidate.meaning),
    partOfSpeech: normalizeTeachingText(candidate.partOfSpeech),
    priority: false,
  };
  return entry.meaning && !validateTeachingEntry(entry).some((issue) => issue.severity === 'error')
    ? candidate
    : undefined;
}

/**
 * 改写本课教学义项和可选词性；保留原候选快照及候选顺序。
 * @param candidate 当前候选，不会原地修改。
 * @param text 教师原始输入；上限在确认时校验，编辑中允许暂时超长。
 * @param partOfSpeech 本次明确编辑的词性；省略时保留当前教学词性。
 * @returns 教学值与修订标记已更新的新候选。
 */
export function updateReadingMeaning(
  candidate: ReadingCandidate,
  text: string,
  partOfSpeech?: string,
): ReadingCandidate {
  const changed =
    text !== candidate.teachingMeaning ||
    (partOfSpeech !== undefined && partOfSpeech !== candidate.teachingPartOfSpeech);
  return {
    ...candidate,
    teachingMeaning: text,
    teachingPartOfSpeech: partOfSpeech ?? candidate.teachingPartOfSpeech,
    meaningSource:
      candidate.meaningSource && changed
        ? { ...candidate.meaningSource, teacherRevised: true }
        : candidate.meaningSource,
  };
}

/**
 * 教师选中候选后转为课件条目；多义词未选择时保持空义项，最终由校对页确认。
 * @param candidates 勾选状态与教师选择的候选。
 * @param keepOccurrences 是否将重复出现位置逐一加入；默认每个候选只取首次。
 * @param maxEntries 默认单课 100；保存材料集时可指定最多 2,000。
 * @returns 恢复原文首次位置顺序的独立教学条目，重复位置具有不同标识。
 * @throws Error 选中内容为空、超过课件上限或含超长英文等非法字段时，保留预览供教师修正。
 */
export function selectedReadingEntries(
  candidates: ReadingCandidate[],
  keepOccurrences = false,
  maxEntries = 100,
): TeachingEntry[] {
  const selected = candidates.filter((candidate) => candidate.selected);
  const count = selected.reduce(
    (sum, candidate) =>
      sum +
      (keepOccurrences ? candidate.occurrences.length : Math.min(1, candidate.occurrences.length)),
    0,
  );
  validateMaterialEntryLimit(count, maxEntries);
  const entries = selected
    .flatMap((candidate) => {
      const occurrences = keepOccurrences
        ? candidate.occurrences
        : candidate.occurrences.slice(0, 1);
      const meaning =
        candidate.selectedDictionaryEntry === undefined
          ? undefined
          : candidate.dictionaryEntries[candidate.selectedDictionaryEntry];
      if (candidate.selectedDictionaryEntry !== undefined && !meaning)
        throw new Error(`${candidate.english} 的词义候选已不可用，请重新选择。`);
      return occurrences.map(
        (occurrence) =>
          ({
            id: crypto.randomUUID(),
            english: candidate.english,
            meaning: normalizeTeachingText(candidate.teachingMeaning ?? meaning?.meaning ?? ''),
            partOfSpeech: normalizeTeachingText(
              candidate.teachingPartOfSpeech ?? meaning?.partOfSpeech ?? '',
            ),
            priority: candidate.group === 'priority',
            unit: candidate.unit?.trim(),
            tags: candidate.tags,
            meaningSource:
              candidate.meaningSource ?? (meaning ? dictionaryMeaningSource(meaning) : undefined),
            entryType: candidate.entryType,
            confirmed: true,
            source: {
              name: '阅读选词',
              original: occurrence.original,
              line: occurrence.line,
              position: occurrence.start,
              analysis: candidate.analysis && structuredClone(candidate.analysis),
            },
          }) satisfies TeachingEntry,
      );
    })
    .sort((left, right) => (left.source?.position ?? 0) - (right.source?.position ?? 0));
  const invalid = entries
    .flatMap(validateTeachingEntry)
    .filter((issue) => issue.severity === 'error');
  if (invalid.length > 0) throw new Error(`请先修正选中词条：${invalid[0].message}`);
  return entries;
}
