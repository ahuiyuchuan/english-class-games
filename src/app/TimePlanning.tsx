/** 将真实预设差异与拆课候选连接到现有保存机制，不通过模型直接写库。 @author ahui */
import { useRef, useState } from 'react';
import type { AssetMap } from '../platform/types';
import type { PresetId, WordBeatLesson, WordBeatSuggestion } from '../games/word-beat/model';
import { compileWordBeat, getEntries, PRESETS } from '../games/word-beat/rules';
import { applySuggestion, createPresetSuggestion } from '../games/word-beat/suggestions';
import { proposeLessonSplit } from '../games/word-beat/planning';
import { saveLesson } from '../platform/repository';
import { Button, Modal, Notice } from '../shared/ui';

/** 计划绑定完整输入快照；保存失败仅重试未成功副本，快速连点共享同一互斥标记。 */
export function TimePlanning({
  lesson,
  assets,
  onSuggestion,
  onSavingChange,
}: {
  lesson: WordBeatLesson;
  assets: AssetMap;
  onSuggestion: (suggestion: WordBeatSuggestion) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<ReturnType<typeof proposeLessonSplit>>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const source = useRef(''),
    saving = useRef(false);
  const dependency = JSON.stringify([lesson, assets]);
  const stale = source.current !== dependency;
  return (
    <details>
      <summary>比较练习目标／预览拆为多课</summary>
      <div className="stack-sm">
        <small>
          比较整课真实安排，手动与锁定参数保持。预设可能调整允许修改的
          BPM，须在差异中确认，不自动应用。
        </small>
        {(Object.keys(PRESETS) as PresetId[]).map((preset) => {
          const suggestion = createPresetSuggestion(lesson, preset);
          let label = '请先修正输入或准备声音';
          try {
            const candidate = suggestion ? applySuggestion(lesson, suggestion) : lesson;
            label = `${(compileWordBeat(candidate, assets).durationMs / 1000).toFixed(1)} 秒`;
          } catch {
            /* 真实检查不通过时不填估计值。 */
          }
          return (
            <div className="row spread" key={preset}>
              <span>
                {PRESETS[preset].name} · {label}
              </span>
              <Button
                disabled={!suggestion}
                onClick={() => {
                  if (suggestion) onSuggestion(suggestion);
                }}
              >
                查看实际差异
              </Button>
            </div>
          );
        })}
        <Button
          onClick={() => {
            try {
              const parts = proposeLessonSplit(lesson, assets);
              if (!parts.length) throw new Error('整课已可在目标内保留，无需拆课。');
              setPlan(parts);
              setSaved([]);
              source.current = dependency;
              setError('');
              setOpen(true);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : '无法计算拆课方案。');
            }
          }}
        >
          预览整课按目标拆分（保留原课）
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
        <Modal
          open={open}
          onOpenChange={(value) => {
            if (!saving.current) setOpen(value);
          }}
          title="确认创建独立课件副本"
          footer={
            <>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                关闭预览
              </Button>
              <Button
                disabled={busy || stale || saved.length === plan.length}
                onClick={() =>
                  void (async () => {
                    if (saving.current || stale) return;
                    saving.current = true;
                    onSavingChange(true);
                    setBusy(true);
                    setError('');
                    try {
                      for (const part of plan) {
                        if (saved.includes(part.lesson.id)) continue;
                        await saveLesson(part.lesson, 0);
                        setSaved((previous) => [...previous, part.lesson.id]);
                      }
                    } catch (cause) {
                      setError(
                        `部分创建未完成，成功副本已保留；可重试未完成项。${cause instanceof Error ? cause.message : ''}`,
                      );
                    } finally {
                      saving.current = false;
                      onSavingChange(false);
                      setBusy(false);
                    }
                  })()
                }
              >
                确认创建 {plan.length - saved.length} 份副本
              </Button>
            </>
          }
        >
          <p>
            全部 {getEntries(lesson).length} 条保留，原课不变。共 {plan.length} 课；已创建{' '}
            {saved.length} 课。创建后在“我的课件”查看。
          </p>
          {stale && <Notice tone="error">原课或素材已改变，请关闭后重新计算。</Notice>}
          {plan.map((part) => (
            <div className="panel panel-compact" key={part.lesson.id}>
              <strong>
                {part.lesson.name} · {(part.durationMs / 1000).toFixed(1)} 秒
                {part.durationMs > lesson.gameData.targetDurationMs
                  ? '（单条仍超目标，请手动调整）'
                  : ''}
              </strong>
              <p>
                {getEntries(part.lesson)
                  .map((entry) => entry.english)
                  .join(' · ')}
              </p>
            </div>
          ))}
          {error && <Notice tone="error">{error}</Notice>}
        </Modal>
      </div>
    </details>
  );
}
