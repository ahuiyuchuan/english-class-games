/** 内嵌素材完整性边界；按真实字节核对，不能仅测试元信息形状。 @author ahui */
import { describe, expect, it } from 'vitest';
import { decodeAudioDataUrl, sha256Bytes, validateEmbeddedAssets } from './media';
import { readEmbeddedAudio } from '../runtime/audio';
import type { AudioAsset } from '../platform/types';

async function embeddedFixture(): Promise<AudioAsset> {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    assetId: '__proto__',
    mimeType: 'audio/wav',
    byteLength: bytes.byteLength,
    durationMs: 100,
    sha256: await sha256Bytes(bytes),
    dataUrl: 'data:audio/wav;base64,AQID',
  };
}

describe('课堂内嵌声音检查', () => {
  it('较大内嵌音频经过完整性检查与播放读取后，零字节和高位字节均原样保留', async () => {
    // 覆盖全部 256 种字节及非三倍数长度，防止优化复制时误用 UTF-8 编码或丢掉尾字节。
    const original = Uint8Array.from({ length: 262_147 }, (_, index) => index % 256);
    const dataUrl = `data:audio/wav;base64,${Buffer.from(original).toString('base64')}`;
    const fixture = {
      ...(await embeddedFixture()),
      assetId: 'large-binary-audio',
      dataUrl,
      byteLength: original.byteLength,
      sha256: await sha256Bytes(original),
    };
    expect(decodeAudioDataUrl(dataUrl)).toEqual(original);
    await expect(validateEmbeddedAssets({ [fixture.assetId]: fixture })).resolves.toEqual({
      [fixture.assetId]: fixture,
    });
    expect(new Uint8Array(await readEmbeddedAudio(fixture))).toEqual(original);
  });

  it('无声音可通过，特殊身份从JSON往返后仍作为独立资源保留', async () => {
    expect(await validateEmbeddedAssets({})).toEqual({});
    const asset = await embeddedFixture();
    const assets = JSON.parse(`{"__proto__":${JSON.stringify(asset)}}`);
    expect(await validateEmbeddedAssets(assets)).toBe(assets);
    expect(Object.hasOwn(assets, '__proto__')).toBe(true);
  });

  it('同大小的声音被改动也会拒绝，不能只核对声明的大小', async () => {
    const asset = await embeddedFixture();
    await expect(
      validateEmbeddedAssets({
        [asset.assetId]: { ...asset, dataUrl: 'data:audio/wav;base64,AQIE' },
      }),
    ).rejects.toThrow('校验不通过');
    await expect(
      validateEmbeddedAssets({ [asset.assetId]: { ...asset, byteLength: 4 } }),
    ).rejects.toThrow('校验不通过');
  });

  it('坏清单、外部地址、非法base64和媒体类型不一致无法绕过完整性检查', async () => {
    const asset = await embeddedFixture();
    for (const value of [null, [], 1])
      await expect(validateEmbeddedAssets(value)).rejects.toThrow('清单损坏');
    for (const patch of [
      { assetId: 'different' },
      { durationMs: Number.NaN },
      { dataUrl: 'https://example.com/voice.wav' },
      { mimeType: 'audio/mpeg' },
      { dataUrl: 'data:audio/wav;base64,AQ!D' },
    ])
      await expect(
        validateEmbeddedAssets({ [asset.assetId]: { ...asset, ...patch } }),
      ).rejects.toThrow(/损坏/u);
  });
});
