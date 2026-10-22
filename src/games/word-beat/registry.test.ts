/** 通用注册接口回归；平台不需要读取单词节拍私有字段才能列摘要或复制。 @author ahui */
import { describe, expect, it } from 'vitest';
import { getGame, getGames } from '../../platform/games';
import type { LessonDocument } from '../../platform/types';

describe('平台注册能力', () => {
  it('首版仅一个真实模块，未知模块不默认套用其结构', () => {
    expect(getGames().map((game) => game.id)).toEqual(['word-beat']);
    expect(getGame('unknown')).toBeUndefined();
  });

  it('未就绪省略时长，普通复制通过通用接口重建课件身份', () => {
    const module = getGame('word-beat')!;
    const lesson = module.create([
      { id: 'input', english: 'sustainable', meaning: '可持续的', priority: false },
    ]);
    expect(module.summarize?.(lesson, {})).toMatchObject({
      itemCount: 1,
      itemLabel: '词语',
      preparationState: 'pending',
    });
    expect(module.summarize?.(lesson, {}).durationMs).toBeUndefined();
    const copied = module.copy(lesson, { name: '周二练习' });
    expect(copied.id).not.toBe(lesson.id);
    expect(copied.name).toBe('周二练习');
    expect(copied.sourceLesson).toEqual({ id: lesson.id, revision: lesson.revision });
    expect(module.validateStructure(copied)).toEqual([]);
    expect(module.summarize?.({ ...lesson, gameData: null } as LessonDocument, {})).toEqual({
      preparationState: 'repair',
    });
  });
});
