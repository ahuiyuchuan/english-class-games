/** 课堂文字输入边界与真实内容变化回归；不模拟声音匹配或视觉验收。 @author ahui */
import { describe, expect, it } from 'vitest';
import {
  classroomWordError,
  classroomWordFieldError,
  classroomWordsChanged,
  classroomWordStructureChanged,
} from './classroom-words';
import { createWordBeatLesson, getEntries } from './rules';

function fixture() {
  return createWordBeatLesson(
    [
      { id: 'word', english: 'knowledge', meaning: '知识', priority: false },
      { id: 'phrase', english: 'take part in', meaning: '参加', priority: true },
    ],
    { soundMode: 'chorus', seed: 1 },
  );
}

describe('课堂文字原始输入边界', () => {
  it.each(['', '   ', 'a'.repeat(121), 'word\n', 'wo\trd', '\u0000word', 'word\u007f'])(
    '保留并拒绝非法英文 %j',
    (raw) => {
      expect(classroomWordFieldError('english', raw)).toBe(
        '英文需为1～120个字符，不能含控制字符。',
      );
      expect(classroomWordError(raw, '释义')).not.toBe('');
    },
  );

  it('按Unicode字符计数，首尾普通空白不占教学长度且不改写输入', () => {
    const english = `  ${'𠮷'.repeat(120)}  `;
    const meaning = `  ${'义'.repeat(200)}  `;
    expect(classroomWordError(english, meaning)).toBe('');
    expect(classroomWordFieldError('english', '𠮷'.repeat(121))).not.toBe('');
    expect(english).toHaveLength(244);
    expect(meaning).toHaveLength(204);
  });

  it.each(['义'.repeat(201), 'meaning\r', '\u0001', '\u007f'])('拒绝非法释义 %j', (raw) => {
    expect(classroomWordFieldError('meaning', raw)).toBe('释义不能超过200个字符或含控制字符。');
    expect(classroomWordError('word', raw)).toBe(classroomWordFieldError('meaning', raw));
  });

  it('空释义有效；两项均错误时先定位英文，不用截断后的值冒充成功', () => {
    expect(classroomWordError('word', '')).toBe('');
    expect(classroomWordError('word', '  ')).toBe('');
    expect(classroomWordError('', '义'.repeat(201))).toBe(classroomWordFieldError('english', ''));
  });
});

describe('课堂内容变化与其他安排隔离', () => {
  it('结构变化单独比较词表ID，不把文字／拍数改动误判为必须重开课堂', () => {
    const before = fixture();
    const after = structuredClone(before);
    getEntries(after)[0].english = 'classroom';
    getEntries(after)[0].rounds.value = 2;
    expect(classroomWordStructureChanged(before, after)).toBe(false);
    after.gameData.segments[0].entries.reverse();
    expect(classroomWordStructureChanged(before, after)).toBe(true);
    after.gameData.segments[0].entries.pop();
    expect(classroomWordStructureChanged(before, after)).toBe(true);
  });
  it.each(['english', 'meaning'] as const)('%s变化需要更新正文时间轴', (field) => {
    const before = fixture();
    const after = structuredClone(before);
    getEntries(after)[0][field] = field === 'english' ? 'new phrase' : '新的教学释义';
    expect(classroomWordsChanged(before, after)).toBe(true);
    expect(getEntries(before)[0].english).toBe('knowledge');
    expect(getEntries(after)[0].entryType).toBe(getEntries(before)[0].entryType);
    expect(getEntries(after)[0].modelBeats).toEqual(getEntries(before)[0].modelBeats);
  });

  it('无正文变化时不把轮数、拍数、模式、来源或声音音量算作文字修改', () => {
    const before = fixture();
    const after = structuredClone(before);
    after.gameData.soundMode = 'teacher';
    after.gameData.volumes.voice = 0.5;
    const entry = getEntries(after)[0];
    entry.rounds.value = 8;
    entry.modelBeats.value = 8;
    entry.meaningSource = { name: '原依据', version: '1', english: entry.english };
    expect(classroomWordsChanged(before, after)).toBe(false);
  });

  it('正文比较保留大小写和原始空白差异；集合／顺序另由词表结构门禁核验', () => {
    const before = fixture();
    const after = structuredClone(before);
    getEntries(after)[0].english = 'Knowledge';
    expect(classroomWordsChanged(before, after)).toBe(true);
    getEntries(after)[0].english = 'knowledge ';
    expect(classroomWordsChanged(before, after)).toBe(true);
    after.gameData.segments[0].entries.reverse();
    expect(classroomWordsChanged(before, after)).toBe(true);
    after.gameData.segments[0].entries.pop();
    expect(classroomWordsChanged(before, after)).toBe(true);
  });
});
