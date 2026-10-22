/** 材料校对与可解释候选规则回归；受控小词库不依赖外部数据变化。 @author ahui */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  confirmImportedEntries,
  createMaterialColumnMapping,
  decodeMaterialText,
  mapMaterialRows,
  normalizeTeachingTags,
  parseCsvText,
  parseDelimitedRows,
  parseVocabularyText,
  rebuildImportPreview,
  suggestColumnMapping,
  updateMaterialRow,
  validateTeachingEntry,
} from './parser';
import {
  chooseReadingMeaning,
  acceptMaterialMeaning,
  createDictionaryIndex,
  lookupDictionary,
  getSingleAcceptableMeaning,
  parseReadingText,
  selectedReadingEntries,
  updateReadingMeaning,
} from './dictionary';
import { getBuiltinDictionary } from './builtin';
import type { DictionaryEntry } from './types';
import { countConfirmedFields } from '../../shared/ai/completion-summary';
import { createWordBeatLesson } from '../../games/word-beat/rules';
import { copyLesson } from '../../games/word-beat/suggestions';

const vocabulary: DictionaryEntry[] = [
  {
    english: 'take',
    meaning: '受控义项',
    partOfSpeech: 'v.',
    forms: ['took', 'taken'],
    tags: ['gk'],
    source: 'fixture',
    sourceVersion: '1',
  },
  {
    english: 'part',
    meaning: '受控义项',
    partOfSpeech: 'n.',
    forms: ['parts'],
    tags: ['gk'],
    source: 'fixture',
    sourceVersion: '1',
  },
  {
    english: 'take part in',
    meaning: '参加',
    partOfSpeech: '',
    forms: [],
    tags: ['gk'],
    source: 'fixture',
    sourceVersion: '1',
  },
  {
    english: 'known',
    meaning: '已知的',
    partOfSpeech: 'adj.',
    forms: [],
    tags: ['gk'],
    source: 'fixture',
    sourceVersion: '1',
  },
];

describe('材料校对', () => {
  it('教学属性统一按Unicode码点校验，标签整理不截断或合并不同大小写', () => {
    expect(normalizeTeachingTags(' 高中，重点, ,高中,高中A,高中a ')).toEqual([
      '高中',
      '重点',
      '高中A',
      '高中a',
    ]);
    const valid = {
      id: 'limits',
      english: 'knowledge',
      meaning: '知识',
      priority: false,
      partOfSpeech: '𠮷'.repeat(40),
      unit: '𠮷'.repeat(80),
      tags: Array.from({ length: 10 }, (_, index) => String(index) + '𠮷'.repeat(23)),
    };
    expect(validateTeachingEntry(valid).filter((issue) => issue.severity === 'error')).toEqual([]);
    const invalid = {
      ...valid,
      partOfSpeech: '𠮷'.repeat(41),
      unit: '𠮷'.repeat(81),
      tags: [...valid.tags, '额外标签'],
    };
    expect(validateTeachingEntry(invalid).map((issue) => issue.field)).toEqual([
      'partOfSpeech',
      'unit',
      'tags',
    ]);
    const longTag = ['𠮷'.repeat(25)];
    expect(
      validateTeachingEntry({ ...valid, tags: longTag }).some((issue) => issue.field === 'tags'),
    ).toBe(true);
    expect(longTag[0]).toBe('𠮷'.repeat(25));
  });

  it('保留疑似重复、大小写、同词不同义项及原始位置', () => {
    const preview = parseVocabularyText('US\t美国\nus\t我们\ntake\t拿\ntake\t花费');
    expect(preview.rows.map((row) => row.entry.english)).toEqual(['US', 'us', 'take', 'take']);
    expect(preview.duplicateGroups).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(confirmImportedEntries(preview)).toHaveLength(4);
    expect(confirmImportedEntries(preview, [4])).toHaveLength(3);
    expect(new Set(preview.rows.map((row) => row.entry.id)).size).toBe(4);
  });

  it('CSV 支持引号内逗号、双引号与换行，教学字段整理而原始字段保留', () => {
    const preview = parseCsvText(
      '英文,中文释义,重点\r\n"take part in","参加,\n加入",是\r\nword,"一个""词""",否',
      {
        mapping: { english: 0, meaning: 1, priority: 2 },
        headerRows: 1,
      },
    );
    expect(preview.rows[0].entry.meaning).toBe('参加, 加入');
    expect(preview.rows[0].rawFields[1]).toBe('参加,\n加入');
    expect(preview.rows[0].entry.priority).toBe(true);
    expect(preview.rows[1].entry.meaning).toBe('一个"词"');
    expect(() => parseDelimitedRows('"未闭合,词')).toThrow('未闭合');
    expect(() => parseDelimitedRows('"词"extra,释义')).toThrow('额外字符');
  });

  it('来源列须逐一确认用途，明确忽略不冒充缺失映射，字段不能重复占用', () => {
    expect(() => createMaterialColumnMapping(['english', ''])).toThrow('第 2 列');
    expect(() => createMaterialColumnMapping(['english', 'english'])).toThrow('用途重复');
    expect(() => createMaterialColumnMapping(['ignore', 'meaning'])).toThrow('英文');
    expect(createMaterialColumnMapping(['meaning', 'english', 'ignore', 'unit'])).toEqual({
      meaning: 0,
      english: 1,
      unit: 3,
    });
    expect(() =>
      mapMaterialRows([['word', '释义']], { mapping: { english: 0, meaning: 0 } }),
    ).toThrow('同一来源列');
  });

  it('列映射与表头排除一致，错误定位不会移除其他行', () => {
    expect(suggestColumnMapping(['中文释义', '英文', '重点'])).toEqual({
      english: 1,
      meaning: 0,
      priority: 2,
    });
    const preview = mapMaterialRows(
      [
        ['释义', '英文', '重点'],
        ['测试', 'test', '是'],
        ['没有英文', '', 'true'],
      ],
      {
        mapping: { english: 1, meaning: 0, priority: 2 },
        headerRows: 1,
      },
    );
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[1].row).toBe(3);
    expect(preview.rows[1].issues.filter((issue) => issue.severity === 'error')).toHaveLength(2);
    expect(() => confirmImportedEntries(preview)).toThrow('修正');
    expect(confirmImportedEntries(preview, [3])[0].english).toBe('test');
  });

  it('空词义仅提醒；超长、控制字符、非法重点和课件上限不静默修正', () => {
    expect(confirmImportedEntries(parseVocabularyText('unlisted'))[0].meaning).toBe('');
    expect(parseVocabularyText('x'.repeat(121)).rows[0].issues[0].severity).toBe('error');
    expect(
      parseVocabularyText('ab\u0000cd').rows[0].issues.some((issue) => issue.severity === 'error'),
    ).toBe(true);
    expect(() =>
      confirmImportedEntries(
        parseVocabularyText(Array.from({ length: 101 }, (_, index) => `word${index}`).join('\n')),
      ),
    ).toThrow('1～100');
  });

  it('可选列明确不使用时保留英文且不误报映射；英文列仍须有效', () => {
    const preview = mapMaterialRows([['homework', '教师选择不导入的释义']], {
      mapping: { english: 0, meaning: undefined, unit: undefined },
    });
    expect(confirmImportedEntries(preview)[0]).toMatchObject({ english: 'homework', meaning: '' });
    expect(() => mapMaterialRows([['word']], { mapping: { english: Number.NaN } })).toThrow(
      '英文必须',
    );
    expect(() => mapMaterialRows([['word']], { mapping: { english: 0, meaning: -1 } })).toThrow(
      '列用途',
    );
  });

  it('严格 UTF-8 与 GB18030 可切换，不让解码错误伪装成教学文本', () => {
    expect(decodeMaterialText(new TextEncoder().encode('英文\t中文'))).toBe('英文\t中文');
    expect(decodeMaterialText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), 'gb18030')).toBe('中文');
    expect(() => decodeMaterialText(new Uint8Array([0xff]), 'utf-8')).toThrow();
  });

  it('校对重新检查当前字段，但非法重点必须明确修正，重复分组同步刷新', () => {
    const preview = mapMaterialRows(
      [
        ['', '', 'invalid'],
        ['take part in', '参加', '否'],
      ],
      { mapping: { english: 0, meaning: 1, priority: 2 } },
    );
    const englishCorrected = updateMaterialRow(preview.rows[0], { english: 'take part in' });
    expect(englishCorrected.entry.entryType).toBe('phrase');
    expect(
      englishCorrected.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.code),
    ).toEqual(['INVALID_PRIORITY']);
    expect(() => confirmImportedEntries({ ...preview, rows: [englishCorrected] })).toThrow('修正');
    const corrected = updateMaterialRow(englishCorrected, { priority: false, meaning: '本课义项' });
    const next = rebuildImportPreview(preview, [corrected, preview.rows[1]]);
    expect(next.issues.some((issue) => issue.severity === 'error')).toBe(false);
    expect(next.duplicateGroups).toEqual([[1, 2]]);
    expect(confirmImportedEntries(next)).toHaveLength(2);
    const separated = rebuildImportPreview(next, [
      updateMaterialRow(corrected, { english: 'test' }),
      preview.rows[1],
    ]);
    expect(separated.duplicateGroups).toEqual([]);
    expect(preview.rows[0].rawFields).toEqual(['', '', 'invalid']);
    expect(preview.rows[0].entry.english).toBe('');
  });

  it('确认入口复核当前值，不让绕过编辑助手的非法值或旧错误蒙混通过', () => {
    const preview = parseVocabularyText('test\t测试');
    const invalid = {
      ...preview,
      rows: [{ ...preview.rows[0], entry: { ...preview.rows[0].entry, english: '' } }],
    };
    expect(() => confirmImportedEntries(invalid)).toThrow('修正');
    const originallyInvalid = parseVocabularyText('\t测试');
    const corrected = {
      ...originallyInvalid,
      rows: [
        {
          ...originallyInvalid.rows[0],
          entry: { ...originallyInvalid.rows[0].entry, english: 'fixed' },
        },
      ],
    };
    expect(confirmImportedEntries(corrected)[0].english).toBe('fixed');
  });
});

describe('阅读与词形候选', () => {
  it('最长短语优先、内部词折叠，保留频次和真实位置而不自动选词', () => {
    const candidates = parseReadingText(
      'We take part in class. We take part in practice.',
      createDictionaryIndex(vocabulary),
    );
    const phrase = candidates.find((candidate) => candidate.english === 'take part in');
    expect(phrase?.occurrences).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.english === 'part')?.hiddenByPhrase).toBe(
      phrase?.id,
    );
    expect(candidates.every((candidate) => !candidate.selected)).toBe(true);
    expect(candidates.find((candidate) => candidate.english === 'We')?.functionWord).toBe(false);
    phrase!.selected = true;
    expect(selectedReadingEntries(candidates)).toHaveLength(1);
    const repeated = selectedReadingEntries(candidates, true);
    expect(repeated).toHaveLength(2);
    expect(repeated[0].source?.position).toBe(3);
    expect(repeated[0].id).not.toBe(repeated[1].id);
  });

  it('词形仅给原形提示，不改写原词；标点阻断连续短语', () => {
    const index = createDictionaryIndex(vocabulary);
    expect(lookupDictionary(index, 'took')[0].english).toBe('take');
    const took = parseReadingText('She took a well-known route. take, part in', index);
    expect(took.find((candidate) => candidate.english === 'took')?.lemma).toBe('take');
    expect(took.find((candidate) => candidate.english === 'well-known')?.entryType).toBe('word');
    expect(took.some((candidate) => candidate.english === 'take part in')).toBe(false);
    expect(took.find((candidate) => candidate.english === 'route')?.dictionaryEntries).toEqual([]);
  });

  it.each([
    'take. Part in',
    'take, part in',
    'take\npart in',
    'take\r\npart in',
    'take\u2028part in',
  ])('短语不越过标点和换行，仍保留各词真实位置：%s', (text) => {
    const candidates = parseReadingText(text, createDictionaryIndex(vocabulary));
    expect(candidates.some((candidate) => candidate.entryType === 'phrase')).toBe(false);
    expect(candidates.map((candidate) => candidate.english).sort()).toEqual(
      text.match(/[A-Za-z]+/gu)!.sort(),
    );
    expect(candidates.every((candidate) => !candidate.selected)).toBe(true);
    for (const candidate of candidates) {
      for (const occurrence of candidate.occurrences) {
        expect(text.slice(occurrence.start, occurrence.end)).toBe(occurrence.original);
      }
    }
  });

  it('空格与Tab仍可匹配短语，连字符和两种撇号不被拆词', () => {
    const text = "take \t part in well-known don't teacher’s";
    const candidates = parseReadingText(text, createDictionaryIndex(vocabulary));
    expect(candidates.find((candidate) => candidate.english === 'take part in')?.entryType).toBe(
      'phrase',
    );
    for (const word of ['well-known', "don't", 'teacher’s']) {
      expect(candidates.find((candidate) => candidate.english === word)?.entryType).toBe('word');
    }
  });

  it('功能词只按V1发布清单折叠；教师重点可展开，未列词不得自行隐藏', () => {
    const listed =
      'a an the and or but if as at by for from in of on to with am is are was were be been being';
    const index = createDictionaryIndex(vocabulary, [
      { id: 'teacher-and', english: 'and', meaning: '和', priority: true },
    ]);
    const candidates = parseReadingText(`${listed} we have then knowledge`, index);
    expect(candidates.find((candidate) => candidate.english === 'and')?.functionWord).toBe(false);
    for (const word of listed.split(' ').filter((word) => word !== 'and')) {
      expect(candidates.find((candidate) => candidate.english === word)?.functionWord).toBe(true);
    }
    for (const word of ['we', 'have', 'then', 'knowledge']) {
      expect(candidates.find((candidate) => candidate.english === word)?.functionWord).toBe(false);
    }
    expect(candidates.every((candidate) => !candidate.selected)).toBe(true);
  });

  it('整理依据随确认条目保存，复制和后续词库切换不改写其来源快照', () => {
    const index = createDictionaryIndex(vocabulary);
    const candidate = { ...parseReadingText('take part in', index)[0], selected: true };
    expect(candidate.analysis).toEqual({
      ruleId: 'platform.material.match',
      ruleVersion: 1,
      functionWordsVersion: 1,
      dictionaryVersions: [{ name: 'fixture', version: '1' }],
    });
    const entry = selectedReadingEntries([candidate])[0];
    expect(entry.source?.analysis).toEqual(candidate.analysis);
    expect(entry.source?.analysis).not.toBe(candidate.analysis);
    const original = createWordBeatLesson([entry], { seed: 1 });
    const copied = copyLesson(original);
    expect(copied.gameData.segments[0].entries[0].source?.analysis).toEqual(candidate.analysis);
    index.analysis.dictionaryVersions[0].version = 'later';
    expect(entry.source?.analysis?.dictionaryVersions[0].version).toBe('1');
    expect(candidate.analysis?.dictionaryVersions[0].version).toBe('1');
  });

  it('教师常用词有来源并优先展示，但不会丢弃基础多义候选', () => {
    const index = createDictionaryIndex(vocabulary, [
      { id: 't', english: 'take', meaning: '本课义项', priority: true },
    ]);
    const matches = lookupDictionary(index, 'take');
    expect(matches[0].source).toBe('教师常用词库');
    expect(matches).toHaveLength(2);
    expect(parseReadingText('take', index)[0].group).toBe('priority');
  });

  it('只有显式选择才携带义项和来源，清空选择恢复仅英文且不重排候选', () => {
    const index = createDictionaryIndex(vocabulary, [
      { id: 't', english: 'take', meaning: '教师义项', partOfSpeech: 'v.', priority: false },
    ]);
    const candidate = { ...parseReadingText('take', index)[0], selected: true };
    expect(selectedReadingEntries([candidate])[0].meaning).toBe('');
    const chosen = chooseReadingMeaning(candidate, 0);
    const entry = selectedReadingEntries([chosen])[0];
    expect(entry.meaning).toBe('教师义项');
    expect(entry.partOfSpeech).toBe('v.');
    expect(entry.meaningSource).toEqual({
      name: '教师常用词库',
      version: 'teacher',
      english: 'take',
      originalMeaning: '教师义项',
      originalPartOfSpeech: 'v.',
      teacherRevised: false,
      candidateSource: 'common',
      acceptedFields: ['meaning', 'partOfSpeech'],
    });
    expect(chosen.dictionaryEntries).toBe(candidate.dictionaryEntries);
    expect(candidate.selectedDictionaryEntry).toBeUndefined();
    expect(selectedReadingEntries([chooseReadingMeaning(chosen, null)])[0].meaning).toBe('');
    expect(() => chooseReadingMeaning(candidate, 99)).toThrow('不可用');
    const preview = parseVocabularyText('take\t教师义项');
    const sourced = updateMaterialRow(preview.rows[0], {
      meaning: entry.meaning,
      meaningSource: entry.meaningSource,
    });
    expect(updateMaterialRow(sourced, { meaning: '修改后的义项' }).entry.meaningSource).toEqual({
      ...entry.meaningSource,
      teacherRevised: true,
    });
  });

  it('阅读确认也执行课件边界检查，不能从候选旁路进入超长或超限词条', () => {
    const index = createDictionaryIndex(vocabulary);
    const long = parseReadingText('x'.repeat(121), index).map((candidate) => ({
      ...candidate,
      selected: true,
    }));
    expect(() => selectedReadingEntries(long)).toThrow('1～120');
    const repeated = parseReadingText(
      Array.from({ length: 101 }, () => 'take').join(' '),
      index,
    ).map((candidate) => ({ ...candidate, selected: true }));
    expect(() => selectedReadingEntries(repeated, true)).toThrow('1～100');
  });
});

describe('材料范围、义项粒度与真实分发', () => {
  it('材料集 101/2000 条可确认，2001 条保留错误而单课 101 条不可旁路', () => {
    const rows = Array.from({ length: 2001 }, (_, index) => [`word${index}`, '本课义项']);
    expect(confirmImportedEntries(mapMaterialRows(rows.slice(0, 101)), [], 2000)).toHaveLength(101);
    const preview = mapMaterialRows(rows.slice(0, 2000));
    expect(confirmImportedEntries(preview, [], 2000)).toHaveLength(2000);
    expect(() => mapMaterialRows(rows)).toThrow('2,000');
    expect(rows).toHaveLength(2001);
    expect(() => confirmImportedEntries(mapMaterialRows(rows.slice(0, 101)))).toThrow('1～100');
    expect(confirmImportedEntries(mapMaterialRows(rows.slice(0, 100)))).toHaveLength(100);
    expect(() => confirmImportedEntries(preview, [], 2001)).toThrow('上限');
  });

  it('整条多义参考不能冒充单义候选；仅独立校对义项或教师保存值可批量接受', () => {
    const raw = { ...vocabulary[0], meaning: '拿，花费', reviewStatus: 'reference' as const };
    expect(getSingleAcceptableMeaning([raw])).toBeUndefined();
    expect(getSingleAcceptableMeaning([vocabulary[0]])).toBeUndefined();
    const reviewed = { ...raw, meaning: '拿', reviewStatus: 'reviewed-sense' as const };
    expect(getSingleAcceptableMeaning([reviewed])).toBe(reviewed);
    expect(
      getSingleAcceptableMeaning([reviewed, { ...reviewed, meaning: '花费' }]),
    ).toBeUndefined();
    expect(
      getSingleAcceptableMeaning([{ ...reviewed, meaning: '字'.repeat(201) }]),
    ).toBeUndefined();
    const teacher = lookupDictionary(
      createDictionaryIndex(
        [],
        [{ id: 'teacher', english: 'take', meaning: '本课义项', priority: false }],
      ),
      'take',
    );
    expect(getSingleAcceptableMeaning(teacher)?.reviewStatus).toBe('teacher-confirmed');
  });

  it('接受完整长义项后允许修订，保留原候选快照且不更改来源与候选数组', () => {
    const meaning = '字'.repeat(201);
    const dictionaryEntry = { ...vocabulary[0], meaning };
    const candidate = {
      ...parseReadingText('take', createDictionaryIndex([dictionaryEntry]))[0],
      selected: true,
    };
    const accepted = chooseReadingMeaning(candidate, 0);
    expect(() => selectedReadingEntries([accepted])).toThrow('200');
    const edited = updateReadingMeaning(accepted, '拿取', 'vt.');
    const entry = selectedReadingEntries([edited])[0];
    expect(entry.meaning).toBe('拿取');
    expect(entry.partOfSpeech).toBe('vt.');
    expect(entry.meaningSource).toMatchObject({ originalMeaning: meaning, teacherRevised: true });
    expect(edited.dictionaryEntries).toBe(candidate.dictionaryEntries);
    expect(candidate.teachingMeaning).toBeUndefined();
    const row = parseVocabularyText('take').rows[0];
    const sourced = acceptMaterialMeaning(row, dictionaryEntry);
    expect(sourced.issues.some((issue) => issue.severity === 'error')).toBe(true);
    const revised = updateMaterialRow(sourced, { meaning: '拿取' });
    expect(revised.entry.meaningSource).toMatchObject({
      originalMeaning: meaning,
      teacherRevised: true,
    });
    expect(revised.entry.source).toEqual(row.entry.source);
    expect(updateMaterialRow(revised, {}).entry.meaningSource).toEqual(revised.entry.meaningSource);
  });

  it('确认补全只计实际补齐字段，教师原值和重复接受不虚增；清空、保存及复制保留口径', () => {
    const candidate = vocabulary[0];
    const sourceRows = parseVocabularyText(
      'take\ntake\t\t教师词性\ntake\t教师原有释义\ntake\t教师原有释义\t教师词性',
      { mapping: { english: 0, meaning: 1, partOfSpeech: 2 } },
    ).rows;
    const accepted = sourceRows.map((row) => acceptMaterialMeaning(row, candidate));
    expect(accepted.map((row) => row.entry.meaningSource?.acceptedFields)).toEqual([
      ['meaning', 'partOfSpeech'],
      ['meaning'],
      ['partOfSpeech'],
      [],
    ]);
    expect(accepted[1].entry.partOfSpeech).toBe('教师词性');
    expect(accepted[3].entry.partOfSpeech).toBe('教师词性');
    const repeated = acceptMaterialMeaning(accepted[0], candidate);
    expect(repeated.entry.meaningSource?.acceptedFields).toEqual(['meaning', 'partOfSpeech']);
    expect(countConfirmedFields(accepted.map((row) => row.entry))).toBe(4);
    const cleared = updateMaterialRow(repeated, { meaning: '' });
    expect(countConfirmedFields([cleared.entry])).toBe(1);
    const confirmed = confirmImportedEntries({ ...parseVocabularyText('take'), rows: [repeated] });
    const savedMaterial = JSON.parse(JSON.stringify({ entries: confirmed })) as {
      entries: typeof confirmed;
    };
    expect(countConfirmedFields(savedMaterial.entries)).toBe(2);
    const lesson = createWordBeatLesson(savedMaterial.entries, { soundMode: 'teacher' });
    const copied = copyLesson(lesson);
    expect(copied.gameData.segments[0].entries[0].meaningSource).toEqual(
      confirmed[0].meaningSource,
    );
    expect(
      countConfirmedFields(copied.gameData.segments.flatMap((segment) => segment.entries)),
    ).toBe(2);
    const reading = {
      ...parseReadingText('take', createDictionaryIndex([candidate]))[0],
      selected: true,
    };
    const chosen = chooseReadingMeaning(reading, 0);
    expect(countConfirmedFields(selectedReadingEntries([chooseReadingMeaning(chosen, 0)]))).toBe(2);
    expect(countConfirmedFields(selectedReadingEntries([chooseReadingMeaning(chosen, null)]))).toBe(
      0,
    );
  });

  it('阅读选取材料使用 2000 条范围，重点功能词展开但不自动勾选', () => {
    const index = createDictionaryIndex(vocabulary, [
      { id: 'teacher', english: 'The', meaning: '该', priority: true },
    ]);
    const priority = parseReadingText('The take', index).find((entry) => entry.english === 'The')!;
    expect(priority.functionWord).toBe(false);
    expect(priority.selected).toBe(false);
    const candidates = parseReadingText(
      Array.from({ length: 2000 }, () => 'take').join(' '),
      index,
    ).map((entry) => ({ ...entry, selected: true }));
    expect(selectedReadingEntries(candidates, true, 2000)).toHaveLength(2000);
    expect(() => selectedReadingEntries(candidates, true)).toThrow('1～100');
  });

  it('实际随包词库、校对清单与摘要相符，参考多义词、词形和短语可追溯', async () => {
    const dictionary = await getBuiltinDictionary();
    const bytes = await readFile(
      new URL('../../../resources/dictionary/high-school.json', import.meta.url),
    );
    const source = JSON.parse(
      await readFile(new URL('../../../resources/dictionary/source.json', import.meta.url), 'utf8'),
    );
    expect(source.dictionarySha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(source.entryCount).toBe(dictionary.length);
    expect(source.independentSenseCount).toBe(
      dictionary.filter((entry) => entry.reviewStatus === 'reviewed-sense').length,
    );
    expect(source.referenceRecordCount).toBe(
      dictionary.filter((entry) => entry.reviewStatus === 'reference').length,
    );
    const index = createDictionaryIndex(dictionary);
    expect(lookupDictionary(index, 'took').every((entry) => entry.english === 'take')).toBe(true);
    expect(lookupDictionary(index, 'bank').length).toBeGreaterThan(1);
    expect(getSingleAcceptableMeaning(lookupDictionary(index, 'amaze'))?.meaning).toBe('使吃惊');
    expect(getSingleAcceptableMeaning(lookupDictionary(index, 'abandon'))).toBeUndefined();
    expect(lookupDictionary(index, 'take part in')[0].referenceMeaning).toContain('参加');
    expect(source.reviewScope).toContain('不是官方教材覆盖声明');
    const functionWordBytes = await readFile(
      new URL('../../../resources/dictionary/function-words.json', import.meta.url),
    );
    const functionWords = JSON.parse(functionWordBytes.toString('utf8'));
    expect(source.functionWordsSha256).toBe(
      createHash('sha256').update(functionWordBytes).digest('hex'),
    );
    expect(source.functionWordsVersion).toBe(functionWords.version);
    expect(source.functionWordCount).toBe(25);
    expect(functionWords.words).toHaveLength(25);
  });
});
