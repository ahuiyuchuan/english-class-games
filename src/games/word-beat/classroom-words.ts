/**
 * 课堂文字草稿的纯校验与变化判断；复用正式英文／释义边界，不改写原输入。
 * 本模块不推断词义、条目类型或拍数，也不替代正式编排中的声音匹配校验。
 * @author ahui
 */
import type { WordBeatLesson } from './model';
import { getEntries } from './rules';

/** 当前文字编辑字段；词表身份和排序由独立的结构校验／统一完成负责。 */
export type ClassroomWordField = 'english' | 'meaning';

/**
 * 返回单字段的真实错误；长度按 trim 后的 Unicode 字符计数，控制字符检查原文。
 * @param field 英文或教学释义；英文不可空，空释义沿用正式规则允许。
 * @param raw 未截断、未规范化的教师输入；不得用校验结果覆盖该输入。
 * @returns 无错误时为空字符串；否则给出可在对应字段旁显示的修正说明。
 */
export function classroomWordFieldError(field: ClassroomWordField, raw: string): string {
  const length = [...raw.trim()].length;
  if (field === 'english') {
    if (length < 1 || length > 120 || /[\u0000-\u001f\u007f]/u.test(raw))
      return '英文需为1～120个字符，不能含控制字符。';
  } else if (length > 200 || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return '释义不能超过200个字符或含控制字符。';
  }
  return '';
}

/**
 * 按界面顺序返回本词第一项文字错误，供父级统一完成／播放保护使用。
 * @param english 英文原始输入，含空白、超长及未完成输入。
 * @param meaning 教学释义原始输入；空字符串有效。
 * @returns 无错误时为空字符串；不检查音频、拍数或其他词条。
 */
export function classroomWordError(english: string, meaning: string): string {
  return classroomWordFieldError('english', english) || classroomWordFieldError('meaning', meaning);
}

/**
 * 检查实际正文是否变化，用于决定已校验的新时间轴是否需要安装。
 * @param before 最近完成的课堂副本；不应传入未完成草稿。
 * @param after 新的完整候选；调用方仍须独立校验条目身份及模式变化。
 * @returns 英文／释义、条目集合或顺序变化时为 true；音量、来源及节奏变化不计入。
 */
export function classroomWordsChanged(before: WordBeatLesson, after: WordBeatLesson): boolean {
  const previous = getEntries(before);
  const next = getEntries(after);
  return (
    previous.length !== next.length ||
    next.some(
      (entry, index) =>
        entry.id !== previous[index]?.id ||
        entry.english !== previous[index]?.english ||
        entry.meaning !== previous[index]?.meaning,
    )
  );
}

/**
 * 判断词表集合／顺序是否改变，用于课中统一完成前说明必须返回开始页。
 * 只比较现有组内的稳定ID，不把文字、轮数、拍数或分组名称误当成结构改变。
 * @param before 最近完成的课堂副本。
 * @param after 当前完整词表草稿，不改写任一对象。
 * @returns 增删词或组内顺序变化为 true；分组集合变化也为 true，仍由存储门禁拒绝。
 */
export function classroomWordStructureChanged(
  before: WordBeatLesson,
  after: WordBeatLesson,
): boolean {
  return (
    before.gameData.segments.length !== after.gameData.segments.length ||
    after.gameData.segments.some((segment, index) => {
      const previous = before.gameData.segments[index];
      return (
        segment.id !== previous?.id ||
        segment.entries.length !== previous.entries.length ||
        segment.entries.some((entry, entryIndex) => entry.id !== previous.entries[entryIndex]?.id)
      );
    })
  );
}
