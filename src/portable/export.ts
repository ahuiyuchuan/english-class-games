/**
 * 将已准备课件、启用媒体和共享课堂运行核心装成一个离线 HTML。
 * 不重新编写播放器，不用 CDN、fetch 外部文件、系统语音或教室电脑本地缓存。
 * @author ahui
 */
import { getGame } from '../platform/games';
import type { AssetMap, AudioAsset, LessonDocument } from '../platform/types';
import runtimeBundle from './generated/runtime.json';
import { sourceBase64, sourceInfo as correspondingSource } from './source';
import { CLASSROOM_ATTRIBUTION } from '../shared/attribution';
import { decodeAudioDataUrl, sha256Bytes } from './media';

export { decodeAudioDataUrl, sha256Bytes } from './media';

/** 生产可传原生素材读取适配；已有 dataUrl 的浏览器预演不需要原生路径。 */
export interface ClassroomExportOptions {
  exportedAt?: string;
  resolveAsset?: (asset: AudioAsset) => Promise<ArrayBuffer>;
}

/** 离线文件只携带当前游戏运行需要的内容，不输出教师个人材料库。 */
export interface PortablePayload {
  formatVersion: 1;
  runtimeVersion: 1 | 2 | 3;
  exportedAt: string;
  lesson: LessonDocument;
  assets: AssetMap;
}

const MAX_HTML_BYTES = 100_000_000;
const utf8 = new TextEncoder();

/**
 * 安全内嵌 JSON。连 `<` 一起转义，阻止教学文本中的 </script> 或注释结束标记逃出数据区。
 * @param value 固定修订和素材数据；不接受函数或可执行 HTML。
 * @returns 仍可 JSON.parse 的文本，Unicode 内容显示保持一致。
 */
export function serializeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');

/** 基于原始字节生成 base64，按小块编码避免大型音频参数展开导致栈溢出。 */
function audioDataUrl(bytes: Uint8Array, mimeType: string): string {
  const chunks: string[] = [];
  // Base64 将每 3 个输入字节编码为 4 个字符；非末尾分块也必须按 3 字节对齐，
  // 否则中间分块的填充字符会破坏整个 URL，并使大音频无法通过开课时的哈希检查。
  const chunkSize = 32_766;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return `data:${mimeType};base64,${btoa(chunks.join(''))}`;
}

/**
 * 创建单文件课堂成品，只有当前模式必需且已启用的媒体进入文件。
 * @param lesson 当前已检查修订；函数会再调用游戏检查器，不能仅凭 preparedRevision 绕过检查。
 * @param assets 按身份索引的素材，路径只能经 resolveAsset 由受信任适配层读取。
 * @param options 固定导出时间及原生素材读取接口。
 * @returns 完整 UTF-8 HTML，交给原生服务写入、复读校验后才算导出成功。
 * @throws Error 课件错误、缺素材、哈希不符、无法取得共享播放器或实际成品超过 100 MB。
 */
export async function createClassroomHtml(
  lesson: LessonDocument,
  assets: AssetMap,
  options: ClassroomExportOptions = {},
): Promise<string> {
  // 导出包含异步读文件与哈希，进入时固定快照，期间编辑不能混进同一个成品。
  lesson = structuredClone(lesson);
  assets = structuredClone(assets);
  const game = getGame(lesson.gameId);
  if (!game || !game.capabilities.portable) throw new Error('当前游戏没有可用的离线课堂模块。');
  const structuralIssues = game
    .validateStructure(lesson)
    .filter((issue) => issue.severity === 'error');
  if (structuralIssues.length) throw new Error(`课件结构不可导出：${structuralIssues[0].message}`);
  const issues = game.validate(lesson, assets).filter((issue) => issue.severity === 'error');
  if (issues.length > 0)
    throw new Error(`课件尚不可导出：${issues.map((issue) => issue.message).join('；')}`);
  game.compile(lesson, assets);
  // 导入包可使用任意合法标识；空原型映射使 __proto__ 等键仍是普通素材身份。
  const portableAssets: AssetMap = Object.create(null) as AssetMap;
  let encodedBytes = 0;
  for (const assetId of new Set(game.requiredAssets(lesson))) {
    const asset = assets[assetId];
    if (!asset) throw new Error(`缺少声音素材：${assetId}`);
    if (!['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(asset.mimeType))
      throw new Error(`声音类型不受支持，请使用 WAV / MP3：${asset.name ?? assetId}`);
    const bytes = asset.dataUrl
      ? decodeAudioDataUrl(asset.dataUrl)
      : options.resolveAsset
        ? new Uint8Array(await options.resolveAsset(asset))
        : undefined;
    if (!bytes) throw new Error(`无法读取已启用声音：${asset.name ?? assetId}`);
    if (bytes.byteLength !== asset.byteLength || (await sha256Bytes(bytes)) !== asset.sha256)
      throw new Error(`声音文件校验不通过：${asset.name ?? assetId}`);
    encodedBytes += Math.ceil(bytes.byteLength / 3) * 4;
    if (encodedBytes > MAX_HTML_BYTES)
      throw new Error('课堂文件超过 100 MB，请关闭或缩短音乐，或拆分课件。');
    portableAssets[assetId] = {
      assetId,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      durationMs: asset.durationMs,
      sha256: asset.sha256,
      kind: asset.kind,
      name: asset.name,
      dataUrl: audioDataUrl(bytes, asset.mimeType),
    };
  }
  const payload: PortablePayload = {
    formatVersion: 1,
    runtimeVersion:
      lesson.gameId === 'word-beat' &&
      ((
        lesson.gameData as {
          music?: { playbackRate?: number; preservePitch?: boolean; sync?: { bpm: number } };
        }
      ).music?.playbackRate !== undefined ||
        (lesson.gameData as { music?: { preservePitch?: boolean } }).music?.preservePitch !==
          undefined ||
        ((lesson.gameData as { music?: { sync?: { bpm: number } } }).music?.sync &&
          (lesson.gameData as { music: { sync: { bpm: number } } }).music.sync.bpm !==
            (lesson.gameData as { bpm: { value: number } }).bpm.value))
        ? 3
        : lesson.gameId === 'word-beat' &&
            (lesson.gameData as { soundMode?: string }).soundMode === 'chorus'
          ? 2
          : 1,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    lesson: structuredClone(lesson),
    assets: portableAssets,
  };
  const script = runtimeBundle.script;
  const sourceArchive = await sourceBase64();
  const style = runtimeBundle.style;
  if (!script || /<\/script/iu.test(script) || /<\/style/iu.test(style))
    throw new Error('共享课堂运行资源不完整或含不安全结束标记。');
  const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src data: blob:; img-src data: blob:; font-src 'none'; connect-src 'none'; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(lesson.name)}</title><style>${style}</style></head><body><div id="root"><p role="status">正在检查课堂文件…</p></div><template id="ecg-attribution"><pre>${escapeHtml(CLASSROOM_ATTRIBUTION)}</pre></template><script id="ecg-source" type="application/octet-stream" data-sha256="${correspondingSource.sha256}">${sourceArchive}</script><script id="ecg-data" type="application/json">${serializeEmbeddedJson(payload)}</script><script>${script}</script></body></html>`;
  if (utf8.encode(html).byteLength > MAX_HTML_BYTES)
    throw new Error('课堂文件超过 100 MB，请关闭或缩短音乐，或拆分课件。');
  return html;
}

/** 默认按本地日期命名，非法文件名字符替换不改变内部课件标识。 */
export function suggestClassroomFileName(name: string, date = new Date()): string {
  const safeName =
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
      .replace(/[. ]+$/gu, '')
      .trim() || '英语课堂课件';
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return `${safeName}_${day}.html`;
}
