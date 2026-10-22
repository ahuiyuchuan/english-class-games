/** 齐读真实编排、边界与批量原子性，不用动画次数代替拍数。 @author ahui */
import { describe, expect, it } from 'vitest';
import { applyEntryBatch } from '../../app/editor-actions';
import {
  compileWordBeat,
  createWordBeatLesson,
  getEntries,
  getAudioRequests,
  validateWordBeat,
} from './rules';
import { getWordBeatBeatProgress } from './timeline';
import { createTimeSuggestions, isSuggestionCurrent } from './suggestions';

function lesson() {
  const value = createWordBeatLesson(
    ['word', 'take part in'].map((english, index) => ({
      id: String(index),
      english,
      meaning: '教学词语',
      priority: false,
    })),
    { soundMode: 'chorus', seed: 123 },
  );
  Object.values(value.gameData.slogans).forEach((slogan) => {
    slogan.enabled = false;
  });
  // Fixed two-round timing scenarios remain independent of the new one-round creation default.
  getEntries(value).forEach((entry) => {
    entry.rounds.value = 2;
  });
  return value;
}
describe('学生自主齐读', () => {
  it('100 BPM、4拍2轮精确4.8秒，无示范、无隐藏间隔且不需要英文音色', () => {
    const value = lesson(),
      plan = compileWordBeat(value, {});
    expect(plan.durationMs).toBe(2400 + 4800 * 2);
    expect(plan.cues.map((cue) => cue.kind)).toEqual([
      'preparation',
      'chorus',
      'chorus',
      'chorus',
      'chorus',
    ]);
    expect(plan.cues[3].startMs).toBe(plan.cues[2].startMs + plan.cues[2].durationMs);
    expect(getAudioRequests(value, {})).toEqual([]);
  });
  it.each([
    [1, 1],
    [4, 1],
    [4, 2],
    [8, 2],
    [32, 1],
    [32, 2],
  ])('%i拍／每次%i拍的拍位与朗读次数', (beats, perRead) => {
    const original = lesson();
    const value = applyEntryBatch(
      original,
      getEntries(original).map((e) => e.id),
      { chorusBeats: String(beats), chorusPerRead: String(perRead) },
    );
    const cue = compileWordBeat(value, {}).cues[1];
    expect(cue.durationMs).toBe(beats * 600);
    const prompts = new Set(
      Array.from({ length: beats }, (_, beat) =>
        Math.floor(getWordBeatBeatProgress(cue, undefined, beat * 600) / perRead),
      ),
    );
    expect(prompts.size).toBe(beats / perRead);
  });
  it.each([0, 1, 2, 3, 4])('词间隔%i拍只出现一次，轮间不插准备', (gap) => {
    const value = lesson();
    value.gameData.chorusGapBeats = gap;
    const plan = compileWordBeat(value, {});
    expect(plan.durationMs).toBe(12000 + gap * 600);
    expect(plan.cues.filter((cue) => cue.kind === 'transition').length).toBe(gap ? 1 : 0);
  });
  it('非法整除整批拒绝，不更改原对象；只修改勾选项并保留锁定', () => {
    const value = lesson(),
      entries = getEntries(value);
    expect(() =>
      applyEntryBatch(value, [entries[0].id], { chorusBeats: '3', chorusPerRead: '2' }),
    ).toThrow(/整除/);
    expect(entries[0].chorus).toBeUndefined();
    const next = applyEntryBatch(value, [entries[0].id], { chorusBeats: '8', chorusPerRead: '2' });
    expect(getEntries(next)[0].chorus?.beats.value).toBe(8);
    expect(getEntries(next)[1].chorus).toBeUndefined();
  });
  it('错误数字原文阻止运行，启用口号仍检查声音', () => {
    const value = lesson();
    value.draftInputs = { chorusGapBeats: { raw: '', message: '尚未填写' } };
    expect(() => compileWordBeat(value, {})).toThrow('尚未填写');
    delete value.draftInputs;
    value.gameData.slogans.opening.enabled = true;
    expect(validateWordBeat(value, {}).some((issue) => issue.code === 'SOUND_PENDING')).toBe(true);
  });
  it('切回旧模式仍恢复示范参数，齐读参数不套用跟读公式', () => {
    const value = lesson();
    getEntries(value)[0].modelBeats.value = 7;
    expect(compileWordBeat(value, {}).cues[1].durationMs).toBe(2400);
    value.gameData.soundMode = 'teacher';
    expect(compileWordBeat(value, {}).cues[1].durationMs).toBe(4200);
  });
  it('拍数变化废弃时长建议', () => {
    const value = lesson();
    value.gameData.targetDurationMs = 60000;
    for (const suggestion of createTimeSuggestions(value, {})) {
      const changed = structuredClone(value);
      changed.gameData.chorusGapBeats = 2;
      expect(isSuggestionCurrent(changed, suggestion)).toBe(false);
    }
  });
});
