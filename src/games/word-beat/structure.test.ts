/** 草稿恢复门禁回归：保护编辑能力，也拒绝会在渲染期崩溃的坏容器。 @author ahui */
import { describe, expect, it } from 'vitest';
import { createWordBeatLesson, validateWordBeat } from './rules';
import { validateWordBeatStructure } from './structure';

function lesson() {
  return createWordBeatLesson(
    [{ id: 'a', english: 'sustainable', meaning: '可持续的', priority: false }],
    { seed: 1 },
  );
}

describe('游戏结构与教学合法性分离', () => {
  it('空英文、越界教学值与未完成数字可恢复，运行检查仍阻塞', () => {
    const draft = lesson();
    draft.gameData.segments[0].entries[0].english = '';
    draft.gameData.bpm.value = -1;
    draft.draftInputs = { bpm: { raw: '-', message: '节奏未完成' } };
    expect(validateWordBeatStructure(draft)).toEqual([]);
    expect(validateWordBeat(draft, {}).some((issue) => issue.code === 'DRAFT_INVALID')).toBe(true);
  });

  it.each([
    (value: ReturnType<typeof lesson>) => ({ ...value, gameData: null }),
    (value: ReturnType<typeof lesson>) => ({
      ...value,
      gameData: { ...value.gameData, segments: null },
    }),
    (value: ReturnType<typeof lesson>) => ({
      ...value,
      gameData: { ...value.gameData, voices: null },
    }),
    (value: ReturnType<typeof lesson>) => ({
      ...value,
      gameData: {
        ...value.gameData,
        segments: [{ ...value.gameData.segments[0], entries: [null] }],
      },
    }),
    (value: ReturnType<typeof lesson>) => ({ ...value, draftInputs: { bpm: { raw: 2 } } }),
  ])('坏嵌套结构返回定位错误，检查器不崩溃', (change) => {
    const malformed = change(lesson());
    expect(validateWordBeatStructure(malformed)).toContainEqual(
      expect.objectContaining({ code: 'STRUCTURE_INVALID', severity: 'error' }),
    );
    expect(() =>
      validateWordBeat(malformed as unknown as ReturnType<typeof lesson>, {}),
    ).not.toThrow();
  });

  it('未知数据和规则版本明确拒绝，不替换成当前规则', () => {
    const value = lesson();
    value.dataVersion = 99;
    value.gameData.ruleVersion = 99;
    expect(
      validateWordBeatStructure(value).filter((issue) => issue.code === 'UNSUPPORTED_VERSION'),
    ).toHaveLength(2);
  });

  it('词条和口号共享定位空间，跨类型重号同样被拒绝', () => {
    const value = lesson();
    value.gameData.slogans.opening.id = value.gameData.segments[0].entries[0].id;
    expect(validateWordBeatStructure(value)).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_ID' }),
    );
  });

  it('补全记录兼容旧缺省字段，拒绝未知字段名或重复标记', () => {
    const value = lesson();
    const entry = value.gameData.segments[0].entries[0];
    entry.meaningSource = { name: '词库', version: '1', english: entry.english };
    expect(validateWordBeatStructure(value)).toEqual([]);
    entry.meaningSource.acceptedFields = ['meaning', 'partOfSpeech'];
    expect(validateWordBeatStructure(value)).toEqual([]);
    entry.meaningSource.acceptedFields = ['meaning', 'meaning'];
    expect(validateWordBeatStructure(value)).toContainEqual(
      expect.objectContaining({ code: 'STRUCTURE_INVALID' }),
    );
    const malformed = structuredClone(value) as unknown as {
      gameData: { segments: { entries: { meaningSource: { acceptedFields: string[] } }[] }[] };
    };
    malformed.gameData.segments[0].entries[0].meaningSource.acceptedFields = ['invented-field'];
    expect(validateWordBeatStructure(malformed)).toContainEqual(
      expect.objectContaining({ code: 'STRUCTURE_INVALID' }),
    );
  });

  it('来源整理依据可缺省，提供时必须是完整、可追溯的版本记录', () => {
    const value = lesson();
    const entry = value.gameData.segments[0].entries[0];
    entry.source = { name: '教师阅读材料', original: 'sustainable' };
    expect(validateWordBeatStructure(value)).toEqual([]);
    entry.source.analysis = {
      ruleId: 'platform.material.match',
      ruleVersion: 1,
      functionWordsVersion: 1,
      dictionaryVersions: [{ name: 'ECDICT', version: '固定来源修订' }],
    };
    expect(validateWordBeatStructure(value)).toEqual([]);
    // 来源仅作历史依据，未来的正整数版本不触发算法重算或改写旧教学内容。
    entry.source.analysis.ruleVersion = 2;
    expect(validateWordBeatStructure(value)).toEqual([]);
    for (const analysis of [
      null,
      { ...entry.source.analysis, ruleVersion: 0 },
      { ...entry.source.analysis, functionWordsVersion: 1.5 },
      { ...entry.source.analysis, dictionaryVersions: [{ name: 'ECDICT', version: null }] },
    ]) {
      const malformed = structuredClone(value);
      Object.assign(malformed.gameData.segments[0].entries[0].source!, { analysis });
      expect(validateWordBeatStructure(malformed)).toContainEqual(
        expect.objectContaining({
          code: 'STRUCTURE_INVALID',
          field: expect.stringContaining('source.analysis'),
        }),
      );
    }
  });
});
