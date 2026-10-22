/** 教师批改的原子性、独立继承与锁定边界；失败不能留下部分更新。 @author ahui */
import { describe, expect, it } from 'vitest';
import { createWordBeatLesson, getEntries } from '../games/word-beat/rules';
import { applyEntryBatch } from './editor-actions';

function fixture() {
  return createWordBeatLesson(
    ['record', 'take part in', 'achievement'].map((english) => ({
      id: crypto.randomUUID(),
      english,
      meaning: '',
      priority: false,
    })),
    { soundMode: 'teacher' },
  );
}

describe('批量编辑', () => {
  it('无选定字段或已选字段留空整批拒绝，不把混合展示值当作写入值', () => {
    const lesson = fixture();
    const id = getEntries(lesson)[0].id;
    expect(() => applyEntryBatch(lesson, [id], {})).toThrow('至少一项');
    expect(() => applyEntryBatch(lesson, [id], { rounds: undefined })).toThrow('至少一项');
    expect(() => applyEntryBatch(lesson, [id], { priority: 'yes', rounds: '' })).toThrow(
      '已勾选的修改字段不能为空',
    );
    expect(getEntries(lesson)[0].priority).toBe(false);
  });

  it('只有明确恢复预设和解锁才移除教师覆盖，其他已锁值与错误输入继续保留', () => {
    const lesson = fixture();
    const [first, second] = getEntries(lesson);
    first.rounds = { value: 7, source: 'manual', locked: true };
    first.modelBeats = { value: 8, source: 'manual', locked: true };
    first.priority = true;
    lesson.draftInputs = {
      [`${first.id}.rounds`]: { raw: '99', message: '错误', objectId: first.id },
      [`${second.id}.model`]: { raw: '', message: '未填', objectId: second.id },
    };
    const next = applyEntryBatch(lesson, [first.id], {
      rounds: 'preset',
      modelBeats: 'preset',
      lockRounds: 'unlock',
    });
    expect(getEntries(next)[0].rounds).toEqual({ value: 3, source: 'preset', locked: false });
    expect(getEntries(next)[0].modelBeats).toEqual({ value: 2, source: 'preset', locked: true });
    expect(next.draftInputs?.[`${first.id}.rounds`]).toBeUndefined();
    expect(next.draftInputs?.[`${second.id}.model`]?.raw).toBe('');
    expect(first.rounds.value).toBe(7);
  });

  it('非法字段拒绝整批，不修改原课件；选择失效也不部分提交', () => {
    const lesson = fixture();
    const original = structuredClone(lesson);
    expect(() =>
      applyEntryBatch(lesson, [getEntries(lesson)[0].id], { priority: 'yes', rounds: '9' }),
    ).toThrow('整批未应用');
    expect(() =>
      applyEntryBatch(lesson, [getEntries(lesson)[0].id, 'deleted'], { rounds: '3' }),
    ).toThrow('已变化');
    expect(lesson).toEqual(original);
  });

  it('仅修改选中位置，明确批改可改锁定字段并保留锁定，清掉对应原始错误', () => {
    const lesson = fixture();
    const [first, second] = getEntries(lesson);
    first.rounds.locked = true;
    lesson.draftInputs = {
      [`${first.id}.rounds`]: { raw: '', message: '未完成', objectId: first.id },
      bpm: { raw: '2', message: '非法' },
    };
    const result = applyEntryBatch(lesson, [first.id, first.id], { rounds: '4', priority: 'yes' });
    expect(getEntries(result)[0].rounds).toMatchObject({
      value: 4,
      source: 'manual',
      locked: true,
    });
    expect(getEntries(result)[1]).toEqual(second);
    expect(result.draftInputs).toEqual({ bpm: { raw: '2', message: '非法' } });
    expect(first.rounds.value).toBe(1);
  });

  it('类型默认只更新预设管理值，手动及锁定示范拍数保留', () => {
    const lesson = fixture();
    const entries = getEntries(lesson);
    entries[1].modelBeats = { value: 7, source: 'manual', locked: false };
    entries[2].modelBeats.locked = true;
    const result = applyEntryBatch(
      lesson,
      entries.map((entry) => entry.id),
      { entryType: 'phrase' },
    );
    expect(getEntries(result).map((entry) => entry.modelBeats.value)).toEqual([3, 7, 2]);
  });

  it('音色与语速独立继承，不替换录音或未选词的系统参数', () => {
    const lesson = fixture();
    const entries = getEntries(lesson);
    entries[0].voiceOverrides = { voiceId: 'en-custom', rate: 1.1 };
    entries[1].audio = {
      source: 'recording',
      status: 'stale',
      assetId: crypto.randomUUID(),
      text: entries[1].english,
      language: 'en-US',
      rate: 1,
    };
    const result = applyEntryBatch(
      lesson,
      entries.slice(0, 2).map((entry) => entry.id),
      { voiceId: 'inherit', rate: '1.2' },
    );
    expect(getEntries(result)[0].voiceOverrides).toEqual({ rate: 1.2 });
    expect(getEntries(result)[1].audio?.source).toBe('recording');
    expect(getEntries(result)[1].voiceOverrides).toBeUndefined();
    expect(getEntries(result)[2]).toEqual(entries[2]);
  });
});
