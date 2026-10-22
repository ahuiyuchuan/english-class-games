/** 双修订、素材清单与 Windows 路径的跨端协议回归。 @author ahui */
import { describe, expect, it } from 'vitest';
import {
  createPackageData,
  packageAsset,
  validatePackageData,
  validatePackageManifest,
  validatePackagePath,
} from './lesson-package';
import type { LessonDocument } from '../../platform/types';
import { createWordBeatLesson, validateWordBeat } from '../../games/word-beat/rules';
import { validateWordBeatStructure } from '../../games/word-beat/structure';

const draft: LessonDocument = {
  id: 'lesson',
  name: '课件',
  gameId: 'fixture',
  revision: 3,
  dataVersion: 1,
  gameData: {},
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
};
const sha256 = 'a'.repeat(64);
const manifest = {
  formatVersion: 1,
  gameId: 'fixture',
  minimumPlatformVersion: '1.0.0',
  runtimeVersion: 1,
  sourceLessonId: 'lesson',
  generatedAt: '2026-10-20T00:00:00Z',
  lessonSha256: sha256,
  assets: [],
};

describe('可编辑包结构', () => {
  it('草稿、同版已准备和双版本分别保留正确指针，不伪造准备成功', () => {
    expect(createPackageData(draft).preparedRevision).toBeNull();
    expect(createPackageData(draft, draft).revisions).toHaveLength(1);
    const data = createPackageData(draft, { ...draft, revision: 2 });
    expect(data.revisions).toHaveLength(2);
    expect(data.preparedRevision).toBe(2);
    expect(validatePackageData(data, validatePackageManifest(manifest))).toEqual(data);
    expect(() => createPackageData(draft, { ...draft, id: 'other', revision: 2 })).toThrow(
      '不一致',
    );
    expect(() => createPackageData(draft, { ...draft, revision: 4 })).toThrow('未对应');
  });

  it('丢失指针、无关修订、过高格式和不完整哈希不能入库', () => {
    expect(() => validatePackageData({ ...createPackageData(draft), draftRevision: 1 })).toThrow(
      '未对应',
    );
    expect(() => validatePackageManifest({ ...manifest, formatVersion: 2 })).toThrow('不支持');
    expect(() => validatePackageManifest({ ...manifest, lessonSha256: 'invalid' })).toThrow(
      '校验值',
    );
  });

  it('拒绝越界、设备路径、数据流、大小写碰撞和无效素材元信息', () => {
    for (const path of [
      '../escape.wav',
      '/tmp/a',
      'C:/a.wav',
      'assets/CON.wav',
      'assets/a.wav:stream',
      'assets/a.wav ',
      'assets/../a.wav',
      'assets\\a.wav',
      'assets/a?.wav',
      'assets/a|b.wav',
      'assets/a<1>.wav',
      'assets/a"b.wav',
    ])
      expect(() => validatePackagePath(path)).toThrow();
    const asset = packageAsset({
      assetId: 'a',
      mimeType: 'audio/wav',
      byteLength: 20,
      durationMs: 100,
      sha256,
    });
    expect(validatePackageManifest({ ...manifest, assets: [asset] }).assets).toHaveLength(1);
    expect(
      validatePackageManifest({
        ...manifest,
        assets: [asset, { ...asset, assetId: 'same-content' }],
      }).assets,
    ).toHaveLength(2);
    expect(() =>
      validatePackageManifest({
        ...manifest,
        assets: [asset, { ...asset, assetId: 'b', path: asset.path.toUpperCase() }],
      }),
    ).toThrow('重复');
    expect(() =>
      validatePackageManifest({ ...manifest, assets: [{ ...asset, byteLength: 0 }] }),
    ).toThrow('大小');
  });

  it('平台 / 运行核心版本分别检查，不能只验证格式版本', () => {
    expect(validatePackageManifest({ ...manifest, runtimeVersion: 2 }).runtimeVersion).toBe(2);
    expect(validatePackageManifest({ ...manifest, runtimeVersion: 3 }).runtimeVersion).toBe(3);
    expect(() => validatePackageManifest({ ...manifest, runtimeVersion: 4 })).toThrow('更新');
    expect(() =>
      validatePackageManifest({ ...manifest, minimumPlatformVersion: '99.0.0' }),
    ).toThrow('更新');
    expect(() =>
      validatePackageManifest({ ...manifest, minimumPlatformVersion: 'latest' }),
    ).toThrow('主、次');
    expect(() => createPackageData(draft, { ...draft, id: 'other' })).toThrow('不一致');
  });

  it('未完成草稿和合法旧准备版独立保留；坏的第二快照或未知版本整包拒绝', () => {
    const prepared = createWordBeatLesson(
      [{ id: 'one', english: 'knowledge', meaning: '知识', priority: false }],
      { soundMode: 'teacher' },
    );
    prepared.revision = 1;
    Object.values(prepared.gameData.slogans).forEach((slogan) => {
      slogan.enabled = false;
    });
    const unfinished = structuredClone(prepared);
    unfinished.revision = 2;
    unfinished.gameData.segments[0].entries[0].english = '';
    unfinished.draftInputs = { bpm: { raw: '1e', message: '请输入完整数值。' } };
    const data = createPackageData(unfinished, prepared);
    const verified = validatePackageData(
      JSON.parse(JSON.stringify(data)),
      undefined,
      validateWordBeatStructure,
    );
    expect(verified.revisions[0].draftInputs?.bpm.raw).toBe('1e');
    expect(verified.preparedRevision).toBe(1);
    expect(validateWordBeat(unfinished, {}).some((issue) => issue.severity === 'error')).toBe(true);
    expect(validateWordBeat(prepared, {}).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const badStructure = structuredClone(data);
    (badStructure.revisions[1].gameData as Record<string, unknown>).segments = null;
    expect(() => validatePackageData(badStructure, undefined, validateWordBeatStructure)).toThrow();
    const badVersion = structuredClone(data);
    badVersion.revisions[1].dataVersion = 2;
    expect(() => validatePackageData(badVersion, undefined, validateWordBeatStructure)).toThrow(
      '版本',
    );
    expect(() =>
      validatePackageData(
        {
          ...data,
          revisions: [
            { ...data.revisions[0], draftInputs: { bpm: { raw: 12, message: '错误' } } },
            data.revisions[1],
          ],
        },
        undefined,
        validateWordBeatStructure,
      ),
    ).toThrow('原始文本');
  });

  it('两版禁用或失效声音仍须在素材清单中，不能只收集当前启用声音', () => {
    const prepared = {
      ...draft,
      revision: 2,
      gameData: { disabledSound: { assetId: 'old-voice', status: 'stale', enabled: false } },
    };
    const data = createPackageData(draft, prepared);
    const validatedManifest = validatePackageManifest(manifest);
    expect(() => validatePackageData(data, validatedManifest)).toThrow('清单中没有');
    validatedManifest.assets = [
      packageAsset({
        assetId: 'old-voice',
        mimeType: 'audio/wav',
        byteLength: 20,
        durationMs: 100,
        sha256,
      }),
    ];
    expect(validatePackageData(data, validatedManifest).revisions).toHaveLength(2);
  });

  it('可编辑包原样保留两版整理依据，旧版无依据仍兼容，坏记录定位到对应快照', () => {
    const prepared = createWordBeatLesson(
      [{ id: 'one', english: 'knowledge', meaning: '知识', priority: false }],
      { soundMode: 'teacher' },
    );
    prepared.revision = 1;
    const current = structuredClone(prepared);
    current.revision = 2;
    const source = {
      name: '教师阅读材料',
      original: 'knowledge',
      analysis: {
        ruleId: 'platform.material.match' as const,
        ruleVersion: 1,
        functionWordsVersion: 1,
        dictionaryVersions: [{ name: 'ECDICT', version: '固定来源修订' }],
      },
    };
    current.gameData.segments[0].entries[0].source = source;
    const data = JSON.parse(JSON.stringify(createPackageData(current, prepared)));
    const restored = validatePackageData(data, undefined, validateWordBeatStructure);
    expect(restored.revisions[0]).toMatchObject({
      gameData: { segments: [{ entries: [{ source }] }] },
    });
    expect(restored.revisions[1]).toEqual(prepared);
    data.revisions[0].gameData.segments[0].entries[0].source.analysis.functionWordsVersion = null;
    expect(() => validatePackageData(data, undefined, validateWordBeatStructure)).toThrow(
      'source.analysis.functionWordsVersion',
    );
  });
});
