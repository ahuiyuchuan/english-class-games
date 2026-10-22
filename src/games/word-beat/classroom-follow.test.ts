/** 课堂示范／跟读范围候选与保护边界，不替代真实声音验证。 @author ahui */
import { describe, expect, it } from 'vitest';
import { createWordBeatLesson, getEntries } from './rules';
import { previewClassroomFollow, undoClassroomWordStructure } from './ClassroomRounds';

function fixture() {
  return createWordBeatLesson(
    [
      { id: 'a', english: 'knowledge', meaning: '知识', priority: false },
      { id: 'b', english: 'take part in', meaning: '参加', priority: true },
    ],
    { soundMode: 'teacher', seed: 1 },
  );
}

describe('课堂非齐读范围拍数', () => {
  it('按范围统一固定示范／跟读，不修改原课件或其他范围', () => {
    const lesson = fixture();
    const preview = previewClassroomFollow(lesson, {
      raw: '',
      scope: 'priority',
      dirty: false,
      modelBeats: '4',
      follow: '8',
    });
    expect(preview.error).toBe('');
    expect(preview.changed).toBe(1);
    expect(getEntries(preview.lesson)[1].modelBeats.value).toBe(4);
    expect(getEntries(preview.lesson)[1].follow).toMatchObject({ mode: 'manual', beats: 8 });
    expect(getEntries(preview.lesson)[0]).toEqual(getEntries(lesson)[0]);
    expect(getEntries(lesson)[1].follow.mode).toBe('preset');
  });
  it('只有明确包含手动值才可覆盖，锁定值永远保护', () => {
    const lesson = fixture();
    const [first, second] = getEntries(lesson);
    first.modelBeats = { value: 5, source: 'manual', locked: false };
    second.follow = { ...second.follow, mode: 'manual', beats: 7, locked: true };
    const draft = { raw: '', scope: 'all', dirty: false, modelBeats: '4', follow: '4' };
    const protectedPreview = previewClassroomFollow(lesson, draft);
    expect(protectedPreview.protectedFields).toBe(2);
    expect(getEntries(protectedPreview.lesson)[0].modelBeats.value).toBe(5);
    const confirmed = previewClassroomFollow(lesson, { ...draft, includeManual: true });
    expect(confirmed.protectedFields).toBe(1);
    expect(getEntries(confirmed.lesson)[0].modelBeats.value).toBe(4);
    expect(getEntries(confirmed.lesson)[1].follow.beats).toBe(7);
  });
  it('非法输入明确拒绝，配音模式不修改示范，齐读不套用跟读公式', () => {
    const lesson = fixture();
    const draft = { raw: '', scope: 'all', dirty: false, modelBeats: '', follow: '33' };
    expect(previewClassroomFollow(lesson, draft).error).toContain('1～32');
    lesson.gameData.soundMode = 'voiced';
    const preview = previewClassroomFollow(lesson, { ...draft, modelBeats: '8', follow: '4' });
    expect(preview.error).toBe('');
    expect(getEntries(preview.lesson)[0].modelBeats.value).toBe(2);
    lesson.gameData.soundMode = 'chorus';
    expect(previewClassroomFollow(lesson, draft)).toMatchObject({ error: '', changed: 0 });
  });
  it('撤销排序只还原词序，保留排序后修改的内容、安排及其他课堂设置', () => {
    const before = fixture();
    const current = structuredClone(before);
    current.gameData.segments[0].entries.reverse();
    const first = getEntries(current).find((item) => item.id === getEntries(before)[0].id)!;
    first.english = 'revised word';
    first.rounds.value = 5;
    current.gameData.showMeaning = false;
    const restored = undoClassroomWordStructure(current, before);
    expect(getEntries(restored).map((item) => item.id)).toEqual(
      getEntries(before).map((item) => item.id),
    );
    expect(getEntries(restored)[0]).toMatchObject({
      english: 'revised word',
      rounds: { value: 5 },
    });
    expect(restored.gameData.showMeaning).toBe(false);
    expect(getEntries(current)[0].id).toBe(getEntries(before)[1].id);
  });
  it('撤销删除找回该词，仍存在的其他词保留之后的修改', () => {
    const before = fixture();
    const current = structuredClone(before);
    current.gameData.segments[0].entries.splice(0, 1);
    getEntries(current)[0].meaning = '课堂新释义';
    const restored = undoClassroomWordStructure(current, before);
    expect(getEntries(restored)[0]).toEqual(getEntries(before)[0]);
    expect(getEntries(restored)[1].meaning).toBe('课堂新释义');
  });
});
