/** 以受控真实时长夹具验证教学规则；不声称验证了Windows系统语音。 @author ahui */
import { describe, expect, it } from 'vitest';
import type { AssetMap, AudioAsset, TeachingEntry } from '../../platform/types';
import {
  applyPreset,
  audioMatches,
  bindAudio,
  bindRecording,
  compileWordBeat,
  createWordBeatLesson,
  getAudioRequests,
  getAudioProductionSummary,
  getEntries,
  getEntryTiming,
  getPreparationState,
  getVoiceSettings,
  getWordBeatAssetRole,
  refreshAudioDependencies,
  requiredAssets,
  resolveSloganText,
  setEntryPriority,
  setEntryType,
  validateWordBeat,
} from './rules';
import {
  applySuggestion,
  copyLesson,
  createTimeSuggestions,
  createPresetSuggestion,
  getDurationGuidance,
  getSuggestionHistory,
  ignoreSuggestion,
  isSuggestionCurrent,
  rememberSuggestion,
  remixLesson,
  replaceMaterials,
} from './suggestions';

/** 每个位置都有独立ID，重复英文不被测试工具提前合并。 */
function entries(count: number): TeachingEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `input-${index}`,
    english: `word${index}`,
    meaning: `释义${index}`,
    priority: false,
  }));
}

/** 只供规则测试使用的音频元信息；实际设备合成另做集成验收。 */
function asset(id: string, durationMs = 900): AudioAsset {
  return {
    assetId: id,
    mimeType: 'audio/wav',
    byteLength: durationMs * 44,
    durationMs,
    sha256: 'a'.repeat(64),
  };
}

function voiced(count: number, durationMs = 900) {
  let lesson = applyPreset(createWordBeatLesson(entries(count), { seed: 123 }), 'regular');
  lesson.gameData.voices.englishVoiceId = 'en-test';
  lesson.gameData.slogans.opening.enabled = false;
  lesson.gameData.slogans.closing.enabled = false;
  const assets: AssetMap = {};
  for (const request of getAudioRequests(lesson, assets)) {
    const audio = asset(request.objectId, durationMs);
    assets[audio.assetId] = audio;
    lesson = bindAudio(lesson, request.objectId, audio, request);
  }
  return { lesson, assets };
}

describe('单词节拍预设与整拍编排', () => {
  it('真实采样元信息超预算在准备前定位语音，背景音乐不占语音缓存', () => {
    const { lesson, assets } = voiced(1);
    const voice = assets[getEntries(lesson)[0].audio!.assetId!];
    voice.frameCount = 1_440_000;
    voice.channels = 16;
    expect(validateWordBeat(lesson, assets)).toContainEqual(
      expect.objectContaining({ code: 'SOUND_DECODE_BUDGET', objectId: getEntries(lesson)[0].id }),
    );
    voice.channels = 8;
    const music = { ...asset('music'), frameCount: 28_800_000, channels: 2 };
    assets.music = music;
    lesson.gameData.music = { enabled: true, assetId: 'music', loop: true };
    expect(
      validateWordBeat(lesson, assets).some((issue) => issue.code === 'SOUND_DECODE_BUDGET'),
    ).toBe(false);
    expect(getWordBeatAssetRole(lesson, 'music')).toBe('music');
    expect(getWordBeatAssetRole(lesson, voice.assetId)).toBe('speech');
    lesson.gameData.music.assetId = voice.assetId;
    expect(getWordBeatAssetRole(lesson, voice.assetId)).toBe('speech');
    expect(() => getWordBeatAssetRole(lesson, 'unrelated')).toThrow(/不属于/);
  });
  it('首次保留配音跟读及开场/收尾，缺声音不能伪装就绪', () => {
    const lesson = createWordBeatLesson(entries(1), { seed: 1 });
    expect(lesson.gameData.soundMode).toBe('voiced');
    expect(lesson.gameData.progression).toBe('auto');
    expect(lesson.gameData.displayMode).toBe('blocks');
    expect(lesson.gameData.slogans.opening.enabled).toBe(true);
    expect(lesson.gameData.slogans.transition.enabled).toBe(false);
    expect(getPreparationState(lesson, {})).toBe('pending');
    expect(() => compileWordBeat(lesson, {})).toThrow();
  });

  it('允许教师明确选择逐词等待，自动默认不覆盖其选择', () => {
    const lesson = createWordBeatLesson(entries(1), { progression: 'step', seed: 1 });
    expect(lesson.gameData.progression).toBe('step');
  });

  it('AI-06：900毫秒音频在100BPM占2拍，2轮词练习4800毫秒', () => {
    const { lesson, assets } = voiced(1);
    const timing = getEntryTiming(lesson, getEntries(lesson)[0], assets);
    expect(timing).toMatchObject({ beatMs: 600, modelBeats: 2, followBeats: 2, durationMs: 4800 });
    expect(compileWordBeat(lesson, assets).durationMs).toBe(7200);
  });

  it('AI-07：短语额外保留1拍，词练习6000毫秒', () => {
    const { lesson, assets } = voiced(1);
    getEntries(lesson)[0].entryType = 'phrase';
    expect(getEntryTiming(lesson, getEntries(lesson)[0], assets).durationMs).toBe(6000);
  });

  it('AI-15：11条10+1分段，总61800毫秒，没有段边界重复转场', () => {
    const { lesson, assets } = voiced(11);
    const plan = compileWordBeat(lesson, assets);
    expect(lesson.gameData.segments.map((segment) => segment.entries.length)).toEqual([10, 1]);
    expect(plan.durationMs).toBe(61_800);
    expect(
      plan.cues.filter((cue) => cue.kind === 'preparation').map((cue) => cue.durationMs),
    ).toEqual([2400, 1200]);
    expect(plan.cues.filter((cue) => cue.kind === 'transition')).toHaveLength(9);
  });

  it('AI-19：新建一轮无音色文字领读与无口号时可完整编排4800毫秒', () => {
    const lesson = createWordBeatLesson(entries(1), { soundMode: 'teacher', seed: 1 });
    lesson.gameData.slogans.opening.enabled = false;
    lesson.gameData.slogans.closing.enabled = false;
    expect(getAudioRequests(lesson, {})).toEqual([]);
    expect(compileWordBeat(lesson, {}).durationMs).toBe(4800);
  });

  it('空段完全跳过；首个非空段用整课准备，全空禁止运行', () => {
    const { lesson, assets } = voiced(1);
    lesson.gameData.segments.unshift({ id: 'empty', name: '空段', entries: [] });
    expect(compileWordBeat(lesson, assets).durationMs).toBe(7200);
    expect(compileWordBeat(lesson, assets).cues[0].sectionIndex).toBe(0);
    getEntries(lesson).forEach((entry) => {
      entry.meaning = '';
    });
    expect(() => compileWordBeat(lesson, assets)).not.toThrow();
    lesson.gameData.segments.forEach((segment) => {
      segment.entries = [];
    });
    expect(() => compileWordBeat(lesson, assets)).toThrow(/1～100/);
  });

  it('三种预设及教师手动轮数/跟读公式锁定保持正确', () => {
    const { lesson, assets } = voiced(2);
    const words = getEntries(lesson);
    words[0].rounds = { value: 4, source: 'manual', locked: false };
    words[1].follow.locked = true;
    const focus = applyPreset(lesson, 'focus');
    expect(focus.gameData.bpm.value).toBe(90);
    expect(getEntries(focus).map((entry) => entry.rounds.value)).toEqual([4, 3]);
    expect(getEntries(focus)[1].follow.preset).toBe('regular');
    const changed = setEntryPriority(focus, words[0].id, true);
    expect(getEntries(changed)[0].rounds.value).toBe(4);
    expect(getEntryTiming(applyPreset(lesson, 'quick'), words[0], assets).beatMs).toBeCloseTo(
      60_000 / 110,
    );
  });

  it('RUN-03：10400毫秒短语调到180BPM产生34跟读拍，拒绝编排', () => {
    const { lesson, assets } = voiced(1, 10_400);
    const current = applyPreset(lesson, 'focus');
    getEntries(current)[0].entryType = 'phrase';
    expect(() => compileWordBeat(current, assets)).not.toThrow();
    current.gameData.bpm.value = 180;
    expect(getEntryTiming(current, getEntries(current)[0], assets).followBeats).toBe(34);
    expect(() => compileWordBeat(current, assets)).toThrow(/32拍/);
  });
});

describe('真实声音依赖与检查门禁', () => {
  it('修改英文使锁定声音失效，修改无关释义不影响英文声音', () => {
    const { lesson, assets } = voiced(1);
    const entry = getEntries(lesson)[0];
    entry.meaning = '新教学释义';
    expect(validateWordBeat(lesson, assets).some((issue) => issue.code === 'SOUND_STALE')).toBe(
      false,
    );
    entry.soundLocked = true;
    entry.english = 'US';
    expect(validateWordBeat(lesson, assets).some((issue) => issue.code === 'SOUND_STALE')).toBe(
      true,
    );
    expect(audioMatches(entry.audio, 'us', 'en-test')).toBe(false);
  });

  it('录音不受系统音色/语速影响，改文本失效，恢复原文可重新匹配', () => {
    const { lesson, assets } = voiced(1);
    const id = getEntries(lesson)[0].id;
    const recording = asset('recording');
    assets.recording = recording;
    let current = bindRecording(lesson, id, recording);
    current.gameData.voices.englishVoiceId = 'another';
    current.gameData.voices.englishRate = 1.2;
    expect(validateWordBeat(current, assets).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const original = getEntries(current)[0].english;
    getEntries(current)[0].english = 'changed';
    current = refreshAudioDependencies(current);
    expect(getEntries(current)[0].audio?.status).toBe('stale');
    expect(getAudioRequests(current, assets)).toEqual([]);
    getEntries(current)[0].english = original;
    expect(getEntries(refreshAudioDependencies(current))[0].audio?.status).toBe('ready');
  });

  it('未打包的关闭素材不参与检查，静音仍需真实声音，损坏优先需修复', () => {
    const { lesson, assets } = voiced(2);
    lesson.gameData.volumes.voice = 0;
    const id = getEntries(lesson)[0].audio!.assetId!;
    delete assets[id];
    expect(getPreparationState(lesson, assets)).toBe('repair');
    lesson.gameData.soundMode = 'teacher';
    expect(requiredAssets(lesson)).toEqual([]);
    expect(() => compileWordBeat(lesson, assets)).not.toThrow();
  });

  it('未完成输入保留但不能用最近合法值绕过检查', () => {
    const { lesson, assets } = voiced(1);
    lesson.draftInputs = { bpm: { raw: '-', message: '请输入合法节奏。' } };
    expect(() => compileWordBeat(lesson, assets)).toThrow(/合法节奏/);
    expect(lesson.gameData.bpm.value).toBe(100);
  });

  it('绑定旧合成结果拒绝覆盖当前文本或声音设置', () => {
    const { lesson, assets } = voiced(1);
    getEntries(lesson)[0].english = 'changed';
    const request = getAudioRequests(lesson, assets)[0];
    getEntries(lesson)[0].english = 'newer';
    expect(() => bindAudio(lesson, request.objectId, asset('late'), request)).toThrow(/内容已变化/);
  });

  it('口号按展开文本限制；未知占位符定位错误，不编造声音', () => {
    const lesson = createWordBeatLesson(entries(1), { seed: 1 });
    lesson.gameData.slogans.opening.text = '{{wordCount}} 个词';
    expect(resolveSloganText(lesson, lesson.gameData.slogans.opening)).toBe('1 个词');
    lesson.gameData.slogans.opening.text = '{{secret}}';
    expect(validateWordBeat(lesson, {}).some((issue) => issue.code === 'SLOGAN_INVALID')).toBe(
      true,
    );
  });

  it('编辑无效口号保留原文及旧素材，不中断其他声音检查；恢复文本可重用', () => {
    const { lesson, assets } = voiced(1);
    const slogan = lesson.gameData.slogans.opening;
    slogan.enabled = true;
    const original = slogan.text;
    slogan.audio = {
      source: 'recording',
      assetId: 'opening',
      text: resolveSloganText(lesson, slogan),
      language: 'zh-CN',
      rate: 1,
      status: 'ready',
    };
    assets.opening = asset('opening');
    slogan.text = '{{unknown}}';
    const changed = refreshAudioDependencies(lesson);
    expect(changed.gameData.slogans.opening.text).toBe('{{unknown}}');
    expect(changed.gameData.slogans.opening.audio?.status).toBe('stale');
    expect(requiredAssets(changed)).toContain('opening');
    expect(validateWordBeat(changed, assets)).toContainEqual(
      expect.objectContaining({
        code: 'SLOGAN_INVALID',
        objectId: slogan.id,
        field: 'text',
      }),
    );
    changed.gameData.slogans.opening.text = original;
    expect(refreshAudioDependencies(changed).gameData.slogans.opening.audio?.status).toBe('ready');
  });
});

describe('可解释建议、改编及课件复用', () => {
  it('预设切换先展示稳定规则差异，手动、锁定以及无关编辑受到保护', () => {
    const { lesson } = voiced(3);
    getEntries(lesson)[0].rounds = { value: 5, source: 'manual', locked: false };
    getEntries(lesson)[1].follow.locked = true;
    lesson.gameData.bpm.locked = true;
    const suggestion = createPresetSuggestion(lesson, 'focus')!;
    expect(suggestion.ruleId).toBe('word-beat.preset');
    expect(lesson.gameData.preset).toBe('regular');
    getEntries(lesson)[2].meaning = '与练习预设无关';
    expect(isSuggestionCurrent(lesson, suggestion)).toBe(true);
    const changed = applySuggestion(lesson, suggestion);
    expect(changed.gameData.preset).toBe('focus');
    expect(changed.gameData.bpm.value).toBe(100);
    expect(getEntries(changed)[0].rounds.value).toBe(5);
    expect(getEntries(changed)[1].follow.preset).toBe('regular');
    expect(getEntries(changed)[2].rounds.value).toBe(3);
    expect(getSuggestionHistory(changed)[0].state).toBe('applied');
    expect(createPresetSuggestion(changed, 'focus')).toBeNull();
    getEntries(lesson)[2].rounds.locked = true;
    expect(() => applySuggestion(lesson, suggestion)).toThrow(/依赖已变化/);
  });

  it('时间与换一版建议编号对应最终规则目录，编号不混入版本', () => {
    const { lesson, assets } = voiced(11);
    lesson.gameData.targetDurationMs = 60_000;
    expect(createTimeSuggestions(lesson, assets)[0].ruleId).toBe('word-beat.duration');
    lesson.gameData.slogans.opening.enabled = true;
    expect(remixLesson(lesson, { seed: 44 })?.ruleId).toBe('word-beat.variant');
  });

  it('应用时间建议只减必要轮次并标记手动，不覆盖源课件', () => {
    const { lesson, assets } = voiced(11);
    lesson.gameData.targetDurationMs = 60_000;
    const suggestion = createTimeSuggestions(lesson, assets)[0];
    expect(suggestion.beforeDurationMs).toBe(61_800);
    expect(suggestion.afterDurationMs).toBe(59_400);
    const result = applySuggestion(lesson, suggestion);
    expect(getEntries(result)[0].rounds).toMatchObject({ value: 1, source: 'manual' });
    expect(getEntries(lesson)[0].rounds.value).toBe(2);
    expect(getEntries(applyPreset(result, 'focus'))[0].rounds.value).toBe(1);
  });

  it('无关释义编辑不失效，轮数或条目变化使旧建议不可应用', () => {
    const { lesson, assets } = voiced(11);
    lesson.gameData.targetDurationMs = 60_000;
    const suggestion = createTimeSuggestions(lesson, assets)[0];
    getEntries(lesson)[0].meaning = '无关编辑';
    lesson.revision += 1;
    expect(isSuggestionCurrent(lesson, suggestion)).toBe(true);
    getEntries(lesson)[0].rounds.value = 3;
    expect(isSuggestionCurrent(lesson, suggestion)).toBe(false);
    expect(() => applySuggestion(lesson, suggestion)).toThrow(/依赖已变化/);
  });

  it('没有超目标不制造时长差异，全部手动值不能自动压缩', () => {
    const { lesson, assets } = voiced(11);
    expect(createTimeSuggestions(lesson, assets)).toEqual([]);
    lesson.gameData.targetDurationMs = 60_000;
    getEntries(lesson).forEach((entry) => {
      entry.rounds.source = 'manual';
    });
    expect(createTimeSuggestions(lesson, assets)).toEqual([]);
  });

  it('时间建议保护手改开关、手改文本及来源未知的旧转场口号', () => {
    let current = applyPreset(
      createWordBeatLesson(entries(11), { soundMode: 'teacher', seed: 1 }),
      'regular',
    );
    current.gameData.voices.chineseVoiceId = 'zh-test';
    current.gameData.slogans.opening.enabled = false;
    current.gameData.slogans.closing.enabled = false;
    current.gameData.slogans.transition.enabled = true;
    current.gameData.targetDurationMs = 60_000;
    const assets: AssetMap = {};
    for (const request of getAudioRequests(current, assets)) {
      const prepared = asset(request.objectId, 900);
      assets[prepared.assetId] = prepared;
      current = bindAudio(current, request.objectId, prepared, request);
    }
    const automatic = createTimeSuggestions(current, assets)[0];
    expect(
      automatic.changes.some((change) => change.path === 'gameData.slogans.transition.enabled'),
    ).toBe(true);
    for (const field of ['enabledSource', 'textSource'] as const) {
      const manual = structuredClone(current);
      manual.gameData.slogans.transition[field] = 'manual';
      const suggestion = createTimeSuggestions(manual, assets)[0];
      expect(
        suggestion.changes.some(
          (change) => change.objectId === manual.gameData.slogans.transition.id,
        ),
      ).toBe(false);
      expect(isSuggestionCurrent(manual, automatic)).toBe(false);
    }
    delete current.gameData.slogans.transition.enabledSource;
    const legacy = createTimeSuggestions(current, assets)[0];
    expect(
      legacy.changes.some((change) => change.path === 'gameData.slogans.transition.enabled'),
    ).toBe(false);
  });

  it('无可自动修改项仍给出准确时长差额，延长建议始终不超过30分钟', () => {
    const current = createWordBeatLesson(entries(1), { soundMode: 'teacher', seed: 1 });
    current.gameData.targetDurationMs = 29 * 60_000;
    const guidance = getDurationGuidance(current, 35 * 60_000)!;
    expect(guidance).toContain('超出目标360.0秒');
    expect(guidance).toContain('延长至30分钟');
    expect(guidance).toContain('仍超出300.0秒');
    expect(guidance).toContain('比较练习目标／预览拆为多课');
    expect(guidance).toContain('保留原课与全部词条');
    current.gameData.targetDurationMs = 30 * 60_000;
    expect(getDurationGuidance(current, 35 * 60_000)).toContain('30分钟上限');
    expect(getDurationGuidance(current, 35 * 60_000)).not.toContain('延长');
    expect(getDurationGuidance(current, 29 * 60_000)).toBeUndefined();
    expect(getDurationGuidance(current)).toBeUndefined();
  });

  it('教师明确改回模板原句仍算手改，换一版不会默认替换', () => {
    const current = createWordBeatLesson(entries(1), { seed: 1 });
    Object.values(current.gameData.slogans).forEach((slogan) => {
      slogan.textSource = 'manual';
    });
    expect(remixLesson(current, { seed: 2 })).toBeNull();
    const explicit = remixLesson(current, { seed: 2, overrideManualSlogans: true })!;
    expect(applySuggestion(current, explicit).gameData.slogans.opening.textSource).toBe('template');
  });

  it('换材料保留课级和口号来源锁定，词数占位符变化仅使对应声音失效', () => {
    let current = createWordBeatLesson(entries(2), { soundMode: 'teacher', seed: 1 });
    current.gameData.voices.chineseVoiceId = 'zh-test';
    current.gameData.bpm.locked = true;
    Object.assign(current.gameData.slogans.opening, {
      text: '今天练习{{wordCount}}词',
      textSource: 'manual',
      locked: true,
    });
    const assets: AssetMap = {};
    for (const request of getAudioRequests(current, assets)) {
      const prepared = asset(request.objectId, 900);
      assets[prepared.assetId] = prepared;
      current = bindAudio(current, request.objectId, prepared, request);
    }
    const replacement = replaceMaterials(current, entries(3));
    expect(replacement.gameData.bpm).toEqual(current.gameData.bpm);
    expect(replacement.gameData.slogans.opening).toMatchObject({
      text: '今天练习{{wordCount}}词',
      textSource: 'manual',
      locked: true,
      enabled: true,
      audio: { status: 'stale' },
    });
    expect(replacement.gameData.slogans.closing.audio?.status).toBe('ready');
    expect(current.gameData.slogans.opening.audio?.status).toBe('ready');
    expect(resolveSloganText(replacement, replacement.gameData.slogans.opening)).toBe(
      '今天练习3词',
    );
  });

  it('固定seed得到相同改编，位置锁保持原位，编排不重抽模板', () => {
    const lesson = createWordBeatLesson(entries(6), { seed: 17 });
    getEntries(lesson)[2].positionLocked = true;
    const a = remixLesson(lesson, { seed: 321, shuffleEntries: true })!;
    const b = remixLesson(lesson, { seed: 321, shuffleEntries: true })!;
    expect(a.changes).toEqual(b.changes);
    const changed = applySuggestion(lesson, a);
    expect(getEntries(changed)[2].id).toBe(getEntries(lesson)[2].id);
    expect(changed.gameData.seed).toBe(321);
    expect(lesson.gameData.seed).toBe(17);
  });

  it('全部口号锁定且不允许其他变化时返回无变化', () => {
    const lesson = createWordBeatLesson(entries(1), { seed: 1 });
    Object.values(lesson.gameData.slogans).forEach((slogan) => {
      slogan.locked = true;
    });
    expect(remixLesson(lesson, { seed: 2 })).toBeNull();
  });

  it('换一版默认保留手改口号，明确允许也不能覆盖锁定口号', () => {
    const lesson = createWordBeatLesson(entries(1), { seed: 1 });
    lesson.gameData.slogans.opening.text = '跟着节拍一起复习';
    lesson.gameData.slogans.closing.text = '今日练习完成';
    lesson.gameData.slogans.closing.locked = true;
    expect(remixLesson(lesson, { seed: 3 })).toBeNull();
    const suggestion = remixLesson(lesson, { seed: 3, overrideManualSlogans: true })!;
    const changed = applySuggestion(lesson, suggestion);
    expect(changed.gameData.slogans.opening.text).not.toBe('跟着节拍一起复习');
    expect(changed.gameData.slogans.closing.text).toBe('今日练习完成');
    expect(changed.gameData.slogans.closing.locked).toBe(true);
    expect(lesson.gameData.slogans.opening.text).toBe('跟着节拍一起复习');
  });

  it('普通复制保留设置/锁定/声音；替换材料不继承条目手动值或录音', () => {
    const { lesson } = voiced(2);
    const first = getEntries(lesson)[0];
    first.rounds = { value: 7, source: 'manual', locked: true };
    first.positionLocked = true;
    const copy = copyLesson(lesson);
    expect(copy.id).not.toBe(lesson.id);
    expect(getEntries(copy)[0].id).not.toBe(first.id);
    expect(getEntries(copy)[0].rounds).toEqual(first.rounds);
    expect(getEntries(copy)[0].audio?.assetId).toBe(first.audio?.assetId);
    const replaced = replaceMaterials(copy, entries(2));
    expect(getEntries(replaced)[0].rounds.value).toBe(1);
    expect(getEntries(replaced)[0].positionLocked).toBe(false);
    expect(first.rounds.value).toBe(7);
  });

  it('副本未完成字段重新定位到新ID，换材料保留课级坏输入', () => {
    const { lesson } = voiced(1);
    const originalId = getEntries(lesson)[0].id;
    lesson.draftInputs = {
      bpm: { raw: '-', message: '节奏未完成' },
      [`${originalId}.rounds`]: { raw: '-', message: '轮次未完成', objectId: originalId },
    };
    const copied = copyLesson(lesson);
    const newId = getEntries(copied)[0].id;
    expect(copied.draftInputs?.[`${newId}.rounds`]).toMatchObject({ raw: '-', objectId: newId });
    expect(copied.draftInputs?.[`${originalId}.rounds`]).toBeUndefined();
    const replaced = replaceMaterials(copied, entries(1));
    expect(replaced.draftInputs).toEqual({ bpm: { raw: '-', message: '节奏未完成' } });
  });

  it('恢复准备只提供临时提示，不增加固定编排时长', () => {
    const { lesson, assets } = voiced(1);
    lesson.gameData.resumePreparationBeats = 2;
    const plan = compileWordBeat(lesson, assets);
    expect(plan.durationMs).toBe(7200);
    expect(plan.resumeCue).toMatchObject({
      kind: 'resume-preparation',
      durationMs: 1200,
      pulseIntervalMs: 600,
    });
  });

  it('AI-20：音色与语速逐字段继承，完全覆盖及录音不随课级声音变化', () => {
    const { lesson, assets } = voiced(3);
    const [voiceOnly, both, recording] = getEntries(lesson);
    voiceOnly.voiceOverrides = { voiceId: 'entry-voice' };
    both.voiceOverrides = { voiceId: 'fixed-voice', rate: 0.9 };
    let current = refreshAudioDependencies(lesson);
    for (const request of getAudioRequests(current, assets)) {
      const sound = asset(`override-${request.objectId}`);
      assets[sound.assetId] = sound;
      current = bindAudio(current, request.objectId, sound, request);
    }
    const recorded = asset('recorded');
    assets[recorded.assetId] = recorded;
    current = bindRecording(current, recording.id, recorded);
    current.gameData.voices.englishVoiceId = 'changed-default';
    current.gameData.voices.englishRate = 1.1;
    current = refreshAudioDependencies(current);
    const [first, second, third] = getEntries(current);
    expect(getVoiceSettings(current, 'en-US', first.voiceOverrides)).toEqual({
      voiceId: 'entry-voice',
      rate: 1.1,
    });
    expect(first.audio?.status).toBe('stale');
    expect(second.audio?.status).toBe('ready');
    expect(third.audio?.status).toBe('ready');
    expect(getAudioRequests(current, assets).map((request) => request.objectId)).toEqual([
      first.id,
    ]);
    first.voiceOverrides = undefined;
    expect(getVoiceSettings(current, 'en-US', first.voiceOverrides)).toEqual({
      voiceId: 'changed-default',
      rate: 1.1,
    });
  });

  it('条目设置变化后拒绝迟到合成结果，录音必须有实际大小及有限时长', () => {
    const { lesson, assets } = voiced(1);
    const entry = getEntries(lesson)[0];
    entry.voiceOverrides = { rate: 1.1 };
    const request = getAudioRequests(lesson, assets)[0];
    entry.voiceOverrides.rate = 1.2;
    expect(() => bindAudio(lesson, entry.id, asset('late'), request)).toThrow(/设置已变化/);
    expect(() => bindRecording(lesson, entry.id, { ...asset('bad'), byteLength: 0 })).toThrow();
    expect(() =>
      bindRecording(lesson, entry.id, { ...asset('bad'), durationMs: Infinity }),
    ).toThrow();
  });

  it('旧系统配音迟到时不替换教师后来明确导入的录音', () => {
    const { lesson, assets } = voiced(1);
    const entry = getEntries(lesson)[0];
    entry.audio = undefined;
    const request = getAudioRequests(lesson, assets)[0];
    const withRecording = bindRecording(lesson, entry.id, asset('teacher-recording'));
    expect(() => bindAudio(withRecording, entry.id, asset('late-system'), request)).toThrow(
      /教师录音/,
    );
    expect(getEntries(withRecording)[0].audio).toMatchObject({
      source: 'recording',
      assetId: 'teacher-recording',
    });
  });

  it('无效占位符、过长口号及控制字符不进入配音队列，仍可报告具体错误', () => {
    const { lesson, assets } = voiced(1);
    const opening = lesson.gameData.slogans.opening;
    opening.enabled = true;
    for (const text of ['{{unknown}}', 'a'.repeat(61), '准备\u0000开始']) {
      opening.text = text;
      expect(getAudioRequests(lesson, assets)).toEqual([]);
      expect(validateWordBeat(lesson, assets)).toContainEqual(
        expect.objectContaining({ code: 'SLOGAN_INVALID', objectId: opening.id }),
      );
    }
  });

  it('忽略建议在保存重开及无关编辑后有效，相关输入变化才重新提示', () => {
    const { lesson, assets } = voiced(11);
    lesson.gameData.targetDurationMs = 60_000;
    const suggestion = createTimeSuggestions(lesson, assets)[0];
    const remembered = rememberSuggestion(lesson, suggestion);
    expect(createTimeSuggestions(remembered, assets)[0].id).toBe(suggestion.id);
    const ignored = JSON.parse(JSON.stringify(ignoreSuggestion(remembered, suggestion)));
    getEntries(ignored)[0].meaning = '教师修改释义';
    ignored.revision += 1;
    expect(createTimeSuggestions(ignored, assets)).toEqual([]);
    expect(getSuggestionHistory(ignored)[0].state).toBe('ignored');
    getEntries(ignored)[0].rounds.locked = true;
    expect(getSuggestionHistory(ignored)[0].state).toBe('stale');
    expect(createTimeSuggestions(ignored, assets)).toHaveLength(1);
    const applied = applySuggestion(lesson, suggestion);
    expect(getSuggestionHistory(applied)[0].state).toBe('applied');
    applied.gameData.targetDurationMs = 120_000;
    expect(getSuggestionHistory(applied)[0].state).toBe('applied');
    expect(copyLesson(applied).gameData.suggestionHistory).toEqual([]);
  });

  it('声音完全逐项覆盖时，改未使用的默认音色不撤掉时间建议', () => {
    const { lesson, assets } = voiced(11);
    lesson.gameData.targetDurationMs = 60_000;
    getEntries(lesson).forEach((entry) => {
      entry.voiceOverrides = { voiceId: 'en-test', rate: 1 };
    });
    const suggestion = createTimeSuggestions(lesson, assets)[0];
    lesson.gameData.voices.englishVoiceId = 'unused';
    lesson.gameData.voices.englishRate = 1.1;
    expect(isSuggestionCurrent(lesson, suggestion)).toBe(true);
  });

  it('从旧条目换材料只复制教学字段，不把覆盖值或录音带给新位置', () => {
    const { lesson } = voiced(1);
    const old = getEntries(lesson)[0];
    old.voiceOverrides = { voiceId: 'private-voice', rate: 1.2 };
    old.audio!.source = 'recording';
    old.soundLocked = true;
    old.rounds = { value: 8, source: 'manual', locked: true };
    const copy = copyLesson(lesson);
    expect(getEntries(copy)[0].voiceOverrides).toEqual(old.voiceOverrides);
    const replacement = getEntries(replaceMaterials(lesson, [old]))[0];
    expect(replacement.voiceOverrides).toBeUndefined();
    expect(replacement.audio).toBeUndefined();
    expect(replacement.soundLocked).toBe(false);
    expect(replacement.rounds).toEqual({ value: 1, source: 'preset', locked: false });
  });

  it('目标达到30分钟上限仍超时，建议不提供无效的继续延长动作', () => {
    const { lesson, assets } = voiced(100, 12_000);
    lesson.gameData.targetDurationMs = 1_800_000;
    const suggestion = createTimeSuggestions(lesson, assets)[0];
    expect(suggestion.afterDurationMs).toBeGreaterThan(1_800_000);
    expect(suggestion.reason).toContain('30分钟上限');
    expect(suggestion.reason).not.toContain('可延长目标');
  });

  it('外部建议不能把合法容器变为坏结构，失败不改原课件', () => {
    const { lesson, assets } = voiced(11);
    lesson.gameData.targetDurationMs = 60_000;
    const suggestion = createTimeSuggestions(lesson, assets)[0];
    suggestion.changes = [
      {
        path: 'gameData.segments',
        before: structuredClone(lesson.gameData.segments),
        after: null,
        reason: '无效输入',
      },
    ];
    expect(() => applySuggestion(lesson, suggestion)).toThrow(/课件结构/);
    expect(getEntries(lesson)).toHaveLength(11);
  });

  it('默认换口号不依赖无关释义或目标时长，但改变口号锁定会使建议过期', () => {
    const lesson = createWordBeatLesson(entries(2), { seed: 1 });
    const suggestion = remixLesson(lesson, { seed: 2 })!;
    getEntries(lesson)[0].meaning = '修改本课释义';
    lesson.gameData.targetDurationMs = 120_000;
    expect(isSuggestionCurrent(lesson, suggestion)).toBe(true);
    lesson.gameData.slogans.opening.locked = true;
    expect(isSuggestionCurrent(lesson, suggestion)).toBe(false);
  });

  it('默认副本名遵守80字符限制，长课件名不造成新草稿无效', () => {
    const { lesson } = voiced(1);
    lesson.name = '高'.repeat(80);
    const copy = copyLesson(lesson);
    expect([...copy.name]).toHaveLength(80);
    expect(copy.name.endsWith('（副本）')).toBe(true);
    expect(validateWordBeat(copy, {}).some((issue) => issue.code === 'NAME_INVALID')).toBe(false);
    expect(lesson.name).toHaveLength(80);
  });

  it('同文本与音色仍按语言区分，语言改变必须重新生成系统声音', () => {
    const { lesson, assets } = voiced(1);
    lesson.gameData.voices.chineseVoiceId = 'en-test';
    const opening = lesson.gameData.slogans.opening;
    opening.enabled = true;
    opening.text = 'hello';
    opening.language = 'en-US';
    const request = getAudioRequests(lesson, assets)[0];
    const sound = asset('slogan');
    assets[sound.assetId] = sound;
    const bound = bindAudio(lesson, opening.id, sound, request);
    bound.gameData.slogans.opening.language = 'zh-CN';
    expect(getAudioRequests(bound, assets)).toEqual([
      expect.objectContaining({ objectId: opening.id, language: 'zh-CN' }),
    ]);
  });

  it('文字示范的类型联动与恢复预设保护手动及锁定，明确覆盖才重置', () => {
    const { lesson } = voiced(3);
    const [first, manual, locked] = getEntries(lesson);
    manual.modelBeats = { value: 6, source: 'manual', locked: false };
    locked.modelBeats = { value: 7, source: 'manual', locked: true };
    const changed = setEntryType(lesson, first.id, 'phrase');
    expect(getEntries(changed)[0].modelBeats).toEqual({
      value: 3,
      source: 'preset',
      locked: false,
    });
    expect(getEntries(setEntryType(changed, manual.id, 'phrase'))[1].modelBeats.value).toBe(6);
    const restored = applyPreset(changed, 'focus');
    expect(getEntries(restored).map((entry) => entry.modelBeats.value)).toEqual([3, 6, 7]);
    Object.values(restored.gameData.slogans).forEach((slogan) => {
      slogan.locked = true;
    });
    expect(remixLesson(restored, { seed: 2, restorePreset: true })).toBeNull();
    const override = remixLesson(restored, { seed: 2, restorePreset: true, overrideManual: true })!;
    const applied = applySuggestion(restored, override);
    expect(getEntries(applied).map((entry) => entry.modelBeats.value)).toEqual([3, 2, 7]);
    expect(getEntries(applied)[1].modelBeats.source).toBe('preset');
  });
});

describe('固定输入的真实声音成果', () => {
  it('相同声音多次使用只计一次，任务内缓存命中归入复用', () => {
    const lesson = createWordBeatLesson(
      [
        { id: 'a', english: 'take  part in', meaning: '', priority: false },
        { id: 'b', english: 'take part in', meaning: '', priority: false },
        { id: 'c', english: 'challenge', meaning: '', priority: false },
        { id: 'd', english: 'unfinished', meaning: '', priority: false },
      ],
      { seed: 1 },
    );
    lesson.gameData.slogans.opening.enabled = false;
    lesson.gameData.slogans.closing.enabled = false;
    const objects = getEntries(lesson);
    expect(
      getAudioProductionSummary(lesson, {}, [
        { objectId: objects[0].id, cached: true },
        { objectId: objects[2].id, cached: false },
        { objectId: 'other-task', cached: false },
      ]),
    ).toEqual({ total: 3, created: 1, reused: 1, unfinished: 1 });
  });

  it('已有匹配系统声音归入复用，词同但音色不同仍为独立需求', () => {
    const { lesson, assets } = voiced(2);
    const objects = getEntries(lesson);
    objects[1].english = objects[0].english;
    objects[1].voiceOverrides = { voiceId: 'other-voice' };
    expect(getAudioProductionSummary(lesson, assets)).toEqual({
      total: 2,
      created: 0,
      reused: 1,
      unfinished: 1,
    });
  });

  it('录音按实际引用区分，关闭示范及无用途转场不制造声音成果', () => {
    const { lesson, assets } = voiced(2);
    const objects = getEntries(lesson);
    objects[1].english = objects[0].english;
    objects.forEach((entry, index) => {
      entry.audio = {
        source: 'recording',
        assetId: `recording-${index}`,
        text: entry.english,
        language: 'en-US',
        rate: 1,
        status: 'ready',
      };
      assets[`recording-${index}`] = asset(`recording-${index}`);
    });
    expect(getAudioProductionSummary(lesson, assets)).toEqual({
      total: 2,
      created: 0,
      reused: 2,
      unfinished: 0,
    });
    lesson.gameData.soundMode = 'teacher';
    lesson.gameData.slogans.transition.enabled = true;
    expect(getAudioProductionSummary(lesson, assets)).toEqual({
      total: 0,
      created: 0,
      reused: 0,
      unfinished: 0,
    });
  });
});
