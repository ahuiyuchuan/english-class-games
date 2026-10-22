// @vitest-environment jsdom
/** 本地记录的不可信数据边界、隔离和完整编排回归。 @author ahui */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetMap } from '../../platform/types';
import {
  bindRecording,
  compileWordBeat,
  createWordBeatEntry,
  createWordBeatLesson,
  getEntries,
} from './rules';
import {
  applyClassroomSettings,
  captureClassroomSettings,
  classroomStorageKey,
  clearClassroomSettings,
  loadClassroomSettings,
  saveClassroomSettings,
} from './classroom-storage';

/** 保留真实课件模型，禁用未制作口号使测试独立于开发机音色。 */
function fixture() {
  let sequence = 0;
  const lesson = createWordBeatLesson(
    [
      { id: 'a', english: 'knowledge', meaning: '知识', priority: false },
      { id: 'b', english: 'make a difference', meaning: '产生影响', priority: true },
    ],
    {
      soundMode: 'chorus',
      seed: 1,
      now: '2026-10-21T00:00:00.000Z',
      idFactory: () => `persist-${sequence++}`,
    },
  );
  Object.values(lesson.gameData.slogans).forEach((slogan) => {
    slogan.enabled = false;
  });
  return lesson;
}

/** 与受保护 v1／v2 writer 的真实捕获输入一致，验证短语原拍数不会被默认 4／1 覆盖。 */
function legacyRhythmFixture() {
  const lesson = fixture();
  getEntries(lesson).forEach((entry, index) => {
    entry.chorus = {
      beats: { value: index === 0 ? 4 : 8, source: 'manual', locked: index === 1 },
      beatsPerRead: { value: 2, source: 'manual', locked: false },
    };
  });
  lesson.gameData.chorusGapBeats = 3;
  return lesson;
}

/**
 * 受保护旧模块实际写出的记录，非当前实现重造摘要或删新字段冒充旧格式。
 * 捕获脚本、原模块路径、完整 JSON 与运行日志保存在本轮 settings 证据目录。
 */
function capturedLegacyRhythmRecord(version: 1 | 2) {
  return {
    version,
    lessonId: 'persist-6',
    identity: version === 1 ? '2325:2655208180:2715428206' : '2192:259823203:655917329',
    settings: {
      bpm: 120,
      progression: 'auto',
      loop: false,
      resumePreparationBeats: 0,
      displayMode: 'blocks',
      showMeaning: true,
      stageEffects: true,
      showWordTrack: true,
      volumes: { voice: 1, beat: 0.2, music: 0.15 },
      rounds: [
        { id: 'persist-3', value: 3, source: 'manual', locked: false },
        { id: 'persist-4', value: 1, source: 'preset', locked: false },
      ],
    },
  };
}

/** 配音匹配使用正式录音绑定，不伪造可用状态或依赖操作系统音色。 */
function voicedFixture() {
  let lesson = fixture();
  lesson.gameData.soundMode = 'voiced';
  const assets: AssetMap = {};
  for (const entry of getEntries(lesson)) {
    const asset = {
      assetId: `audio-${entry.id}`,
      mimeType: 'audio/wav',
      durationMs: 500,
      byteLength: 44,
      sha256: 'a'.repeat(64),
    };
    assets[asset.assetId] = asset;
    lesson = bindRecording(lesson, entry.id, asset);
  }
  return { lesson, assets };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('课堂设置本地持久化', () => {
  it('v5新增、删除和同组排序随统一保存恢复，原课件和原声音均不改写', () => {
    const lesson = fixture();
    const original = structuredClone(lesson);
    const candidate = structuredClone(lesson);
    const added = createWordBeatEntry(
      { id: 'ignored', english: 'classroom', meaning: '教室', priority: false },
      candidate.gameData.preset,
      () => 'classroom-added',
    );
    candidate.gameData.segments[0].entries.unshift(added);
    candidate.gameData.segments[0].entries.splice(2, 1);
    const settings = captureClassroomSettings(candidate);
    saveClassroomSettings(lesson, {}, settings);
    const raw = localStorage.getItem(classroomStorageKey(lesson))!;
    expect(JSON.parse(raw).version).toBe(5);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.noticeKind).toBe('restored');
    expect(getEntries(loaded.lesson).map((entry) => entry.id)).toEqual([
      'classroom-added',
      getEntries(lesson)[0].id,
    ]);
    expect(getEntries(loaded.lesson)[0].rounds.value).toBe(1);
    expect(getEntries(loaded.lesson)[0].audio).toBeUndefined();
    expect(loaded.settings).toEqual(settings);
    expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    expect(lesson).toEqual(original);
  });

  it.each(['word', 'phrase'] as const)(
    'v5本地新增%s保存恢复后可明确改词型，含空格英文不覆盖教师选择',
    (entryType) => {
      const lesson = fixture();
      const original = structuredClone(lesson);
      const candidate = structuredClone(lesson);
      // 课堂明确词型的默认值以空英文建立，再写入正文；含空格不应重新推断类型。
      const added = createWordBeatEntry(
        { id: 'input', english: '', meaning: '', priority: false, entryType },
        lesson.gameData.preset,
        () => 'local-type-change',
      );
      Object.assign(added, { english: 'make room', entryTypeSource: 'manual' });
      candidate.gameData.segments[0].entries.push(added);
      saveClassroomSettings(lesson, {}, captureClassroomSettings(candidate));

      const loaded = loadClassroomSettings(lesson, {});
      expect(loaded.noticeKind).toBe('restored');
      const restored = getEntries(loaded.lesson).find((entry) => entry.id === added.id)!;
      expect(restored.entryType).toBe(entryType);
      const changedType = entryType === 'word' ? 'phrase' : 'word';
      const defaults = createWordBeatEntry(
        { ...restored, english: '', entryType: changedType },
        lesson.gameData.preset,
        () => restored.id,
      );
      Object.assign(restored, {
        entryType: changedType,
        entryTypeSource: 'manual',
        modelBeats: defaults.modelBeats,
        follow: defaults.follow,
      });
      saveClassroomSettings(lesson, {}, captureClassroomSettings(loaded.lesson));

      const reopened = loadClassroomSettings(lesson, {});
      expect(reopened.noticeKind).toBe('restored');
      const changed = getEntries(reopened.lesson).find((entry) => entry.id === added.id)!;
      expect(changed).toMatchObject({
        id: added.id,
        english: 'make room',
        entryType: changedType,
        entryTypeSource: 'manual',
        modelBeats: defaults.modelBeats,
        follow: defaults.follow,
      });
      expect(changed.audio).toBeUndefined();
      expect(lesson).toEqual(original);

      // 已保存的本地新增词仍不能借改词型注入任意隐藏拍数；失败保留上次记录。
      const key = classroomStorageKey(lesson);
      const saved = localStorage.getItem(key);
      const invalid = captureClassroomSettings(reopened.lesson);
      invalid.practice.find((entry) => entry.id === added.id)!.follow.beats += 5;
      expect(() => saveClassroomSettings(lesson, {}, invalid)).toThrow('隐藏参数');
      expect(localStorage.getItem(key)).toBe(saved);
    },
  );

  it('v5原课件词明确改词型保留已有隐藏参数，不能套用新增词默认值放宽保护', () => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    const originalRule = structuredClone(settings.practice[0]);
    settings.practice[0].entryType = 'phrase';
    settings.practice[0].entryTypeSource = 'manual';
    saveClassroomSettings(lesson, {}, settings);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.noticeKind).toBe('restored');
    expect(loaded.settings.practice[0]).toMatchObject({
      entryType: 'phrase',
      entryTypeSource: 'manual',
      modelBeats: originalRule.modelBeats,
      follow: originalRule.follow,
    });

    const key = classroomStorageKey(lesson);
    const saved = localStorage.getItem(key);
    loaded.settings.practice[0].modelBeats.value = 3;
    loaded.settings.practice[0].follow.beats = 3;
    expect(() => saveClassroomSettings(lesson, {}, loaded.settings)).toThrow('隐藏参数');
    expect(localStorage.getItem(key)).toBe(saved);
  });

  it('v4严格旧记录只读恢复，完成后升级v5，旧版本不能夹带新词表字段', () => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    settings.entries[0].meaning = '旧版教师释义';
    saveClassroomSettings(lesson, {}, settings);
    const key = classroomStorageKey(lesson);
    const envelope = JSON.parse(localStorage.getItem(key)!);
    envelope.version = 4;
    delete envelope.settings.segments;
    delete envelope.settings.practice;
    const raw = JSON.stringify(envelope);
    localStorage.setItem(key, raw);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.noticeKind).toBe('restored');
    expect(loaded.settings).toEqual(settings);
    expect(localStorage.getItem(key)).toBe(raw);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...envelope,
        settings: { ...envelope.settings, segments: settings.segments },
      }),
    );
    expect(loadClassroomSettings(lesson, {}).noticeKind).toBe('fallback');
    saveClassroomSettings(lesson, {}, loaded.settings);
    expect(JSON.parse(localStorage.getItem(key)!).version).toBe(5);
  });

  it('v5保留位置锁定，删除、移位及跨越该位置均拒绝', () => {
    const lesson = fixture();
    getEntries(lesson)[1].positionLocked = true;
    for (const mutate of [
      (next: typeof lesson) => next.gameData.segments[0].entries.pop(),
      (next: typeof lesson) => next.gameData.segments[0].entries.shift(),
      (next: typeof lesson) => next.gameData.segments[0].entries.reverse(),
    ]) {
      const candidate = structuredClone(lesson);
      mutate(candidate);
      expect(() => applyClassroomSettings(lesson, captureClassroomSettings(candidate), {})).toThrow(
        '位置已锁定',
      );
    }
    const third = createWordBeatEntry(
      { id: 'input', english: 'third', meaning: '', priority: false },
      'regular',
      () => 'third-original',
    );
    lesson.gameData.segments[0].entries.push(third);
    const switched = structuredClone(lesson);
    const items = switched.gameData.segments[0].entries;
    [items[0], items[2]] = [items[2], items[0]];
    expect(() => applyClassroomSettings(lesson, captureClassroomSettings(switched), {})).toThrow(
      '跨越',
    );
  });

  it('v5不允许跨组移动、重复或跨类型ID、新增注入音频及分组变更', () => {
    const lesson = fixture();
    lesson.gameData.segments.push({ id: 'second-group', name: '第二组', entries: [] });
    const candidate = structuredClone(lesson);
    candidate.gameData.segments[1].entries.push(candidate.gameData.segments[0].entries.pop()!);
    expect(() => applyClassroomSettings(lesson, captureClassroomSettings(candidate), {})).toThrow(
      '跨组',
    );
    const settings = captureClassroomSettings(lesson);
    settings.segments.reverse();
    expect(() => applyClassroomSettings(lesson, settings, {})).toThrow('分组');
    const polluted = captureClassroomSettings(lesson);
    Object.assign(polluted.practice[0], { audio: { assetId: 'injected' } });
    expect(() => applyClassroomSettings(lesson, polluted, {})).toThrow('数据不完整');
    const reserved = structuredClone(lesson);
    reserved.gameData.segments[0].entries[0].id = lesson.id;
    expect(() => applyClassroomSettings(lesson, captureClassroomSettings(reserved), {})).toThrow(
      '标识',
    );
  });

  it('v5词表空白、超100词或新增词无配音不能提交，原记录保持', () => {
    const lesson = fixture();
    saveClassroomSettings(lesson, {}, captureClassroomSettings(lesson));
    const key = classroomStorageKey(lesson);
    const saved = localStorage.getItem(key);
    const empty = structuredClone(lesson);
    empty.gameData.segments[0].entries = [];
    expect(() => saveClassroomSettings(lesson, {}, captureClassroomSettings(empty))).toThrow();
    const over = structuredClone(lesson);
    over.gameData.segments[0].entries = Array.from({ length: 101 }, (_, index) =>
      createWordBeatEntry(
        { id: 'input', english: `word${index}`, meaning: '', priority: false },
        'regular',
        () => `new-${index}`,
      ),
    );
    expect(() => saveClassroomSettings(lesson, {}, captureClassroomSettings(over))).toThrow();
    expect(localStorage.getItem(key)).toBe(saved);
    const voiced = voicedFixture();
    const next = structuredClone(voiced.lesson);
    next.gameData.segments[0].entries.push(
      createWordBeatEntry(
        { id: 'input', english: 'added', meaning: '', priority: false },
        'regular',
        () => 'added-without-voice',
      ),
    );
    const settings = captureClassroomSettings(next);
    expect(() => applyClassroomSettings(voiced.lesson, settings, voiced.assets)).toThrow();
    settings.soundMode = 'teacher';
    expect(getEntries(applyClassroomSettings(voiced.lesson, settings, voiced.assets))).toHaveLength(
      3,
    );
  });

  it('v5文字领读示范及跟读拍数正确保存，锁定和隐藏模式参数不绕过', () => {
    const lesson = fixture();
    lesson.gameData.soundMode = 'teacher';
    const settings = captureClassroomSettings(lesson);
    settings.practice[0].modelBeats = { value: 8, source: 'manual', locked: false };
    settings.practice[0].follow = { mode: 'manual', beats: 4, locked: false, preset: 'regular' };
    const next = applyClassroomSettings(lesson, settings, {});
    expect(getEntries(next)[0].modelBeats.value).toBe(8);
    expect(getEntries(next)[0].follow.beats).toBe(4);
    saveClassroomSettings(lesson, {}, settings);
    expect(loadClassroomSettings(lesson, {}).settings.practice).toEqual(settings.practice);
    getEntries(lesson)[0].modelBeats.locked = true;
    expect(() => applyClassroomSettings(lesson, settings, {})).toThrow('锁定');
    const chorus = fixture();
    const hidden = captureClassroomSettings(chorus);
    hidden.practice[0].follow.beats += 2;
    expect(() => applyClassroomSettings(chorus, hidden, {})).toThrow('隐藏参数');
    const added = structuredClone(chorus);
    added.gameData.segments[0].entries.push(
      createWordBeatEntry(
        { id: 'input', english: 'added', meaning: '', priority: false },
        'regular',
        () => 'new-hidden-check',
      ),
    );
    const hiddenNew = captureClassroomSettings(added);
    hiddenNew.practice[2].follow.beats = -20;
    expect(() => applyClassroomSettings(chorus, hiddenNew, {})).toThrow('隐藏参数');
  });

  it('新建所有模式及预设的普通词、重点词初始均一轮', () => {
    for (const soundMode of ['voiced', 'teacher', 'chorus'] as const)
      for (const preset of ['regular', 'focus', 'quick'] as const)
        expect(
          getEntries(createWordBeatLesson(getEntries(fixture()), { soundMode, preset })).map(
            (entry) => entry.rounds.value,
          ),
        ).toEqual([1, 1]);
  });

  it('v4保存全部设置与文字副本，原课件不变，不保存音频、路径或播放状态', () => {
    const lesson = fixture();
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson, {
      stageEffects: false,
      showWordTrack: false,
    });
    Object.assign(settings, {
      bpm: 120,
      progression: 'step',
      loop: true,
      resumePreparationBeats: 2,
      showMeaning: false,
      displayMode: 'centered',
    });
    settings.volumes = { voice: 0.1, beat: 0.35, music: 0 };
    settings.rounds[0] = { ...settings.rounds[0], value: 8, source: 'manual' };
    settings.chorus[0].beats = { value: 8, source: 'manual', locked: false };
    settings.chorus[0].beatsPerRead = { value: 2, source: 'manual', locked: false };
    settings.chorusGapBeats = 2;
    settings.entries[0].english = 'understanding';
    settings.entries[0].meaning = '理解';
    saveClassroomSettings(lesson, {}, settings);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.settings).toEqual(settings);
    expect(loaded.lesson.gameData.bpm.value).toBe(120);
    expect(getEntries(loaded.lesson)[0].rounds).toEqual({
      value: 8,
      source: 'manual',
      locked: false,
    });
    expect(lesson).toEqual(before);
    const raw = localStorage.getItem(classroomStorageKey(lesson))!;
    expect(JSON.parse(raw).version).toBe(5);
    expect(getEntries(loaded.lesson)[0]).toMatchObject({
      english: 'understanding',
      meaning: '理解',
    });
    expect(getEntries(loaded.lesson)[0].chorus).toEqual({
      beats: settings.chorus[0].beats,
      beatsPerRead: settings.chorus[0].beatsPerRead,
    });
    expect(loaded.lesson.gameData.chorusGapBeats).toBe(2);
    expect(raw).toContain('understanding');
    expect(raw).toContain('产生影响');
    expect(raw).not.toMatch(/dataUrl|path|elapsed|cueIndex|draft/);
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(2048);
  });

  it('v4重开以统一捕获顺序恢复，模式和文字不产生假草稿且读取不写记录', () => {
    const { lesson, assets } = voicedFixture();
    const visual = { stageEffects: false, showWordTrack: false };
    const settings = captureClassroomSettings(lesson, visual);
    settings.soundMode = 'teacher';
    settings.entries[0].english = 'classroom replacement';
    settings.entries[0].meaning = '课堂临时替换';
    saveClassroomSettings(lesson, assets, settings);
    const key = classroomStorageKey(lesson);
    const raw = localStorage.getItem(key);
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const loaded = loadClassroomSettings(lesson, assets);
    expect(loaded.notice).toContain('已恢复');
    expect(loaded.settings).toEqual(settings);
    expect(JSON.stringify(captureClassroomSettings(loaded.lesson, visual))).toBe(
      JSON.stringify(loaded.settings),
    );
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('不同课件隔离，重复保存覆盖同键，清除只影响当前课', () => {
    const first = fixture();
    const second = { ...fixture(), id: 'copy-lesson' };
    const settings = captureClassroomSettings(first);
    settings.bpm = 120;
    saveClassroomSettings(first, {}, settings);
    saveClassroomSettings(first, {}, settings);
    saveClassroomSettings(second, {}, captureClassroomSettings(second));
    expect(localStorage.length).toBe(2);
    expect(loadClassroomSettings(second, {}).settings.bpm).toBe(100);
    clearClassroomSettings(first);
    expect(localStorage.length).toBe(1);
    expect(loadClassroomSettings(first, {}).settings.bpm).toBe(100);
  });

  it.each(['revision', 'text', 'music', 'mode', 'asset'] as const)(
    '%s 变化不套用过期记录',
    (change) => {
      const lesson = fixture();
      const assets: AssetMap = {};
      if (change === 'asset') {
        assets.music = {
          assetId: 'music',
          mimeType: 'audio/wav',
          durationMs: 60_000,
          byteLength: 44,
          sha256: 'a'.repeat(64),
        };
        lesson.gameData.music.enabled = true;
        lesson.gameData.music.assetId = 'music';
      }
      const settings = captureClassroomSettings(lesson);
      settings.bpm = 120;
      saveClassroomSettings(lesson, assets, settings);
      if (change === 'revision') lesson.revision += 1;
      if (change === 'text') getEntries(lesson)[0].english = 'changed';
      if (change === 'music') lesson.gameData.music.loop = !lesson.gameData.music.loop;
      if (change === 'mode') lesson.gameData.soundMode = 'teacher';
      if (change === 'asset') assets.music.sha256 = 'b'.repeat(64);
      const loaded = loadClassroomSettings(lesson, assets);
      expect(loaded.settings.bpm).toBe(100);
      expect(loaded.notice).toContain('已变化');
    },
  );

  it('无关素材新增、删除或更新不使本课设置失效，缺失的实际依赖仍拒绝', () => {
    const lesson = fixture();
    const unused = {
      assetId: 'unrelated',
      mimeType: 'audio/wav',
      durationMs: 1000,
      byteLength: 44,
      sha256: 'b'.repeat(64),
    };
    const settings = captureClassroomSettings(lesson);
    settings.bpm = 120;
    saveClassroomSettings(lesson, {}, settings);
    expect(loadClassroomSettings(lesson, { unrelated: unused }).settings.bpm).toBe(120);
    expect(
      loadClassroomSettings(lesson, { unrelated: { ...unused, sha256: 'c'.repeat(64) } }).settings
        .bpm,
    ).toBe(120);
    saveClassroomSettings(lesson, { unrelated: unused }, settings);
    expect(loadClassroomSettings(lesson, {}).settings.bpm).toBe(120);
    lesson.gameData.music.enabled = true;
    lesson.gameData.music.assetId = 'unrelated';
    saveClassroomSettings(lesson, { unrelated: unused }, settings);
    expect(loadClassroomSettings(lesson, {}).notice).toContain('已变化');
  });

  it('v1全库记录按旧算法只读接受，明确完成才写v5；旧摘要不匹配时保留原记录', () => {
    const lesson = fixture();
    const unrelated = {
      assetId: 'unrelated',
      mimeType: 'audio/wav',
      durationMs: 1000,
      byteLength: 44,
      sha256: 'b'.repeat(64),
    };
    const settings = captureClassroomSettings(lesson);
    settings.bpm = 120;
    // 从本轮受保护的 v1 模块实际运行捕获，非复写哈希算法产生的测试答案。
    // 捕获脚本与原始记录位于 validation/experience-audit-20261022/settings/。
    const raw = JSON.stringify({
      version: 1,
      lessonId: lesson.id,
      identity: '2059:1789893633:1702715979',
      settings: {
        bpm: 120,
        progression: 'auto',
        loop: false,
        resumePreparationBeats: 0,
        displayMode: 'blocks',
        showMeaning: true,
        stageEffects: true,
        showWordTrack: true,
        volumes: { voice: 1, beat: 0.2, music: 0.15 },
        rounds: [
          { id: 'persist-3', value: 1, source: 'preset', locked: false },
          { id: 'persist-4', value: 1, source: 'preset', locked: false },
        ],
      },
    });
    const key = classroomStorageKey(lesson);
    localStorage.setItem(key, raw);
    expect(loadClassroomSettings(lesson, { unrelated }).settings.bpm).toBe(120);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(loadClassroomSettings(lesson, {}).notice).toContain('旧版本地设置无法');
    expect(loadClassroomSettings(lesson, {}).settings.bpm).toBe(100);
    expect(localStorage.getItem(key)).toBe(raw);
    saveClassroomSettings(lesson, { unrelated }, settings);
    expect(JSON.parse(localStorage.getItem(key)!).version).toBe(5);
    expect(loadClassroomSettings(lesson, {}).settings.bpm).toBe(120);
  });

  it.each(['{', '{}', '[]', 'null', 'x'.repeat(262145)])(
    '损坏或超限记录不应用且不抹去原记录',
    (raw) => {
      const lesson = fixture();
      localStorage.setItem(classroomStorageKey(lesson), raw);
      expect(loadClassroomSettings(lesson, {}).notice).toContain('损坏');
      expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    },
  );

  it('读取同样按 UTF-8 字节限制体积，多字节超限不能误报课件变化', () => {
    const lesson = fixture();
    saveClassroomSettings(lesson, {}, captureClassroomSettings(lesson));
    const key = classroomStorageKey(lesson);
    const value = JSON.parse(localStorage.getItem(key)!);
    value.identity = '字'.repeat(100_000);
    const raw = JSON.stringify(value);
    expect(raw.length).toBeLessThan(256 * 1024);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(256 * 1024);
    localStorage.setItem(key, raw);
    expect(loadClassroomSettings(lesson, {}).notice).toContain('损坏');
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('未知存储版本、非法音量和重复 ID 均拒绝', () => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    saveClassroomSettings(lesson, {}, settings);
    const key = classroomStorageKey(lesson);
    const saved = JSON.parse(localStorage.getItem(key)!);
    for (const value of [
      { ...saved, version: 6 },
      { ...saved, settings: { ...settings, volumes: { ...settings.volumes, beat: 2.01 } } },
      { ...saved, settings: { ...settings, rounds: [settings.rounds[0], settings.rounds[0]] } },
    ]) {
      localStorage.setItem(key, JSON.stringify(value));
      expect(loadClassroomSettings(lesson, {}).notice).toContain('损坏');
    }
  });

  it('锁定及对拍速度不允许通过外部记录覆盖', () => {
    const lesson = fixture();
    getEntries(lesson)[0].rounds.locked = true;
    const settings = captureClassroomSettings(lesson);
    settings.rounds[0].value = 3;
    expect(() => applyClassroomSettings(lesson, settings, {})).toThrow('锁定');
    settings.rounds[0].value = 1;
    settings.bpm = 120;
    lesson.gameData.music.enabled = true;
    lesson.gameData.music.syncEnabled = true;
    expect(() => applyClassroomSettings(lesson, settings, {})).toThrow('对拍音乐');
  });

  it('数字范围正确但齐读组合非法，仍不得保存', () => {
    const lesson = fixture();
    getEntries(lesson)[0].chorus = {
      beats: { value: 3, source: 'manual', locked: false },
      beatsPerRead: { value: 2, source: 'manual', locked: false },
    };
    expect(() => saveClassroomSettings(lesson, {}, captureClassroomSettings(lesson))).toThrow();
    expect(localStorage.length).toBe(0);
  });

  it.each([1, 2] as const)(
    '真实v%s记录只读恢复，拍数、独立锁定及间隔继承原课件，明确完成才升级',
    (version) => {
      const lesson = legacyRhythmFixture();
      const before = structuredClone(lesson);
      const unrelated = {
        assetId: 'unrelated',
        mimeType: 'audio/wav',
        durationMs: 1000,
        byteLength: 44,
        sha256: 'b'.repeat(64),
      };
      const raw = JSON.stringify(capturedLegacyRhythmRecord(version));
      const key = classroomStorageKey(lesson);
      localStorage.setItem(key, raw);
      const loaded = loadClassroomSettings(lesson, { unrelated });
      expect(loaded.notice).toContain('已恢复');
      expect(loaded.settings.bpm).toBe(120);
      expect(loaded.settings.rounds[0].value).toBe(3);
      expect(loaded.settings.chorus).toEqual(captureClassroomSettings(lesson).chorus);
      expect(loaded.settings.chorusGapBeats).toBe(3);
      expect(getEntries(loaded.lesson).map((entry) => entry.chorus)).toEqual(
        getEntries(lesson).map((entry) => entry.chorus),
      );
      expect(localStorage.getItem(key)).toBe(raw);
      expect(lesson).toEqual(before);
      if (version === 1) {
        expect(loadClassroomSettings(lesson, {}).notice).toContain('旧版本地设置无法');
        expect(localStorage.getItem(key)).toBe(raw);
      } else expect(loadClassroomSettings(lesson, {}).settings.bpm).toBe(120);
      saveClassroomSettings(lesson, { unrelated }, loaded.settings);
      expect(loaded.settings.entries).toEqual(captureClassroomSettings(lesson).entries);
      expect(loaded.settings.soundMode).toBe(lesson.gameData.soundMode);
      expect(
        JSON.stringify(
          captureClassroomSettings(loaded.lesson, {
            stageEffects: loaded.settings.stageEffects,
            showWordTrack: loaded.settings.showWordTrack,
          }),
        ),
      ).toBe(JSON.stringify(loaded.settings));
      expect(JSON.parse(localStorage.getItem(key)!).version).toBe(5);
      expect(loadClassroomSettings(lesson, {}).settings).toEqual(loaded.settings);
    },
  );

  it.each([1, 2] as const)('v%s原严格结构不接受偷渡的新齐读字段', (version) => {
    const lesson = legacyRhythmFixture();
    const record = capturedLegacyRhythmRecord(version);
    const raw = JSON.stringify({
      ...record,
      settings: { ...record.settings, chorusGapBeats: 0 },
    });
    const key = classroomStorageKey(lesson);
    localStorage.setItem(key, raw);
    expect(loadClassroomSettings(lesson, {}).notice).toContain('损坏');
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('v3严格记录只读补原文和模式，保留已有拍数，完成才升级5', () => {
    const lesson = legacyRhythmFixture();
    const settings = captureClassroomSettings(lesson);
    settings.bpm = 120;
    settings.chorus[0].beats.value = 8;
    saveClassroomSettings(lesson, {}, settings);
    const key = classroomStorageKey(lesson);
    const envelope = JSON.parse(localStorage.getItem(key)!);
    // 明确构造旧 v3 的严格字段集合；不把缺字段的新记录误标为有效 v4。
    delete envelope.settings.segments;
    delete envelope.settings.practice;
    delete envelope.settings.entries;
    delete envelope.settings.soundMode;
    envelope.version = 3;
    const raw = JSON.stringify(envelope);
    localStorage.setItem(key, raw);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.notice).toContain('已恢复');
    expect(loaded.settings).toEqual(settings);
    expect(
      JSON.stringify(
        captureClassroomSettings(loaded.lesson, {
          stageEffects: loaded.settings.stageEffects,
          showWordTrack: loaded.settings.showWordTrack,
        }),
      ),
    ).toBe(JSON.stringify(loaded.settings));
    expect(localStorage.getItem(key)).toBe(raw);
    expect(getEntries(loaded.lesson).map(({ english }) => english)).toEqual([
      'knowledge',
      'make a difference',
    ]);
    for (const extra of [{ entries: settings.entries }, { soundMode: 'teacher' }]) {
      const polluted = JSON.stringify({
        ...envelope,
        settings: { ...envelope.settings, ...extra },
      });
      localStorage.setItem(key, polluted);
      expect(loadClassroomSettings(lesson, {}).notice).toContain('损坏');
      expect(localStorage.getItem(key)).toBe(polluted);
    }
    saveClassroomSettings(lesson, {}, loaded.settings);
    expect(JSON.parse(localStorage.getItem(key)!).version).toBe(5);
  });

  it.each([1, 2] as const)('v%s严格记录不能夹带正文或课堂模式', (version) => {
    const lesson = legacyRhythmFixture();
    const record = capturedLegacyRhythmRecord(version);
    const settings = captureClassroomSettings(lesson);
    for (const extra of [{ entries: settings.entries }, { soundMode: 'teacher' }]) {
      const raw = JSON.stringify({ ...record, settings: { ...record.settings, ...extra } });
      localStorage.setItem(classroomStorageKey(lesson), raw);
      expect(loadClassroomSettings(lesson, {}).notice).toContain('损坏');
      expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    }
  });

  it('文字快照只改英文释义，保留类型、规则、素材和来源；只有释义实改标记教师修订', () => {
    const lesson = fixture();
    const first = getEntries(lesson)[0];
    first.meaningSource = {
      name: '本地词库',
      version: '1',
      english: first.english,
      originalMeaning: first.meaning,
      teacherRevised: false,
    };
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson);
    settings.entries[0].english = '  a new phrase  ';
    const englishOnly = applyClassroomSettings(lesson, settings, {});
    expect(getEntries(englishOnly)[0]).toEqual({ ...first, english: '  a new phrase  ' });
    expect(getEntries(englishOnly)[0].meaningSource?.teacherRevised).toBe(false);
    settings.entries[0].meaning = '教师临时释义';
    const changed = applyClassroomSettings(lesson, settings, {});
    expect(getEntries(changed)[0]).toEqual({
      ...first,
      english: '  a new phrase  ',
      meaning: '教师临时释义',
      meaningSource: { ...first.meaningSource, teacherRevised: true },
    });
    expect(lesson).toEqual(before);
    settings.entries[0].meaning = first.meaning;
    expect(getEntries(applyClassroomSettings(lesson, settings, {}))[0].meaningSource).toEqual(
      first.meaningSource,
    );
    expect(applyClassroomSettings(lesson, captureClassroomSettings(lesson), {})).toEqual(lesson);
  });

  it('文字ID必须与确定词表及参数一一对应，不接受只改文字数组绕过结构校验', () => {
    const lesson = fixture();
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson);
    const [first, second] = settings.entries;
    for (const entries of [
      [],
      [first],
      [first, first],
      [second, first],
      [first, { ...second, id: 'missing' }],
      [first, second, { ...second, id: 'extra' }],
      [first, { ...second, priority: false }],
    ])
      expect(() => applyClassroomSettings(lesson, { ...settings, entries }, {})).toThrow();
    for (const soundMode of ['teacher', 'voiced', 'automatic'])
      expect(() => applyClassroomSettings(lesson, { ...settings, soundMode }, {})).toThrow();
    expect(lesson).toEqual(before);
  });

  it.each(['', '   ', 'x'.repeat(121), 'word\nnext', 'bad\u007f'])(
    '非法英文原值%s不能写入或覆盖上一份完整设置',
    (english) => {
      const lesson = fixture();
      const settings = captureClassroomSettings(lesson);
      saveClassroomSettings(lesson, {}, settings);
      const raw = localStorage.getItem(classroomStorageKey(lesson));
      settings.entries[0].english = english;
      expect(() => saveClassroomSettings(lesson, {}, settings)).toThrow('英文需为');
      expect(settings.entries[0].english).toBe(english);
      expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    },
  );

  it.each(['释'.repeat(201), '含\t控制字符'])('非法释义%s保留原输入且不写库', (meaning) => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    settings.entries[0].meaning = meaning;
    expect(() => saveClassroomSettings(lesson, {}, settings)).toThrow('释义不能超过');
    expect(settings.entries[0].meaning).toBe(meaning);
    expect(localStorage.length).toBe(0);
  });

  it('英文按Unicode字符计数，120字符及空释义合法，重复词不在存储层合并', () => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    settings.entries[0].english = '😀'.repeat(120);
    settings.entries[0].meaning = '';
    saveClassroomSettings(lesson, {}, settings);
    expect(loadClassroomSettings(lesson, {}).settings).toEqual(settings);
    settings.entries[1].english = settings.entries[0].english;
    saveClassroomSettings(lesson, {}, settings);
    const restored = getEntries(loadClassroomSettings(lesson, {}).lesson);
    expect(restored).toHaveLength(2);
    expect(restored.map(({ id }) => id)).toEqual(settings.entries.map(({ id }) => id));
  });

  it('配音改词必须显式整课改为文字领读；恢复原词可重新启用原配音且原课件不变', () => {
    const { lesson, assets } = voicedFixture();
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson);
    saveClassroomSettings(lesson, assets, settings);
    const raw = localStorage.getItem(classroomStorageKey(lesson));
    settings.entries[0].english = 'new classroom word';
    expect(() => saveClassroomSettings(lesson, assets, settings)).toThrow();
    expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    settings.soundMode = 'teacher';
    saveClassroomSettings(lesson, assets, settings);
    const loaded = loadClassroomSettings(lesson, assets);
    expect(loaded.lesson.gameData.soundMode).toBe('teacher');
    expect(getEntries(loaded.lesson)[0].english).toBe('new classroom word');
    expect(getEntries(loaded.lesson).map(({ audio }) => audio)).toEqual(
      getEntries(lesson).map(({ audio }) => audio),
    );
    settings.soundMode = 'voiced';
    expect(() => applyClassroomSettings(lesson, settings, assets)).toThrow();
    settings.entries = captureClassroomSettings(lesson).entries;
    expect(applyClassroomSettings(lesson, settings, assets)).toEqual(lesson);
    expect(lesson).toEqual(before);
    clearClassroomSettings(lesson);
    expect(loadClassroomSettings(lesson, assets).lesson).toEqual(lesson);
  });

  it('三种原模式只允许原模式或配音转文字；切文字不跳过启用口号的声音检查', () => {
    for (const originalMode of ['voiced', 'teacher', 'chorus'] as const) {
      const { lesson, assets } = voicedFixture();
      lesson.gameData.soundMode = originalMode;
      for (const soundMode of ['voiced', 'teacher', 'chorus'] as const) {
        const settings = { ...captureClassroomSettings(lesson), soundMode };
        const permitted =
          soundMode === originalMode || (originalMode === 'voiced' && soundMode === 'teacher');
        if (permitted)
          expect(applyClassroomSettings(lesson, settings, assets).gameData.soundMode).toBe(
            soundMode,
          );
        else expect(() => applyClassroomSettings(lesson, settings, assets)).toThrow('课堂模式');
      }
    }
    const { lesson, assets } = voicedFixture();
    lesson.gameData.slogans.opening.enabled = true;
    const settings = captureClassroomSettings(lesson);
    settings.soundMode = 'teacher';
    expect(() => applyClassroomSettings(lesson, settings, assets)).toThrow();
  });

  it('v4文字与ID的UTF-8真实体积超过256KiB时拒绝，旧记录原子保留', () => {
    const lesson = fixture();
    const template = getEntries(lesson)[0];
    lesson.gameData.segments[0].entries = Array.from({ length: 100 }, (_, index) => ({
      ...structuredClone(template),
      id: `${'标'.repeat(300)}-${index}`,
      english: 'word',
      meaning: '课堂释义',
    }));
    const settings = captureClassroomSettings(lesson);
    const key = classroomStorageKey(lesson);
    localStorage.setItem(key, 'previous-record-retained');
    expect(JSON.stringify(settings).length).toBeLessThan(256 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(settings)).byteLength).toBeGreaterThan(
      256 * 1024,
    );
    expect(() => saveClassroomSettings(lesson, {}, settings)).toThrow('256 KiB');
    expect(localStorage.getItem(key)).toBe('previous-record-retained');
  });

  it('旧条目缺少齐读参数时只继承4／1，不给原课件物化字段；快照与恢复对象独立', () => {
    const lesson = fixture();
    getEntries(lesson).forEach((entry) => {
      delete entry.chorus;
    });
    delete lesson.gameData.chorusGapBeats;
    const settings = captureClassroomSettings(lesson);
    expect(
      settings.chorus.map(({ beats, beatsPerRead }) => [beats.value, beatsPerRead.value]),
    ).toEqual([
      [4, 1],
      [4, 1],
    ]);
    const next = applyClassroomSettings(lesson, settings, {});
    expect(getEntries(next).every((entry) => entry.chorus === undefined)).toBe(true);
    expect(next.gameData.chorusGapBeats).toBeUndefined();
    settings.chorus[0].beats.value = 8;
    settings.chorus[0].beats.source = 'manual';
    const changed = applyClassroomSettings(lesson, settings, {});
    settings.chorus[0].beats.value = 16;
    expect(getEntries(changed)[0].chorus?.beats.value).toBe(8);
    getEntries(changed)[0].chorus!.beatsPerRead.value = 2;
    expect(settings.chorus[0].beatsPerRead.value).toBe(1);
    expect(getEntries(lesson)[0].chorus).toBeUndefined();
  });

  it.each([
    [1, 1],
    [4, 1],
    [4, 2],
    [8, 2],
    [32, 1],
    [32, 2],
  ])('%s拍／每次%s拍保存重开后保持真实次数与时间轴', (beats, perRead) => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    settings.chorus[0].beats = { value: beats, source: 'manual', locked: false };
    settings.chorus[0].beatsPerRead = { value: perRead, source: 'manual', locked: false };
    saveClassroomSettings(lesson, {}, settings);
    const loaded = loadClassroomSettings(lesson, {});
    const cue = compileWordBeat(loaded.lesson, {}).cues.find((item) => item.kind === 'chorus')!;
    expect(cue.durationMs).toBe(beats * 600);
    expect(cue.data.totalBeats).toBe(beats);
    expect(cue.data.beatsPerRead).toBe(perRead);
    expect(cue.data.totalBeats! / cue.data.beatsPerRead!).toBe(beats / perRead);
  });

  it.each([
    [0, 1],
    [33, 1],
    [4.5, 1],
    [4, 0],
    [4, 3],
    [4, 1.5],
    [1, 2],
    [3, 2],
    [NaN, 1],
    [Infinity, 1],
  ])('非法%s／%s不能写入或覆盖上次完成的记录', (beats, perRead) => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    saveClassroomSettings(lesson, {}, settings);
    const key = classroomStorageKey(lesson);
    const before = localStorage.getItem(key);
    settings.chorus[0].beats.value = beats;
    settings.chorus[0].beatsPerRead.value = perRead;
    expect(() => saveClassroomSettings(lesson, {}, settings)).toThrow('不完整或超出');
    expect(localStorage.getItem(key)).toBe(before);
  });

  it.each([-1, 5, 0.5, NaN])('非法词间间隔%s不保存；合法边界不改变其他模式参数', (gap) => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    settings.chorusGapBeats = gap;
    expect(() => saveClassroomSettings(lesson, {}, settings)).toThrow();
    expect(localStorage.length).toBe(0);
  });

  it.each([0, 4])('合法词间间隔%s保存重开，非齐读隐藏参数原样保留', (gap) => {
    const lesson = legacyRhythmFixture();
    lesson.gameData.chorusGapBeats = gap;
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson);
    saveClassroomSettings(lesson, {}, settings);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.settings).toEqual(settings);
    expect(loaded.lesson.gameData.chorusGapBeats).toBe(gap);
    expect(getEntries(loaded.lesson).map((entry) => entry.chorus)).toEqual(
      getEntries(before).map((entry) => entry.chorus),
    );
    expect(lesson).toEqual(before);
    lesson.gameData.soundMode = 'teacher';
    settings.soundMode = 'teacher';
    saveClassroomSettings(lesson, {}, settings);
    expect(loadClassroomSettings(lesson, {}).settings).toEqual(settings);
  });

  it('非齐读保留有限但不适用的原始组合与间隔，不能通过存储修改隐藏规则', () => {
    const lesson = fixture();
    lesson.gameData.soundMode = 'teacher';
    getEntries(lesson)[0].chorus = {
      beats: { value: 3, source: 'manual', locked: false },
      beatsPerRead: { value: 2, source: 'manual', locked: false },
    };
    lesson.gameData.chorusGapBeats = 4.5;
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson);
    settings.volumes.beat = 0.35;
    saveClassroomSettings(lesson, {}, settings);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.settings).toEqual(settings);
    expect(getEntries(loaded.lesson)[0].chorus).toEqual(getEntries(lesson)[0].chorus);
    expect(loaded.lesson.gameData.chorusGapBeats).toBe(4.5);
    expect(lesson).toEqual(before);
    const key = classroomStorageKey(lesson);
    const raw = localStorage.getItem(key);
    for (const value of [
      { ...settings, chorusGapBeats: 0 },
      {
        ...settings,
        chorus: [
          { ...settings.chorus[0], beats: { ...settings.chorus[0].beats, value: 4 } },
          settings.chorus[1],
        ],
      },
      {
        ...settings,
        chorus: [
          { ...settings.chorus[0], beats: { ...settings.chorus[0].beats, source: 'preset' } },
          settings.chorus[1],
        ],
      },
    ])
      expect(() => applyClassroomSettings(lesson, value, {})).toThrow('当前模式只能保留');
    expect(localStorage.getItem(key)).toBe(raw);
    const active = structuredClone(loaded.lesson);
    active.gameData.soundMode = 'chorus';
    settings.soundMode = 'chorus';
    expect(() => applyClassroomSettings(active, settings, {})).toThrow('齐读拍数');
  });

  it('齐读ID集合、来源枚举、未知字段与独立锁定不能通过本地存储绕过', () => {
    const lesson = legacyRhythmFixture();
    const settings = captureClassroomSettings(lesson);
    const first = settings.chorus[0];
    const second = settings.chorus[1];
    for (const value of [
      { ...settings, chorus: [first, first] },
      { ...settings, chorus: [first] },
      { ...settings, chorus: [first, { ...second, id: 'another-entry' }] },
      { ...settings, chorus: [first, { ...second, extra: true }] },
      {
        ...settings,
        chorus: [{ ...first, beats: { ...first.beats, source: 'automatic' } }, second],
      },
      {
        ...settings,
        chorus: [{ ...first, beatsPerRead: { ...first.beatsPerRead, extra: 1 } }, second],
      },
      { ...settings, chorus: [first, { ...second, beats: { ...second.beats, value: 16 } }] },
      { ...settings, chorus: [first, { ...second, beats: { ...second.beats, source: 'preset' } }] },
      { ...settings, chorus: [first, { ...second, beats: { ...second.beats, locked: false } }] },
      {
        ...settings,
        chorus: [{ ...first, beatsPerRead: { ...first.beatsPerRead, locked: true } }, second],
      },
    ])
      expect(() => applyClassroomSettings(lesson, value, {})).toThrow();
    // 该词只锁总拍数，不能误把另一个未锁字段也禁用；明确改占拍仍合法。
    settings.chorus[1].beatsPerRead.value = 1;
    expect(getEntries(applyClassroomSettings(lesson, settings, {}))[1].chorus).toEqual({
      beats: { value: 8, source: 'manual', locked: true },
      beatsPerRead: { value: 1, source: 'manual', locked: false },
    });
  });

  it('只锁每次占拍时仍可改总拍数，锁定的值及来源必须独立保留', () => {
    const lesson = fixture();
    getEntries(lesson)[0].chorus = {
      beats: { value: 4, source: 'preset', locked: false },
      beatsPerRead: { value: 2, source: 'manual', locked: true },
    };
    const settings = captureClassroomSettings(lesson);
    settings.chorus[0].beats = { value: 8, source: 'manual', locked: false };
    expect(getEntries(applyClassroomSettings(lesson, settings, {}))[0].chorus?.beats.value).toBe(8);
    settings.chorus[0].beatsPerRead.value = 1;
    expect(() => applyClassroomSettings(lesson, settings, {})).toThrow('锁定');
    settings.chorus[0].beatsPerRead.value = 2;
    settings.chorus[0].beatsPerRead.source = 'preset';
    expect(() => applyClassroomSettings(lesson, settings, {})).toThrow('锁定');
  });

  it('外部写入的v4非法组合读取时不套用、不删除，不改变原始课件', () => {
    const lesson = fixture();
    const before = structuredClone(lesson);
    saveClassroomSettings(lesson, {}, captureClassroomSettings(lesson));
    const key = classroomStorageKey(lesson);
    const record = JSON.parse(localStorage.getItem(key)!);
    record.settings.chorus[0].beats.value = 3;
    record.settings.chorus[0].beatsPerRead.value = 2;
    const raw = JSON.stringify(record);
    localStorage.setItem(key, raw);
    const loaded = loadClassroomSettings(lesson, {});
    expect(loaded.notice).toContain('损坏');
    expect(loaded.settings).toEqual(captureClassroomSettings(lesson));
    expect(localStorage.getItem(key)).toBe(raw);
    expect(lesson).toEqual(before);
  });

  it('拍数本身合法但超出非循环对拍音乐时，正式编排拒绝且保留旧记录和原课', () => {
    const lesson = fixture();
    Object.assign(lesson.gameData.music, {
      enabled: true,
      assetId: 'music',
      syncEnabled: true,
      loop: false,
      sync: { bpm: 100, firstBeatMs: 0, loopStartMs: 0, loopEndMs: 0 },
    });
    const assets: AssetMap = {
      music: {
        assetId: 'music',
        mimeType: 'audio/wav',
        durationMs: 6000,
        byteLength: 44,
        sha256: 'c'.repeat(64),
      },
    };
    const before = structuredClone(lesson);
    const settings = captureClassroomSettings(lesson);
    saveClassroomSettings(lesson, assets, settings);
    const raw = localStorage.getItem(classroomStorageKey(lesson));
    settings.chorus[0].beats = { value: 8, source: 'manual', locked: false };
    expect(() => saveClassroomSettings(lesson, assets, settings)).toThrow('音乐不足以覆盖');
    expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    expect(lesson).toEqual(before);
  });

  it('读取、写入和删除失败有明确结果，写入失败保留旧值供重试', () => {
    const lesson = fixture();
    const settings = captureClassroomSettings(lesson);
    saveClassroomSettings(lesson, {}, settings);
    const raw = localStorage.getItem(classroomStorageKey(lesson));
    const fail = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(fail);
    expect(loadClassroomSettings(lesson, {}).notice).toContain('无法读取');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(fail);
    settings.bpm = 120;
    expect(() => saveClassroomSettings(lesson, {}, settings)).toThrow('未能保存');
    expect(localStorage.getItem(classroomStorageKey(lesson))).toBe(raw);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(fail);
    expect(() => clearClassroomSettings(lesson)).toThrow('未能清除');
    saveClassroomSettings(lesson, {}, settings);
    expect(loadClassroomSettings(lesson, {}).settings.bpm).toBe(120);
  });
});
