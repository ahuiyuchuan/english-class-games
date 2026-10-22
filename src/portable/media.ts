/**
 * 课堂文件共用的媒体编码与完整性检查，不依赖桌面服务或导出后的运行核心资源。
 * 依次核对内嵌字节，避免将所有声音同时解码为 AudioBuffer 造成内存峰值。
 * @author ahui
 */
import type { AssetMap } from '../platform/types';

/** 只读取内嵌音频，不将教学内容或用户路径解释为外部请求地址。 */
export function decodeAudioDataUrl(value: string): Uint8Array {
  const match = /^data:(audio\/(?:wav|x-wav|mpeg|mp3));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error('声音不是可携带的 WAV / MP3 数据。');
  const binary = atob(match[2]);
  // 直接复制二进制字符串，避免大课件逐字符迭代 / 回调阻塞开始页；所有字节仍逐项保留。
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * 根据实际字节计算 SHA-256，元信息声明不能替代文件内容检查。
 * @param bytes 未解码为声音的原始文件字节；不修改传入数组。
 * @returns 小写十六进制摘要。
 * @throws DOMException 当前安全环境不提供 Web Crypto 或计算失败。
 */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * 打开实际课堂文件时重新核对内嵌声音，发现复制损坏后停在修复页，不先启动课堂。
 * @param value 从课堂 JSON 读取的未知素材表；每项必须是自包含 WAV / MP3。
 * @returns 同一份已核验映射，保留特殊素材身份，不重新拼接普通原型对象。
 * @throws Error 元信息、base64、大小或内容摘要不一致；调用方应显示重新复制 / 导出提示。
 */
export async function validateEmbeddedAssets(value: unknown): Promise<AssetMap> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('课堂文件的素材清单损坏，请重新复制或导出。');
  for (const [assetId, input] of Object.entries(value)) {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new Error('课堂文件的声音信息损坏，请重新复制或导出。');
    const asset = input as Record<string, unknown>;
    if (
      !assetId ||
      asset.assetId !== assetId ||
      !Number.isSafeInteger(asset.byteLength) ||
      Number(asset.byteLength) <= 0 ||
      typeof asset.durationMs !== 'number' ||
      !Number.isFinite(asset.durationMs) ||
      asset.durationMs <= 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      typeof asset.mimeType !== 'string' ||
      !['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(asset.mimeType) ||
      typeof asset.dataUrl !== 'string' ||
      !asset.dataUrl.startsWith(`data:${asset.mimeType};base64,`)
    )
      throw new Error('课堂文件的声音信息损坏，请重新复制或导出。');
    let bytes: Uint8Array;
    try {
      bytes = decodeAudioDataUrl(asset.dataUrl);
    } catch {
      throw new Error('课堂文件的声音数据损坏，请重新复制或导出。');
    }
    if (bytes.byteLength !== asset.byteLength || (await sha256Bytes(bytes)) !== asset.sha256)
      throw new Error('课堂文件的声音校验不通过，请重新复制或导出。');
  }
  return value as AssetMap;
}
