/** 课堂节奏保护与正式时间轴回归；不是声音设备或视觉性能测量。 @author ahui */
import { describe, expect, it } from 'vitest';
import { compileWordBeat, createWordBeatLesson, getEntries } from './rules';
import {
  classroomRhythmChanged,
  classroomRhythmError,
  getClassroomChorus,
  previewClassroomRhythm,
} from './classroom-rhythm';

function fixture() {
  const lesson = createWordBeatLesson(
    [
      { id: 'a', english: 'knowledge', meaning: '知识', priority: false },
      { id: 'b', english: 'take part in', meaning: '参加', priority: true },
    ],
    { soundMode: 'chorus', seed: 1 },
  );
  for (const slogan of Object.values(lesson.gameData.slogans)) slogan.enabled = false;
  for (const entry of getEntries(lesson)) entry.chorus = getClassroomChorus(entry);
  return lesson;
}

describe('课堂齐读候选', () => {
  it.each([
    ['', '1'],
    ['0', '1'],
    ['33', '1'],
    ['1.5', '1'],
    ['4', '3'],
    ['3', '2'],
  ])('拒绝原始非法组合 %s/%s', (beats, perRead) => {
    expect(classroomRhythmError(beats, perRead)).not.toBe('');
  });
  it.each([1, 4, 8, 32])('%i 拍按真实拍数计时，不按词块数计时', (beats) => {
    const lesson = fixture();
    const preview = previewClassroomRhythm(
      lesson,
      { beats: String(beats), beatsPerRead: beats === 1 ? '1' : '2' },
      'all',
    );
    expect(preview.error).toBe('');
    const plan = compileWordBeat(preview.lesson, {});
    const chorus = plan.cues.filter((cue) => cue.kind === 'chorus');
    expect(chorus).toHaveLength(2);
    expect(chorus.every((cue) => cue.durationMs === beats * 600)).toBe(true);
    expect(getEntries(lesson)[0].chorus?.beats.value).toBe(4);
  });
  it('每字段手动/锁定保护且只影响范围，两个目标共同校验', () => {
    const lesson = fixture();
    const [first, second] = getEntries(lesson);
    first.chorus!.beats = { value: 3, source: 'manual', locked: false };
    second.chorus!.beatsPerRead.locked = true;
    const conflict = previewClassroomRhythm(lesson, { beats: '8', beatsPerRead: '2' }, 'all');
    expect(conflict.error).toContain('knowledge');
    expect(conflict.protectedFields).toBe(2);
    expect(getEntries(conflict.lesson)[0].chorus!.beats.value).toBe(3);
    const scoped = previewClassroomRhythm(lesson, { beats: '8', beatsPerRead: null }, 'priority');
    expect(scoped.error).toBe('');
    expect(getEntries(scoped.lesson).map((item) => item.chorus!.beats.value)).toEqual([3, 8]);
    expect(getEntries(scoped.lesson)[1].chorus!.beatsPerRead.value).toBe(1);
  });
  it('未启用不改、来源变化不重排、占拍和间隔变化必须重排', () => {
    const lesson = fixture();
    const unchanged = previewClassroomRhythm(lesson, { beats: null, beatsPerRead: null }, 'all');
    expect(unchanged.changed).toBe(0);
    getEntries(unchanged.lesson)[0].chorus!.beats.source = 'manual';
    expect(classroomRhythmChanged(lesson, unchanged.lesson)).toBe(false);
    getEntries(unchanged.lesson)[0].chorus!.beatsPerRead.value = 2;
    expect(classroomRhythmChanged(lesson, unchanged.lesson)).toBe(true);
    const gap = structuredClone(lesson);
    gap.gameData.chorusGapBeats = 4;
    expect(classroomRhythmChanged(lesson, gap)).toBe(true);
    const cue = compileWordBeat(gap, {}).cues.find((item) => item.kind === 'transition');
    expect(cue?.durationMs).toBe(2400);
  });
  it('明确包含手动值后可统一四拍读四次，锁定字段仍保留且原课不修改', () => {
    const lesson = fixture();
    const [first, second] = getEntries(lesson);
    first.chorus!.beatsPerRead = { value: 2, source: 'manual', locked: false };
    second.chorus!.beats = { value: 8, source: 'manual', locked: true };
    const preview = previewClassroomRhythm(
      lesson,
      { beats: '4', beatsPerRead: '1', includeManual: true },
      'all',
    );
    expect(preview.error).toBe('');
    expect(preview.changed).toBe(1);
    expect(preview.protectedFields).toBe(1);
    expect(getEntries(preview.lesson).map((item) => item.chorus!.beatsPerRead.value)).toEqual([
      1, 1,
    ]);
    expect(getEntries(preview.lesson)[1].chorus!.beats.value).toBe(8);
    expect(first.chorus!.beatsPerRead.value).toBe(2);
  });
  it('词表增删时比较稳定ID而非旧索引，不能读取不存在条目而崩溃', () => {
    const lesson = fixture();
    const added = structuredClone(lesson);
    const extra = structuredClone(getEntries(added)[0]);
    extra.id = 'new-classroom-word';
    added.gameData.segments[0].entries.push(extra);
    expect(classroomRhythmChanged(lesson, added)).toBe(true);
    expect(classroomRhythmChanged(added, lesson)).toBe(true);
    const reordered = structuredClone(lesson);
    reordered.gameData.segments[0].entries.reverse();
    expect(classroomRhythmChanged(lesson, reordered)).toBe(false);
  });
});
