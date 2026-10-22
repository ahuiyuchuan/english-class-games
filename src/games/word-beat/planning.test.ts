/** Plans preserve source entries and reject invalid input rather than inventing duration. @author ahui */
import { describe, it, expect } from 'vitest';
import { createWordBeatLesson, getEntries, compileWordBeat } from './rules';
import { proposeLessonSplit } from './planning';
describe('真实时长拆课', () => {
  const make = () => {
    const lesson = createWordBeatLesson(
      Array.from({ length: 24 }, (_, i) => ({
        id: String(i),
        english: `word${i}`,
        meaning: '教学词',
        priority: i === 2,
      })),
      { soundMode: 'chorus', seed: 123 },
    );
    Object.values(lesson.gameData.slogans).forEach((s) => (s.enabled = false));
    lesson.gameData.targetDurationMs = 60000;
    return lesson;
  };
  it('全部条目按序保留，手动锁定值不变，原课不变且副本身份独立', () => {
    const lesson = make();
    getEntries(lesson)[0].rounds = { value: 3, source: 'manual', locked: true };
    const before = structuredClone(lesson);
    const parts = proposeLessonSplit(lesson, {});
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((p) => getEntries(p.lesson).map((e) => e.english))).toEqual(
      getEntries(lesson).map((e) => e.english),
    );
    expect(getEntries(parts[0].lesson)[0].rounds).toEqual(getEntries(lesson)[0].rounds);
    expect(new Set(parts.map((p) => p.lesson.id)).size).toBe(parts.length);
    expect(lesson).toEqual(before);
    for (const p of parts) expect(p.durationMs).toBe(compileWordBeat(p.lesson, {}).durationMs);
  });
  it('非法输入不能套用旧值拆分，已在目标内无拆分', () => {
    const lesson = make();
    lesson.draftInputs = { chorusGapBeats: { raw: '', message: '请输入间隔' } };
    expect(() => proposeLessonSplit(lesson, {})).toThrow('请输入间隔');
    delete lesson.draftInputs;
    lesson.gameData.targetDurationMs = 600000;
    expect(proposeLessonSplit(lesson, {})).toEqual([]);
  });
});
