/** 单词节拍的新课默认表单；由游戏页面注册，公共设置页不解释玩法字段。 @author ahui */
import { WORD_BEAT_HELP } from '../games/word-beat/settingHelp';
import { useEffect, useRef, useState } from 'react';
import type { GamePreferencesEditorProps } from './game-views';
import { createWordBeatLesson, PRESETS } from '../games/word-beat/rules';
import { validateWordBeatPreferences } from '../games/word-beat/preferences';
import { Button, Field, InputField, Notice } from '../shared/ui';
import { VoiceFields } from './Wizard';

/**
 * 表单保留尚未完成的数字文本，只有主动保存时才生成已校验的游戏默认值。
 * 初值复制一次；上层查询刷新不覆盖教师尚未提交的修改。
 */
export function WordBeatPreferencesEditor({
  active = true,
  value,
  voices,
  onSave,
  onDraftChange,
  busy,
}: GamePreferencesEditorProps) {
  const [initial] = useState(() => validateWordBeatPreferences(value));
  const [voiceLesson, setVoiceLesson] = useState(() => {
    const lesson = createWordBeatLesson([]);
    lesson.gameData.voices = {
      ...lesson.gameData.voices,
      englishVoiceId: initial.englishVoiceId,
      chineseVoiceId: initial.chineseVoiceId,
      englishRate: initial.englishRate,
      chineseRate: initial.chineseRate,
    };
    return lesson;
  });
  const [defaults, setDefaults] = useState(() => ({
    preset: initial.preset,
    soundMode: initial.soundMode,
    displayMode: initial.displayMode,
    progression: initial.progression,
  }));
  const [targetMinutes, setTargetMinutes] = useState(String(initial.targetDurationMs / 60_000));
  const rateInputs = [
    voiceLesson.draftInputs?.[`${voiceLesson.id}.englishRate`]?.raw,
    voiceLesson.draftInputs?.[`${voiceLesson.id}.chineseRate`]?.raw,
  ];
  // 不只比较可保存的数值：清空数字框等未完成输入同样会在离开时丢失。
  const draft = JSON.stringify({
    voices: {
      ...voiceLesson.gameData.voices,
      englishVoiceId: voiceLesson.gameData.voices.englishVoiceId || undefined,
      chineseVoiceId: voiceLesson.gameData.voices.chineseVoiceId || undefined,
    },
    defaults,
    targetMinutes,
    rateInputs,
  });
  const [savedDraft, setSavedDraft] = useState(draft);
  const saving = useRef(false);
  const dirty = draft !== savedDraft;
  useEffect(() => {
    onDraftChange?.(dirty);
  }, [dirty, onDraftChange]);
  const targetValid =
    targetMinutes.trim() !== '' &&
    Number.isFinite(Number(targetMinutes)) &&
    Number(targetMinutes) >= 1 &&
    Number(targetMinutes) <= 30;

  return (
    <div className="stack">
      <VoiceFields lesson={voiceLesson} voices={voices} onChange={setVoiceLesson} active={active} />
      <h2>单词节拍 · 新课制作默认</h2>
      <Notice tone="ai">
        这些参数作为下次智能制作的起点。只有点击保存才生效，不改变正在编辑或已有的课件。
      </Notice>
      <div className="grid-two">
        <Field label="练习预设">
          <select
            className="input"
            aria-label="新课默认练习预设"
            value={defaults.preset}
            onChange={(event) =>
              setDefaults({ ...defaults, preset: event.target.value as typeof defaults.preset })
            }
          >
            {Object.entries(PRESETS).map(([id, preset]) => (
              <option key={id} value={id}>
                {preset.name}
              </option>
            ))}
          </select>
        </Field>
        <InputField
          label="目标时长（分钟）"
          type="number"
          min={1}
          max={30}
          step="any"
          value={targetMinutes}
          hint="1～30 分钟，仅作为智能时间建议的参考。"
          error={targetValid ? undefined : '请输入 1～30 分钟，当前输入尚未保存。'}
          onChange={(event) => setTargetMinutes(event.target.value)}
        />
        <Field label="练习模式" help={WORD_BEAT_HELP.mode}>
          <select
            className="input"
            aria-label="新课默认声音模式"
            value={defaults.soundMode}
            onChange={(event) =>
              setDefaults({
                ...defaults,
                soundMode: event.target.value as typeof defaults.soundMode,
              })
            }
          >
            <option value="voiced">配音跟读</option>
            <option value="teacher">文字领读 · 教师示范</option>
            <option value="chorus">学生自主齐读 · 无示范直接朗读</option>
          </select>
        </Field>
        <Field label="展示模式" help={WORD_BEAT_HELP.display}>
          <select
            className="input"
            aria-label="新课默认展示模式"
            value={defaults.displayMode}
            onChange={(event) =>
              setDefaults({
                ...defaults,
                displayMode: event.target.value as typeof defaults.displayMode,
              })
            }
          >
            <option value="centered">居中大词</option>
            <option value="blocks">节奏方块</option>
          </select>
        </Field>
        <Field label="课堂推进方式" help={WORD_BEAT_HELP.progression}>
          <select
            className="input"
            aria-label="新课默认课堂推进方式"
            value={defaults.progression}
            onChange={(event) =>
              setDefaults({
                ...defaults,
                progression: event.target.value as typeof defaults.progression,
              })
            }
          >
            <option value="step">逐词等待教师</option>
            <option value="auto">自动推进</option>
          </select>
        </Field>
      </div>
      <Button
        variant="primary"
        busy={busy}
        disabled={busy || !targetValid || rateInputs.some((raw) => raw !== undefined)}
        onClick={() => {
          if (saving.current) return;
          saving.current = true;
          // 成功只确认本次提交快照；等待期间继续编辑的输入不能被误标为已保存。
          void onSave({
            ...voiceLesson.gameData.voices,
            englishVoiceId: voiceLesson.gameData.voices.englishVoiceId || undefined,
            chineseVoiceId: voiceLesson.gameData.voices.chineseVoiceId || undefined,
            ...defaults,
            targetDurationMs: Math.round(Number(targetMinutes) * 60_000),
          })
            .then(() => setSavedDraft(draft))
            .catch(() => {
              // 公共设置页展示真实失败原因；保留输入和上次成功基线，允许修复后重试。
            })
            .finally(() => {
              saving.current = false;
            });
        }}
      >
        保存新课默认
      </Button>
    </div>
  );
}
