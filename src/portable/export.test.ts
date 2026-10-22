/** 实际离线成品生成与文本逃逸回归；共享运行核心由构建脚本生成而非伪造字符串。 @author ahui */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createWordBeatLesson, getEntries, validateWordBeat } from '../games/word-beat/rules';
import type { AssetMap, AudioAsset } from '../platform/types';
import { validateEmbeddedAssets } from './media';
import {
  createClassroomHtml,
  decodeAudioDataUrl,
  serializeEmbeddedJson,
  sha256Bytes,
  suggestClassroomFileName,
} from './export';

function teacherLesson() {
  const lesson = createWordBeatLesson(
    [{ id: 'word', english: 'knowledge', meaning: '知识', priority: false }],
    { soundMode: 'teacher', name: '高中词汇复习' },
  );
  Object.values(lesson.gameData.slogans).forEach((slogan) => {
    slogan.enabled = false;
  });
  return lesson;
}

/**
 * 构造真正可解码的 48 kHz、双声道 PCM16 WAV，避免用伪字节或超长教学文本凑体积。
 * @param frameCount 正整数采样帧数；本组案例最多 1,440,000 帧，即 30 秒。
 * @returns 完整 RIFF/WAVE 文件；静音帧也是真实 PCM 内容，不代表系统语音制作已通过。
 */
function pcmWave(frameCount: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + frameCount * 4);
  const view = new DataView(bytes.buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index++) bytes[offset + index] = tag.charCodeAt(index);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 48_000 * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, bytes.byteLength - 44, true);
  return bytes;
}

/**
 * 只用于寻找合法夹具体积，不替换生产导出器的任何门禁。
 * 这里核对素材在真实 JSON 中的元信息及 Base64 字节贡献；最终仍实际生成、计量并写出完整 HTML。
 */
function embeddedAssetSize(asset: AudioAsset): number {
  const metadata = {
    assetId: asset.assetId,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    durationMs: asset.durationMs,
    sha256: asset.sha256,
    kind: asset.kind,
    name: asset.name,
    dataUrl: `data:${asset.mimeType};base64,`,
  };
  return (
    Buffer.byteLength(serializeEmbeddedJson(metadata), 'utf8') + Math.ceil(asset.byteLength / 3) * 4
  );
}

describe('单文件课堂导出', () => {
  it('实际内嵌共享播放器及数据，文本模式无需配音也能独立导出', async () => {
    const html = await createClassroomHtml(
      teacherLesson(),
      {},
      { exportedAt: '2026-10-20T00:00:00Z' },
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('ecg-data');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).toContain('<template id="ecg-attribution">');
    expect(html).toContain('Copyright (c) 2025 Linwei');
    expect(html).toContain('Copyright (c) 2026 ahui');
    expect(html).toContain('react@18.3.1');
    expect(html).toContain('Permission is hereby granted');
    expect(html).toContain('GPL-3.0-only');
    const source =
      /<script id="ecg-source" type="application\/octet-stream" data-sha256="([a-f0-9]{64})">/u.exec(
        html,
      )!;
    // Large non-executable Base64 must not be traversed by a backtracking regexp.
    const begin = source.index + source[0].length;
    const archive = Buffer.from(html.slice(begin, html.indexOf('</script>', begin)), 'base64');
    expect(await sha256Bytes(archive)).toBe(source[1]);
    const files = unzipSync(archive);
    const text = (name: string) => new TextDecoder().decode(files[name]);
    expect(text('LICENSE')).toContain('Version 3, 29 June 2007');
    expect(text('src/games/word-beat/Classroom.tsx')).toContain('SoftwareLicense');
    expect(text('package.json')).toContain('GPL-3.0-only');
    expect(files['scripts/build-portable.mjs']).toBeDefined();
    expect(files['pnpm-lock.yaml']).toBeDefined();
    expect(Object.keys(files).some((name) => name.startsWith('.git/'))).toBe(false);
    // Public audio is reproducible from owned code. Keep its license and exact
    // grid metadata, while excluding PCM and any teacher-supplied recordings.
    expect(files['resources/music/LICENSE-CC0.txt']).toBeDefined();
    expect(files['resources/music/source.json']).toBeDefined();
    expect(Object.keys(files).some((name) => name.endsWith('.wav'))).toBe(false);
    const payload = JSON.parse(
      /<script id="ecg-data" type="application\/json">([^]*?)<\/script>/u.exec(html)![1],
    );
    expect(payload.lesson.gameData.soundMode).toBe('teacher');
    expect(payload.assets).toEqual({});
    expect(payload.exportedAt).toBe('2026-10-20T00:00:00Z');
  });

  it('教学文本不能逃出数据区或页面标题，恢复后的原文保持一致', async () => {
    const malicious = '</script><script>window.evil=true</script>';
    expect(JSON.parse(serializeEmbeddedJson({ text: malicious })).text).toBe(malicious);
    const lesson = teacherLesson();
    lesson.name = malicious;
    lesson.gameData.segments[0].entries[0].meaning = malicious;
    const html = await createClassroomHtml(lesson, {});
    expect(html).not.toContain('<script>window.evil=true</script>');
    expect(html).toContain('&lt;/script&gt;');
  });

  it('当前课件错误和缺失音频不能变成成功成品', async () => {
    const lesson = teacherLesson();
    lesson.gameData.soundMode = 'voiced';
    await expect(createClassroomHtml(lesson, {})).rejects.toThrow('尚不可导出');
  });

  it('音频只接受内嵌WAV/MP3，哈希按实际字节计算，命名过滤Windows字符', async () => {
    expect(decodeAudioDataUrl('data:audio/wav;base64,AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => decodeAudioDataUrl('https://example.com/a.wav')).toThrow('可携带');
    expect(await sha256Bytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(suggestClassroomFileName('高二:词汇/复习', new Date(2026, 9, 20))).toBe(
      '高二_词汇_复习_2026-10-20.html',
    );
  });

  it('跨越 Base64 分块边界的大声音仍可完整解码并通过成品哈希校验', async () => {
    const lesson = teacherLesson();
    lesson.gameData.soundMode = 'voiced';
    const entry = lesson.gameData.segments[0].entries[0];
    const assetId = 'large-voice';
    entry.audio = {
      source: 'recording',
      assetId,
      text: entry.english,
      language: 'en-US',
      rate: 1,
      status: 'ready',
    };
    // 故意使用非 3 的倍数且超过两个块的数据，覆盖中间块填充破坏 Base64 的边界。
    const bytes = Uint8Array.from({ length: 70_001 }, (_, index) => index % 251);
    const assets: AssetMap = {
      [assetId]: {
        assetId,
        mimeType: 'audio/wav',
        byteLength: bytes.byteLength,
        durationMs: 100,
        sha256: await sha256Bytes(bytes),
      },
    };
    const html = await createClassroomHtml(lesson, assets, {
      resolveAsset: async () => bytes.slice().buffer,
    });
    const payloadText = /<script id="ecg-data" type="application\/json">([^]*?)<\/script>/u.exec(
      html,
    )?.[1];
    expect(payloadText).toBeDefined();
    const payload = JSON.parse(payloadText!) as { assets: AssetMap };
    const exportedAsset = payload.assets[assetId];
    expect(exportedAsset.dataUrl).toBeDefined();
    expect(decodeAudioDataUrl(exportedAsset.dataUrl!)).toEqual(bytes);
    await expect(validateEmbeddedAssets(payload.assets)).resolves.toBe(payload.assets);
  });

  it('导出在异步读取前固定输入快照，只携带启用声音并拒绝坏字节与不支持类型', async () => {
    const lesson = teacherLesson();
    lesson.gameData.soundMode = 'voiced';
    const entry = lesson.gameData.segments[0].entries[0];
    entry.audio = {
      source: 'recording',
      assetId: 'one',
      text: entry.english,
      language: 'en-US',
      rate: 1,
      status: 'ready',
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const assets: AssetMap = {
      one: {
        assetId: 'one',
        kind: 'recording',
        mimeType: 'audio/wav',
        byteLength: 3,
        durationMs: 100,
        sha256: await sha256Bytes(bytes),
      },
      unused: {
        assetId: 'unused',
        mimeType: 'audio/wav',
        byteLength: 10,
        durationMs: 100,
        sha256: '0'.repeat(64),
      },
    };
    const originalName = lesson.name;
    const html = await createClassroomHtml(lesson, assets, {
      resolveAsset: async (asset) => {
        expect(asset.assetId).toBe('one');
        lesson.name = '正在编辑的新草稿';
        assets.one.mimeType = 'audio/ogg';
        return bytes.slice().buffer;
      },
    });
    const payload = JSON.parse(
      /<script id="ecg-data" type="application\/json">([^]*?)<\/script>/u.exec(html)![1],
    );
    expect(payload.lesson.name).toBe(originalName);
    expect(Object.keys(payload.assets)).toEqual(['one']);
    expect(payload.assets.one.mimeType).toBe('audio/wav');
    expect(payload.assets.one.kind).toBe('recording');
    await expect(
      createClassroomHtml(lesson, assets, { resolveAsset: async () => bytes.slice().buffer }),
    ).rejects.toThrow('WAV / MP3');
    assets.one.mimeType = 'audio/wav';
    await expect(
      createClassroomHtml(lesson, assets, {
        resolveAsset: async () => new Uint8Array([1, 2, 4]).buffer,
      }),
    ).rejects.toThrow('校验不通过');
  });

  it('合法真实 WAV 成品恰好 100,000,000 字节可写出，多一个字节明确拒绝', async () => {
    const limit = 100_000_000;
    const exportedAt = '2026-10-20T00:00:00Z';
    const lesson = createWordBeatLesson(
      Array.from({ length: 13 }, (_, index) => ({
        id: `source-${index}`,
        english: `boundary term ${index + 1}`,
        meaning: 'PORT04',
        priority: false,
      })),
      { soundMode: 'voiced', name: '合法声音体积边界', seed: 123 },
    );
    lesson.gameData.bpm = { value: 50, source: 'manual', locked: false };
    Object.values(lesson.gameData.slogans).forEach((slogan) => {
      slogan.enabled = false;
    });
    const entries = getEntries(lesson);
    const metadata = (index: number, frameCount: number): AudioAsset => ({
      assetId: `pcm-${index}`,
      kind: 'recording',
      mimeType: 'audio/wav',
      byteLength: 44 + frameCount * 4,
      durationMs: (frameCount / 48_000) * 1_000,
      sampleRate: 48_000,
      channels: 2,
      frameCount,
      sha256: '0'.repeat(64),
    });
    entries.forEach((entry, index) => {
      entry.rounds = { value: 1, source: 'manual', locked: false };
      entry.follow = { mode: 'manual', beats: 1, locked: false };
      entry.audio = {
        source: 'recording',
        assetId: `pcm-${index}`,
        text: entry.english,
        language: 'en-US',
        rate: 1,
        status: 'ready',
      };
    });

    // 小文件也通过正式导出器，取得当前真实运行核心与合法课件的固定开销。
    // 运行核心重建后大小可变，因此不写死旧版本开销，也不 mock TextEncoder 或上限。
    const probeBytes = pcmWave(48);
    const probeHash = await sha256Bytes(probeBytes);
    const probeAssets = Object.fromEntries(
      entries.map((_, index) => {
        const asset = { ...metadata(index, 48), sha256: probeHash };
        return [asset.assetId, asset];
      }),
    );
    const probe = await createClassroomHtml(lesson, probeAssets, {
      exportedAt,
      resolveAsset: async () => probeBytes.slice().buffer,
    });
    const fixedBytes =
      Buffer.byteLength(probe, 'utf8') -
      Object.values(probeAssets).reduce((sum, asset) => sum + embeddedAssetSize(asset), 0);
    // Source now travels inside HTML too. Budget all voices against the actual
    // fixed overhead instead of assuming that only the tiny player occupies it.
    const initialFrames = Math.max(
      1,
      Math.min(1_440_000, Math.floor(((limit - fixedBytes - 100_000) * 3) / 16 / entries.length)),
    );
    const plans = entries.map((_, index) => metadata(index, initialFrames));
    const fixedAssetsBytes = plans
      .slice(0, -1)
      .reduce((sum, asset) => sum + embeddedAssetSize(asset), 0);
    let lower = 1;
    let upper = 1_440_000;
    // 预留少量字符以吸收 Base64 的四字节粒度；释义始终远小于 200 字符上限。
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      const predicted = fixedBytes + fixedAssetsBytes + embeddedAssetSize(metadata(12, middle));
      if (predicted <= limit - 64) lower = middle;
      else upper = middle - 1;
    }
    plans[12] = metadata(12, lower);
    const predictedBytes =
      fixedBytes + plans.reduce((sum, asset) => sum + embeddedAssetSize(asset), 0);
    const padding = limit - predictedBytes;
    expect(padding).toBeGreaterThanOrEqual(0);
    expect(padding).toBeLessThan(190);
    entries[0].meaning += 'x'.repeat(padding);

    const byteMap = new Map<string, Uint8Array<ArrayBuffer>>();
    const assets: AssetMap = {};
    for (const plan of plans) {
      const bytes = pcmWave(plan.frameCount!);
      byteMap.set(plan.assetId, bytes);
      assets[plan.assetId] = { ...plan, sha256: await sha256Bytes(bytes) };
      expect(bytes.byteLength).toBeLessThanOrEqual(20_000_000);
      expect(plan.durationMs).toBeLessThanOrEqual(30_000);
      expect(plan.frameCount! * plan.channels! * 4).toBeLessThanOrEqual(64_000_000);
    }
    expect(validateWordBeat(lesson, assets).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const resolvedIds: string[] = [];
    const options = {
      exportedAt,
      resolveAsset: async (asset: AudioAsset) => {
        resolvedIds.push(asset.assetId);
        return byteMap.get(asset.assetId)!.slice().buffer;
      },
    };
    const directory = await mkdtemp(join(tmpdir(), 'ecg-port04-'));
    try {
      const html = await createClassroomHtml(lesson, assets, options);
      expect(Buffer.byteLength(html, 'utf8')).toBe(limit);
      const file = join(directory, '100000000.html');
      await writeFile(file, html, 'utf8');
      expect((await stat(file)).size).toBe(limit);

      // 在实际完整成品中仅增加一个合法 ASCII 释义字符，独立计量 100,000,001 字节。
      // 再让生产导出器重新读取全部真实音频并构造同一内容，验证最终成品门禁确实拒绝。
      const oldMeaning = `"meaning":${serializeEmbeddedJson(entries[0].meaning)}`;
      const newMeaning = `"meaning":${serializeEmbeddedJson(`${entries[0].meaning}x`)}`;
      expect(html.indexOf(oldMeaning)).toBeGreaterThan(0);
      expect(html.indexOf(oldMeaning, html.indexOf(oldMeaning) + 1)).toBe(-1);
      expect(Buffer.byteLength(html.replace(oldMeaning, newMeaning), 'utf8')).toBe(limit + 1);
      entries[0].meaning += 'x';
      expect([...entries[0].meaning].length).toBeLessThanOrEqual(200);
      await expect(createClassroomHtml(lesson, assets, options)).rejects.toThrow('超过 100 MB');
      expect(resolvedIds).toHaveLength(26);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
