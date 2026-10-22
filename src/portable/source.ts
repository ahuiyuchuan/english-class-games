/** 按需读取随包对应源码，避免Base64进入应用主脚本和常驻堆。 @author ahui */
import sourceUrl from './generated/portable-source.zip?url';
import sourceInfo from './generated/source.json';
import { sha256Bytes } from './media';

export { sourceUrl, sourceInfo };

/**
 * 仅导出时读取固定构建资源；SSR构建／测试使用同一生成ZIP原始字节。
 * @returns 当前播放器源码ZIP的Base64；调用方放入非执行数据区。
 * @throws Error 本地资源丢失或读取失败，阻止生成缺源码的课堂文件。
 */
export async function sourceBase64(): Promise<string> {
  let bytes: Uint8Array;
  if (import.meta.env.SSR) {
    const { readFile } = await import('node:fs/promises');
    bytes = await readFile(new URL('./generated/portable-source.zip', import.meta.url));
  } else {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error('对应源码读取失败，请重新安装完整软件后导出。');
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.byteLength !== sourceInfo.bytes || (await sha256Bytes(bytes)) !== sourceInfo.sha256)
    throw new Error('对应源码校验失败，请重新安装完整软件后导出。');
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32766)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32766)));
  return btoa(chunks.join(''));
}
