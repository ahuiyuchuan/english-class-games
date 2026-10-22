/**
 * 对照设计05 §2.2的版本化贯穿案例，串联选词、确认成果、声音绑定、编排与副本替换。
 * PCM夹具是可携带的测试信号；不把它冒充词语发音、WinRT合成或真实设备同步验证。
 * @author ahui
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/fixture-v1.json';
import type { DictionaryEntry } from '../src/platform/materials/types';
import type { AssetMap, TeachingEntry } from '../src/platform/types';
import {
  chooseReadingMeaning,
  createDictionaryIndex,
  parseReadingText,
  selectedReadingEntries,
} from '../src/platform/materials/dictionary';
import { countConfirmedFields } from '../src/shared/ai/completion-summary';
import {
  applyPreset,
  bindRecording,
  compileWordBeat,
  createWordBeatLesson,
  getEntries,
  validateWordBeat,
} from '../src/games/word-beat/rules';
import { copyLesson, replaceMaterials } from '../src/games/word-beat/suggestions';
import { validateEmbeddedAssets } from '../src/portable/media';

/** 明确校对状态及词库版本；常用词初始为空，绝不从实际发行词库补入隐含候选。 */
function readingCandidates() {
  const dictionary: DictionaryEntry[] = fixture.dictionary.map((entry) => ({
    ...entry,
    tags: [],
    source: fixture.source,
    sourceVersion: fixture.version,
    reviewStatus: 'reviewed-sense',
  }));
  let id = 0;
  return parseReadingText(
    fixture.text,
    createDictionaryIndex(dictionary, []),
    () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
  );
}

/** 仅执行夹具列出的教师选择，不按候选位置或“唯一义项”自动接受。 */
function acceptedEntries(): TeachingEntry[] {
  return selectedReadingEntries(
    readingCandidates().map((candidate) => {
      const choice = fixture.selected.find((entry) => entry.english === candidate.english);
      if (!choice) return candidate;
      const index = candidate.dictionaryEntries.findIndex(
        (entry) => entry.meaning === choice.meaning && entry.partOfSpeech === choice.partOfSpeech,
      );
      return { ...chooseReadingMeaning(candidate, index), selected: true };
    }),
  );
}

/**
 * 构造固定900毫秒、48kHz单声道PCM16，使用非零信号避免只有伪元信息。
 * @returns 完整RIFF/WAVE字节；帧数和时长由固定夹具计算，不访问本机语音或文件服务。
 */
function waveSignal(): Buffer {
  const { sampleRate, audioDurationMs } = fixture.timing;
  const frames = (sampleRate * audioDurationMs) / 1000;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++) {
    bytes.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 1000),
      44 + index * 2,
    );
  }
  return bytes;
}

/** 按正式录音入口绑定实际字节，关闭全部口号和音乐；教学文本及条目类型保持不变。 */
function timedLesson(entries: TeachingEntry[]) {
  let lesson = createWordBeatLesson(entries, { preset: 'regular', soundMode: 'voiced', seed: 1 });
  // fixture-v1 explicitly uses the original two-round teaching arrangement.
  lesson = applyPreset(lesson, 'regular');
  Object.values(lesson.gameData.slogans).forEach((slogan) => {
    slogan.enabled = false;
  });
  const bytes = waveSignal();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assets: AssetMap = {};
  for (const entry of getEntries(lesson)) {
    const asset = {
      assetId: `signal-${entry.id}`,
      kind: 'recording' as const,
      mimeType: 'audio/wav',
      byteLength: bytes.length,
      durationMs: fixture.timing.audioDurationMs,
      sampleRate: fixture.timing.sampleRate,
      channels: 1,
      frameCount: (fixture.timing.sampleRate * fixture.timing.audioDurationMs) / 1000,
      sha256,
      dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`,
    };
    assets[asset.assetId] = asset;
    lesson = bindRecording(lesson, entry.id, asset);
  }
  return { lesson, assets };
}

describe('fixture-v1：设计规定的固定贯穿案例', () => {
  it('默认不选词或代选义项，教师接受后严格为原序3条和6个确认字段', () => {
    expect(fixture.version).toBe('fixture-v1');
    const candidates = readingCandidates();
    expect(candidates.every((candidate) => !candidate.selected)).toBe(true);
    expect(candidates.every((candidate) => candidate.selectedDictionaryEntry === undefined)).toBe(
      true,
    );
    expect(candidates.find((candidate) => candidate.english === 'and')?.functionWord).toBe(true);
    expect(
      candidates.find((candidate) => candidate.english === 'Novex')?.dictionaryEntries,
    ).toEqual([]);
    expect(candidates.find((candidate) => candidate.english === 'challenges')?.lemma).toBe(
      'challenge',
    );
    const phrase = candidates.find((candidate) => candidate.english === 'take part in')!;
    expect(
      candidates
        .filter((candidate) => candidate.hiddenByPhrase === phrase.id)
        .map((candidate) => candidate.english),
    ).toEqual(['take', 'part', 'in']);
    const entries = acceptedEntries();
    expect(
      entries.map(({ english, meaning, partOfSpeech }) => ({ english, meaning, partOfSpeech })),
    ).toEqual(fixture.selected);
    expect(countConfirmedFields(entries)).toBe(6);
    expect(entries.every((entry) => entry.meaningSource?.version === fixture.version)).toBe(true);
    // 常用词保存的是独立教学快照；后来改原候选不能反向改动此处确认结果。
    const savedCommonWords = structuredClone(entries);
    entries[0].meaning = '后来编辑的原材料';
    expect(savedCommonWords[0].meaning).toBe('挑战');
    const fromSaved = createDictionaryIndex([], savedCommonWords);
    expect(fromSaved.entries).toHaveLength(3);
    expect(fromSaved.entries.every((entry) => entry.reviewStatus === 'teacher-confirmed')).toBe(
      true,
    );
    expect(countConfirmedFields(savedCommonWords)).toBe(6);
  });

  it.each([
    ['一个普通词', [0], false, fixture.timing.singleWordMs],
    ['两个普通词同段', [0, 2], false, fixture.timing.twoWordsSameSectionMs],
    ['两个普通词各一段', [0, 2], true, fixture.timing.twoWordsSeparateSectionsMs],
    ['三条含短语同段', [0, 1, 2], false, fixture.timing.selectedThreeSameSectionMs],
  ] as const)('%s的完整编排符合确定时长', async (_name, indices, split, expected) => {
    const entries = acceptedEntries();
    const { lesson, assets } = timedLesson(indices.map((index) => entries[index]));
    if (split) {
      const [section] = lesson.gameData.segments;
      lesson.gameData.segments = section.entries.map((entry, index) => ({
        id: `${section.id}-${index}`,
        name: `第${index + 1}组`,
        entries: [entry],
      }));
    }
    expect(lesson.gameData.bpm.value).toBe(fixture.timing.bpm);
    expect(validateWordBeat(lesson, assets).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    await expect(validateEmbeddedAssets(assets)).resolves.toBe(assets);
    expect(compileWordBeat(lesson, assets).durationMs).toBe(expected);
  });

  it('副本替换为knowledge后为1条，原课件3条及其来源、安排均保持', () => {
    const entries = acceptedEntries();
    const { lesson } = timedLesson(entries);
    const before = structuredClone(lesson);
    const copy = copyLesson(lesson, '固定贯穿副本');
    const replacement = replaceMaterials(copy, [entries[2]]);
    expect(getEntries(replacement).map((entry) => entry.english)).toEqual(['knowledge']);
    expect(replacement.id).not.toBe(lesson.id);
    expect(lesson).toEqual(before);
    expect(getEntries(lesson)).toHaveLength(3);
    expect(getEntries(replacement)[0].meaningSource).toEqual(entries[2].meaningSource);
  });
});
