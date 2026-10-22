/**
 * 单词节拍的身份位置声明。导入平台仅执行这些精确位置，不遍历替换教学字符串。
 * 草稿字段定位属于平台容器，由原生层随同一映射更新。
 * @author ahui
 */
import type { GameIdentityLayout } from '../../platform/types';
import type { WordBeatLesson } from './model';

/** JSON Pointer 中的键按标准转义，不把义项、字段名中的斜杠解释为层级。 */
function pointerKey(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * 声明真实对象及历史建议中的引用；历史差异中的条目副本只引用已有身份。
 * @param lesson 已通过游戏结构校验的完整修订，不改变原对象。
 * @returns 与该修订相对应的身份位置，双修订由导入服务统一分配新标识。
 */
export function describeWordBeatIdentities(lesson: WordBeatLesson): GameIdentityLayout {
  const layout: GameIdentityLayout = { identities: [], references: [], encodedReferences: [] };
  lesson.gameData.segments.forEach((segment, segmentIndex) => {
    const base = `/gameData/segments/${segmentIndex}`;
    layout.identities.push(`${base}/id`);
    segment.entries.forEach((_entry, index) => {
      layout.identities.push(`${base}/entries/${index}/id`);
    });
  });
  Object.keys(lesson.gameData.slogans).forEach((kind) => {
    layout.identities.push(`/gameData/slogans/${pointerKey(kind)}/id`);
  });
  (lesson.gameData.suggestionHistory ?? []).forEach((suggestion, index) => {
    const base = `/gameData/suggestionHistory/${index}`;
    layout.identities.push(`${base}/id`);
    suggestion.changes.forEach((change, changeIndex) => {
      const changeBase = `${base}/changes/${changeIndex}`;
      if (change.objectId !== undefined) layout.references.push(`${changeBase}/objectId`);
      // 洗牌差异携带整段条目副本，只有其 id 是内部身份，英文和来源保持原文。
      if (change.path.endsWith('.entries')) {
        for (const side of ['before', 'after'] as const) {
          const entries = change[side];
          if (Array.isArray(entries)) {
            entries.forEach((entry, entryIndex) => {
              if (entry && typeof entry === 'object' && typeof entry.id === 'string')
                layout.references.push(`${changeBase}/${side}/${entryIndex}/id`);
            });
          }
        }
      }
    });
    Object.entries(suggestion.dependencies).forEach(([dependency, value]) => {
      try {
        const parsed: unknown = JSON.parse(value);
        const references: string[] = [];
        if (dependency.endsWith('.id') && typeof parsed === 'string') references.push('');
        if (dependency.endsWith('.entries') && Array.isArray(parsed)) {
          parsed.forEach((entry, entryIndex) => {
            if (entry && typeof entry === 'object' && typeof entry.id === 'string')
              references.push(`/${entryIndex}/id`);
          });
        }
        // 音频依赖中的 assetId 也必须随导入映射；普通文本不作身份替换。
        layout.encodedReferences!.push({
          path: `${base}/dependencies/${pointerKey(dependency)}`,
          references,
        });
      } catch {
        // 历史未提供字段可记录为 "undefined"，它没有可映射的 JSON 引用。
      }
    });
  });
  return layout;
}
