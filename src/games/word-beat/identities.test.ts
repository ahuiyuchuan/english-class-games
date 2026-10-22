/** 导入身份声明验证真实建议与教学内容边界，不将相同英文误当成身份。 @author ahui */
import { describe, expect, it } from 'vitest';
import { describeWordBeatIdentities } from './identities';
import { remapLocalSnapshots } from '../../platform/snapshot-copy';
import { applyPreset, createWordBeatLesson, getEntries } from './rules';
import {
  createPresetSuggestion,
  createTimeSuggestions,
  isSuggestionCurrent,
  remixLesson,
} from './suggestions';
import type { WordBeatLesson } from './model';

/** 只读解析标准 JSON Pointer，以断言声明定位到真实数据。 */
function at(value: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((current, key) => {
      const decoded = key.replaceAll('~1', '/').replaceAll('~0', '~');
      return (current as Record<string, unknown>)[decoded];
    }, value);
}

function fixture(): WordBeatLesson {
  return createWordBeatLesson(
    ['sustainable', 'take part in', 'responsibility'].map((english) => ({
      id: crypto.randomUUID(),
      english,
      meaning: '教师确认释义',
      priority: false,
    })),
    { soundMode: 'teacher', seed: 23 },
  );
}

describe('游戏身份的精确位置', () => {
  it('真实对象与教学文本区分，等于旧标识的英文、释义和来源不被声明', () => {
    const lesson = fixture();
    const entry = getEntries(lesson)[0];
    entry.english = lesson.id;
    entry.meaning = entry.id;
    entry.source = { name: entry.id, original: entry.id };
    const before = structuredClone(lesson);
    const layout = describeWordBeatIdentities(lesson);
    const identities = layout.identities.map((path) => at(lesson, path));
    expect(identities).toHaveLength(7);
    expect(new Set(identities).size).toBe(7);
    expect(identities).toContain(entry.id);
    expect(layout.identities).not.toContain('/gameData/segments/0/entries/0/english');
    expect(layout.identities).not.toContain('/gameData/segments/0/entries/0/meaning');
    expect(layout.references).toEqual([]);
    expect(lesson).toEqual(before);
  });

  it('真实预设建议的对象定位和序列化依赖均声明，正文依赖保持文本', () => {
    const lesson = fixture();
    const suggestion = createPresetSuggestion(lesson, 'quick')!;
    expect(suggestion).not.toBeNull();
    lesson.gameData.suggestionHistory = [suggestion];
    const layout = describeWordBeatIdentities(lesson);
    expect(layout.identities.map((path) => at(lesson, path))).toContain(suggestion.id);
    const references = layout.references.map((path) => at(lesson, path));
    expect(references).toContain(lesson.id);
    expect(references).toContain(getEntries(lesson)[0].id);
    const encoded = layout.encodedReferences!.filter((item) => item.references.length);
    const nestedIds = encoded.flatMap((item) => {
      const value = JSON.parse(at(lesson, item.path) as string);
      return item.references.map((path) => (path ? at(value, path) : value));
    });
    expect(nestedIds).toContain(lesson.gameData.segments[0].id);
    expect(nestedIds).toContain(getEntries(lesson)[0].id);
  });

  it('洗牌建议的前后条目及完整依赖都保留内部身份关联', () => {
    const lesson = fixture();
    const suggestion = Array.from({ length: 20 }, (_, index) =>
      remixLesson(lesson, { seed: index + 1, shuffleEntries: true }),
    ).find((candidate) => candidate?.changes.some((change) => change.path.endsWith('.entries')))!;
    expect(suggestion).toBeTruthy();
    lesson.gameData.suggestionHistory = [suggestion];
    const layout = describeWordBeatIdentities(lesson);
    const entryIds = getEntries(lesson).map((entry) => entry.id);
    const referenceIds = layout.references
      .filter((path) => /\/(before|after)\//.test(path))
      .map((path) => at(lesson, path));
    expect(referenceIds).toHaveLength(entryIds.length * 2);
    expect(new Set(referenceIds)).toEqual(new Set(entryIds));
    const dependency = layout.encodedReferences!.find((item) => item.references.length === 3)!;
    const decoded = JSON.parse(at(lesson, dependency.path) as string);
    expect(new Set(dependency.references.map((path) => at(decoded, path)))).toEqual(
      new Set(entryIds),
    );
  });

  it('十四词跨段课件携带真实时间建议可独立复制，根依赖与对象身份同步更新', () => {
    let lesson = createWordBeatLesson(
      Array.from({ length: 14 }, (_, index) => ({
        id: crypto.randomUUID(),
        english: `word-${index + 1}`,
        meaning: '教师确认释义',
        priority: false,
      })),
      { soundMode: 'teacher', seed: 23 },
    );
    lesson.revision = 1;
    // Saved multi-round lesson keeps a real reducible duration after the new creation default.
    lesson = applyPreset(lesson, 'regular');
    lesson.gameData.targetDurationMs = 60_000;
    Object.values(lesson.gameData.slogans).forEach((slogan) => {
      slogan.enabled = false;
    });
    const suggestion = createTimeSuggestions(lesson, {})[0];
    expect(suggestion).toBeTruthy();
    lesson.gameData.suggestionHistory = [suggestion];
    const before = structuredClone(lesson);
    const copy = remapLocalSnapshots(
      [lesson],
      [{ revision: lesson.revision, layout: describeWordBeatIdentities(lesson) }],
    )[0];
    const copiedSuggestion = copy.gameData.suggestionHistory![0];
    expect(copy.id).not.toBe(lesson.id);
    expect(copiedSuggestion.id).not.toBe(suggestion.id);
    expect(copy.gameData.segments).toHaveLength(2);
    copy.gameData.segments.forEach((segment, index) => {
      expect(segment.id).not.toBe(lesson.gameData.segments[index].id);
      expect(JSON.parse(copiedSuggestion.dependencies[`gameData.segments.${index}.id`])).toBe(
        segment.id,
      );
    });
    expect(isSuggestionCurrent(copy, copiedSuggestion)).toBe(true);
    expect(getEntries(copy).map((entry) => entry.english)).toEqual(
      getEntries(lesson).map((entry) => entry.english),
    );
    expect(lesson).toEqual(before);
  });
});
