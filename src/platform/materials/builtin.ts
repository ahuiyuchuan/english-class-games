/** 固定来源词库在构建时内嵌；此入口不访问网络。 @author ahui */
import type { DictionaryEntry } from './types';

/** 异步模块加载仅分割桌面安装资源；JSON 随安装包分发，首次断网也可使用。 */
export async function getBuiltinDictionary(): Promise<DictionaryEntry[]> {
  const data = await import('../../../resources/dictionary/high-school.json');
  return data.default as DictionaryEntry[];
}
