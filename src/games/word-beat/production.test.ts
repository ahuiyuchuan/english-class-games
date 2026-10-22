/** 制作指纹的语义边界；对象排列不是编辑，数组及教学约束变化必须保留。 @author ahui */
import { describe, expect, it } from 'vitest';
import type { WordBeatLesson } from './model';
import { productionChanges, productionFingerprint } from './production';
import { createWordBeatLesson, getEntries } from './rules';

/** 改变每一层对象的插入顺序；故意不调整任何数组元素位置。 */
function reorderObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderObjects);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reorderObjects(item)]),
    );
  return value;
}

function fixture(): WordBeatLesson {
  return createWordBeatLesson(
    [
      { id: 'first', english: 'knowledge', meaning: '知识', priority: false },
      { id: 'second', english: 'challenge', meaning: '挑战', priority: true },
    ],
    { seed: 1 },
  );
}

describe('制作教学输入指纹', () => {
  it('递归对象重排和重复JSON保存不改变内容指纹', () => {
    const lesson = fixture();
    lesson.draftInputs = { bpm: { raw: '-', message: '请输入完整数字', objectId: 'first' } };
    const reordered = reorderObjects(lesson) as WordBeatLesson;
    expect(JSON.stringify(reordered.gameData)).not.toBe(JSON.stringify(lesson.gameData));
    expect(productionFingerprint(reordered)).toBe(productionFingerprint(lesson));
    expect(productionChanges(lesson, reordered)).toEqual([]);
    expect(productionFingerprint(JSON.parse(JSON.stringify(reordered)))).toBe(
      productionFingerprint(lesson),
    );
  });

  it('保存修订、准备指针和时间元信息不构成教学变化', () => {
    const lesson = fixture();
    const saved = {
      ...lesson,
      revision: lesson.revision + 8,
      preparedRevision: 7,
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T01:00:00Z',
    };
    expect(productionFingerprint(saved)).toBe(productionFingerprint(lesson));
    expect(productionChanges(lesson, saved)).toEqual([]);
  });

  it.each<[string, (lesson: WordBeatLesson) => void]>([
    [
      '课件名称',
      (lesson) => {
        lesson.name = '新名称';
      },
    ],
    [
      '数组词序',
      (lesson) => {
        lesson.gameData.segments[0].entries.reverse();
      },
    ],
    [
      '词语',
      (lesson) => {
        getEntries(lesson)[0].english = 'learning';
      },
    ],
    [
      '释义',
      (lesson) => {
        getEntries(lesson)[0].meaning = '新释义';
      },
    ],
    [
      '练习模式',
      (lesson) => {
        lesson.gameData.soundMode = 'chorus';
      },
    ],
    [
      '轮数',
      (lesson) => {
        getEntries(lesson)[0].rounds.value = 3;
      },
    ],
    [
      '拍数',
      (lesson) => {
        getEntries(lesson)[0].modelBeats.value = 8;
      },
    ],
    [
      '跟读规则',
      (lesson) => {
        getEntries(lesson)[0].follow.beats = 8;
      },
    ],
    [
      '锁定',
      (lesson) => {
        getEntries(lesson)[0].rounds.locked = true;
      },
    ],
    [
      '手动来源',
      (lesson) => {
        getEntries(lesson)[0].rounds.source = 'manual';
      },
    ],
    [
      '音色',
      (lesson) => {
        lesson.gameData.voices.englishVoiceId = 'another-voice';
      },
    ],
    [
      '语速',
      (lesson) => {
        lesson.gameData.voices.englishRate = 1.1;
      },
    ],
    [
      '音乐',
      (lesson) => {
        lesson.gameData.music.enabled = !lesson.gameData.music.enabled;
      },
    ],
    [
      '音乐倍率',
      (lesson) => {
        lesson.gameData.music.playbackRate = 1.2;
      },
    ],
    [
      '循环校准',
      (lesson) => {
        lesson.gameData.music.sync = {
          bpm: 100,
          firstBeatMs: 100,
          loopStartMs: 100,
          loopEndMs: 2500,
        };
      },
    ],
    [
      '非法草稿',
      (lesson) => {
        lesson.draftInputs = { bpm: { raw: '-', message: '未输入完成' } };
      },
    ],
    [
      '声音绑定',
      (lesson) => {
        getEntries(lesson)[0].audio = {
          source: 'system',
          text: 'knowledge',
          language: 'en-US',
          rate: 1,
          voiceId: 'test-voice',
          assetId: 'test-asset',
          status: 'ready',
        };
      },
    ],
  ])('%s真实变化仍产生不同指纹', (_name, mutate) => {
    const lesson = fixture();
    const changed = structuredClone(lesson);
    mutate(changed);
    expect(productionFingerprint(changed)).not.toBe(productionFingerprint(lesson));
    expect(productionChanges(lesson, changed).length).toBeGreaterThan(0);
  });
});
