/** 齐读逐词与范围字段；只编辑父级草稿，由统一完成校验／保存。 @author ahui */
import type { WordBeatEntry, WordBeatLesson } from './model';
import { getEntries } from './rules';
import { HelpTip } from '../../shared/ui/HelpTip';
import { WORD_BEAT_HELP } from './settingHelp';
import {
  classroomRhythmError,
  getClassroomChorus,
  previewClassroomRhythm,
  type ClassroomRhythmBulk,
  type ClassroomRhythmDraft,
} from './classroom-rhythm';

/**
 * 字段锁定和手动来源独立保留；不把只读范围预览整体写回逐词草稿。
 * 原始非法组合保留在父级，收起设置不能绕过完成／播放保护。
 */
export function ClassroomRhythmFields({
  entry,
  previewEntry,
  draft,
  onDraft,
  onChange,
}: {
  entry: WordBeatEntry;
  previewEntry: WordBeatEntry;
  draft: ClassroomRhythmDraft | null;
  onDraft: (draft: ClassroomRhythmDraft | null) => void;
  onChange: (chorus: NonNullable<WordBeatEntry['chorus']>) => void;
}) {
  const chorus = getClassroomChorus(entry);
  const preview = getClassroomChorus(previewEntry);
  const raw = draft ?? {
    id: entry.id,
    beats: String(preview.beats.value),
    beatsPerRead: String(preview.beatsPerRead.value),
    edited: [],
  };
  const error = classroomRhythmError(raw.beats, raw.beatsPerRead);
  const change = (field: 'beats' | 'beatsPerRead', value: string) => {
    const next = { ...raw, [field]: value, edited: [...new Set([...raw.edited, field])] };
    if (classroomRhythmError(next.beats, next.beatsPerRead)) {
      onDraft(next);
      return;
    }
    // 当前可见候选包含教师先前的合法范围目标，后续逐词修改必须在此基础上进行。
    const updated = structuredClone(preview);
    // 只标记教师实际改变的字段；修正组合时另一项原始输入也必须进入候选。
    for (const key of next.edited)
      if (!updated[key].locked && Number(next[key]) !== updated[key].value)
        updated[key] = { ...updated[key], value: Number(next[key]), source: 'manual' };
    onChange(updated);
    onDraft(null);
  };
  return (
    <div className="ecg-rhythm-fields">
      <div className="ecg-rhythm-field">
        <div className="setting-label">
          <label htmlFor="classroom-chorus-beats">每轮总拍数</label>
          <HelpTip label="每轮总拍数">{WORD_BEAT_HELP.beats}</HelpTip>
        </div>
        <input
          id="classroom-chorus-beats"
          type="number"
          min={1}
          max={32}
          step={1}
          value={raw.beats}
          disabled={chorus.beats.locked}
          aria-invalid={Boolean(error)}
          aria-describedby="classroom-rhythm-feedback"
          onChange={(event) => change('beats', event.target.value)}
        />
      </div>
      <div className="ecg-rhythm-field">
        <div className="setting-label">
          <label htmlFor="classroom-chorus-per-read">每次朗读占拍</label>
          <HelpTip label="每次朗读占用拍数">{WORD_BEAT_HELP.perRead}</HelpTip>
        </div>
        <select
          id="classroom-chorus-per-read"
          aria-label="每次朗读占用拍数"
          value={raw.beatsPerRead}
          disabled={chorus.beatsPerRead.locked}
          aria-invalid={Boolean(error)}
          aria-describedby="classroom-rhythm-feedback"
          onChange={(event) => change('beatsPerRead', event.target.value)}
        >
          <option value="1">1 拍／次</option>
          <option value="2">2 拍／次</option>
        </select>
      </div>
      <p
        id="classroom-rhythm-feedback"
        className={error ? 'ecg-volume-error' : undefined}
        role={error ? 'alert' : undefined}
      >
        {error ||
          `每轮 ${preview.beats.value} 拍 ÷ 每次 ${preview.beatsPerRead.value} 拍 ＝ 读 ${preview.beats.value / preview.beatsPerRead.value} 次。${preview.beatsPerRead.value === 2 ? `每次持续两拍，${preview.beats.value / 2}个词块表示朗读次数，并非整轮拍数。` : '每拍提示朗读一次。'}`}
        {(chorus.beats.locked || chorus.beatsPerRead.locked) && ' 锁定项请回编辑器解锁。'}
      </p>
      <button
        type="button"
        disabled={chorus.beats.locked || chorus.beatsPerRead.locked}
        onClick={() => {
          onChange({
            beats: { ...chorus.beats, value: 4, source: 'manual' },
            beatsPerRead: { ...chorus.beatsPerRead, value: 1, source: 'manual' },
          });
          onDraft(null);
        }}
      >
        此词四拍读四次
      </button>
      {draft && <button onClick={() => onDraft(null)}>恢复当前词拍数</button>}
    </div>
  );
}

/**
 * 直接编辑即认领该统一目标；未编辑显示范围真实共同值，混合值不猜测默认。
 * 还原只取消对应字段，空白则仍是待修正输入；正式影响与保存复用原候选计算。
 */
export function ClassroomRhythmRange({
  lesson,
  scope,
  draft,
  onChange,
}: {
  lesson: WordBeatLesson;
  scope: string;
  draft: ClassroomRhythmBulk;
  onChange: (value: ClassroomRhythmBulk) => void;
}) {
  const preview = previewClassroomRhythm(lesson, draft, scope);
  const scoped = getEntries(lesson).filter(
    (entry) => scope === 'all' || entry.priority === (scope === 'priority'),
  );
  // 共同值包含受保护条目，准确表达该范围实际状态；写入资格仍由正式候选逐字段判断。
  const common = (field: 'beats' | 'beatsPerRead') => {
    const first = scoped[0] ? getClassroomChorus(scoped[0])[field].value : undefined;
    return first !== undefined &&
      scoped.every((entry) => getClassroomChorus(entry)[field].value === first)
      ? String(first)
      : '';
  };
  const pending = draft.beats !== null || draft.beatsPerRead !== null;
  return (
    <div className="ecg-rhythm-range">
      {(['beats', 'beatsPerRead'] as const).map((field) => (
        <div key={field} className="ecg-rhythm-field">
          <div className="setting-label">
            <label
              htmlFor={
                field === 'beats' ? 'classroom-chorus-bulk-beats' : 'classroom-chorus-bulk-per-read'
              }
            >
              {field === 'beats' ? '统一总拍数' : '统一每次占拍'}
            </label>
            <HelpTip label={field === 'beats' ? '统一总拍数' : '统一每次占拍'}>
              直接编辑只调整本项，范围沿用上方选择；默认保留手动值和锁定值。需要覆盖手动值时请明确勾选，锁定仍保留。还原只取消本项目标；不整除时整次完成阻止。
            </HelpTip>
          </div>
          <div className="ecg-rhythm-control">
            {field === 'beats' ? (
              <input
                id="classroom-chorus-bulk-beats"
                type="number"
                min={1}
                max={32}
                step={1}
                value={draft[field] ?? common(field)}
                placeholder="各词不同，输入统一拍数"
                aria-describedby="classroom-rhythm-range-feedback"
                aria-invalid={draft[field] !== null && Boolean(preview.error)}
                onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
              />
            ) : (
              <select
                id="classroom-chorus-bulk-per-read"
                value={draft[field] ?? common(field)}
                aria-describedby="classroom-rhythm-range-feedback"
                aria-invalid={draft[field] !== null && Boolean(preview.error)}
                onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
              >
                <option value="" disabled>
                  各词不同
                </option>
                <option value="1">1 拍／次</option>
                <option value="2">2 拍／次</option>
              </select>
            )}
            <button
              className="ecg-rhythm-restore"
              aria-label={field === 'beats' ? '还原统一总拍数' : '还原统一每次占拍'}
              disabled={draft[field] === null}
              onClick={() => onChange({ ...draft, [field]: null })}
            >
              还原
            </button>
          </div>
        </div>
      ))}
      <p
        id="classroom-rhythm-range-feedback"
        className={preview.error ? 'ecg-volume-error' : undefined}
        role={preview.error ? 'alert' : undefined}
      >
        {preview.error ||
          (pending
            ? `将调整 ${preview.changed} 词，保留 ${preview.protectedFields} 个手动或锁定字段；底部完成设置统一保存。`
            : '直接编辑需要统一的项目；未编辑的项目保留各词原安排。')}
      </p>
      <button type="button" onClick={() => onChange({ ...draft, beats: '4', beatsPerRead: '1' })}>
        范围内四拍读四次
      </button>
    </div>
  );
}
