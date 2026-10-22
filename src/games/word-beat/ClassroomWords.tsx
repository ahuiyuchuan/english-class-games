/** 课堂同一选词下的文字草稿；统一完成才保存，组件自身不持久化。 @author ahui */
import { useId } from 'react';
import { normalizeSpeechText } from '../../shared/ai/random';
import { HelpTip } from '../../shared/ui/HelpTip';
import type { WordBeatEntry, WordBeatLesson } from './model';
import { classroomWordFieldError } from './classroom-words';
import { getEntries } from './rules';

/**
 * 直接保留原始输入，错误就近展示；还原只通知父级取消当前词文字草稿。
 * 与轮数／拍数共用选词和设置布局，不创建独立保存、类型推断或声音制作流程。
 */
export function ClassroomWords({
  entry,
  savedEntry,
  lesson,
  onChange,
  onRestore,
}: {
  entry: WordBeatEntry;
  /** 最近一次完成的文字值，用于判断差异及还原；不能传原课件冒充最近值。 */
  savedEntry?: WordBeatEntry;
  lesson: WordBeatLesson;
  onChange: (english: string, meaning: string) => void;
  onRestore: () => void;
}) {
  const id = useId();
  const englishError = classroomWordFieldError('english', entry.english);
  const meaningError = classroomWordFieldError('meaning', entry.meaning);
  const changed =
    savedEntry && (entry.english !== savedEntry.english || entry.meaning !== savedEntry.meaning);
  // 同词仅作为教学提醒：用独立位置提示，不合并不同义项，也不改变声音匹配规则。
  const duplicatePositions = englishError
    ? []
    : getEntries(lesson).flatMap((item, index) =>
        item.id !== entry.id &&
        normalizeSpeechText(item.english).toLowerCase() ===
          normalizeSpeechText(entry.english).toLowerCase()
          ? [index + 1]
          : [],
      );
  return (
    <div className="ecg-rhythm-fields" id="classroom-word-editor" tabIndex={-1}>
      <div className="ecg-rhythm-field ecg-settings-field">
        <div className="setting-label">
          <label htmlFor={`${id}-english`}>英文／短语</label>
          <HelpTip label="英文／短语">
            用于课堂临时纠错或替换现有词，保留条目、词序、类型、轮数和拍数。英文需为1～120个字符；配音与改后英文不匹配时，必须先处理声音问题才能完成设置。
          </HelpTip>
        </div>
        <input
          id={`${id}-english`}
          className="input"
          type="text"
          value={entry.english}
          aria-invalid={Boolean(englishError)}
          aria-describedby={`${id}-summary${englishError ? ` ${id}-english-error` : ''}`}
          onChange={(event) => onChange(event.target.value, entry.meaning)}
        />
        {englishError && (
          <p id={`${id}-english-error`} className="ecg-volume-error" role="alert">
            {englishError}
          </p>
        )}
      </div>
      <div className="ecg-rhythm-field ecg-settings-field">
        <div className="setting-label">
          <label htmlFor={`${id}-meaning`}>教学释义</label>
          <HelpTip label="教学释义">
            最多200个字符，不含换行等控制字符，可以留空仅练习英文。修改只影响该词的课堂显示，不自动推测新词义；已有材料来源与原配音保留，统一由底部完成设置保存。
          </HelpTip>
        </div>
        <textarea
          id={`${id}-meaning`}
          className="input"
          rows={2}
          value={entry.meaning}
          aria-invalid={Boolean(meaningError)}
          aria-describedby={`${id}-summary${meaningError ? ` ${id}-meaning-error` : ''}`}
          onChange={(event) => onChange(entry.english, event.target.value)}
        />
        {meaningError && (
          <p id={`${id}-meaning-error`} className="ecg-volume-error" role="alert">
            {meaningError}
          </p>
        )}
      </div>
      <p id={`${id}-summary`}>
        {savedEntry ? '当前词的文字修改' : '新增词语'}随底部完成设置统一保存。
        {!entry.meaning.trim() && !meaningError && ' 释义留空，仅练习英文。'}
      </p>
      {duplicatePositions.length > 0 && (
        <p>与本课第 {duplicatePositions.join('、')} 词英文相同，各自保留，可继续设置。</p>
      )}
      {changed && (
        <button type="button" onClick={onRestore}>
          还原此词文字
        </button>
      )}
    </div>
  );
}
