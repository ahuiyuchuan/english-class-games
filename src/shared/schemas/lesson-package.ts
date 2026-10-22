/**
 * 可编辑课件包的跨端协议与结构检查。此处不解压、不读取任意路径；
 * 原生服务必须另行核验实际 ZIP 路径、文件字节、哈希和解压限额。
 * @author ahui
 */
import type { AudioAsset, LessonDocument, ValidationIssue } from '../../platform/types';
import packageInformation from '../../../package.json';

/** V1 素材清单采用包内相对路径，元信息不能代替实际文件校验。 */
export interface PackageAsset {
  assetId: string;
  path: string;
  mimeType: string;
  byteLength: number;
  durationMs: number;
  sha256: string;
  /** 旧包可省略；新包保留用途，避免音乐被当作可清理的配音缓存。 */
  kind?: 'speech' | 'recording' | 'music';
}

/** 包级版本和最低运行环境；教学版本和声音模式分别保存在每份修订里。 */
export interface LessonPackageManifest {
  formatVersion: 1;
  gameId: string;
  minimumPlatformVersion: string;
  runtimeVersion: number;
  sourceLessonId: string;
  generatedAt: string;
  lessonSha256: string;
  assets: PackageAsset[];
}

/** 草稿与最近已准备版本各保留完整副本，同一修订只存一次。 */
export interface LessonPackageData {
  lessonId: string;
  name: string;
  gameId: string;
  draftRevision: number;
  preparedRevision: number | null;
  revisions: LessonDocument[];
}

/** 稳定错误包含可定位对象，不将不兼容版本包装为随机 JSON 错误。 */
export class PackageValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly location?: string,
  ) {
    super(message);
    this.name = 'PackageValidationError';
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function fail(message: string, location?: string): never {
  throw new PackageValidationError('VALIDATION_ERROR', message, location);
}

/**
 * 包路径检查也在预览端执行；Windows 原生层仍需使用最终绝对路径做根目录约束。
 * @param path ZIP 中使用正斜杠的相对文件路径。
 * @returns 大小写折叠的唯一性键，不能据此改写真实文件名。
 * @throws PackageValidationError 路径越界、设备名、数据流或非规范路径。
 */
export function validatePackagePath(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /[<>:"|?*\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail('包内路径必须是规范相对路径。', path);
  }
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  ) {
    fail('包内路径含越界、保留设备名或不安全分量。', path);
  }
  return path.toLowerCase();
}

/**
 * 检查清单形状及上限；此检查只接受已读取的受限 JSON，不执行包内内容。
 * @param value 来自原生 ZIP 检查入口的 manifest.json 值。
 * @returns 类型收窄后的清单。
 * @throws PackageValidationError 格式不支持、清单不完整、重复路径或素材元信息非法。
 */
export function validatePackageManifest(value: unknown): LessonPackageManifest {
  if (!record(value)) fail('课件包清单必须是对象。');
  if (value.formatVersion !== 1)
    throw new PackageValidationError('UNSUPPORTED_VERSION', '当前软件不支持此课件包格式。');
  if (
    !text(value.gameId) ||
    !text(value.sourceLessonId) ||
    !text(value.minimumPlatformVersion) ||
    !integer(value.runtimeVersion)
  )
    fail('课件包缺少版本或来源标识。');
  const minimum = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value.minimumPlatformVersion));
  if (!minimum) fail('最低平台版本必须是明确的主、次、修订版本。');
  const current = packageInformation.version.split('.').map(Number);
  const required = minimum.slice(1).map(Number);
  const firstDifference = required.findIndex((part, index) => part !== current[index]);
  if (
    ![1, 2, 3].includes(value.runtimeVersion) ||
    (firstDifference >= 0 && required[firstDifference] > current[firstDifference])
  )
    throw new PackageValidationError(
      'UNSUPPORTED_VERSION',
      '课件包要求更新的平台或课堂运行核心，请更新软件后导入。',
    );
  if (
    !text(value.generatedAt) ||
    Number.isNaN(Date.parse(value.generatedAt)) ||
    !hash(value.lessonSha256)
  )
    fail('课件包日期或正文校验值不合法。');
  if (!Array.isArray(value.assets) || value.assets.length > 1_997)
    fail('素材清单数量超出允许范围。');
  const paths = new Map<string, Record<string, unknown>>();
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const [index, asset] of value.assets.entries()) {
    if (!record(asset) || !text(asset.assetId) || !text(asset.path) || !hash(asset.sha256))
      fail('素材清单缺少身份或校验值。', `assets.${index}`);
    const normalizedPath = validatePackagePath(asset.path);
    if (!/^assets\/[a-z0-9_-]+(?:\.(?:wav|mp3))?$/u.test(normalizedPath))
      fail('素材必须位于 assets 下且使用受限文件名。', asset.path);
    const previous = paths.get(normalizedPath);
    if (
      ids.has(asset.assetId) ||
      (previous &&
        ['path', 'sha256', 'mimeType', 'byteLength', 'durationMs'].some(
          (field) => previous[field] !== asset[field],
        ))
    )
      fail('素材路径或身份重复且不一致。', asset.path);
    paths.set(normalizedPath, asset);
    ids.add(asset.assetId);
    if (!['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(String(asset.mimeType)))
      fail('素材类型不受支持。', asset.path);
    if (asset.kind !== undefined && !['speech', 'recording', 'music'].includes(String(asset.kind)))
      fail('素材用途不受支持。', asset.path);
    if (
      !integer(asset.byteLength) ||
      typeof asset.durationMs !== 'number' ||
      !Number.isFinite(asset.durationMs) ||
      asset.durationMs <= 0
    )
      fail('素材大小或时长不合法。', asset.path);
    if (!previous) totalBytes += Number(asset.byteLength);
    if (totalBytes > 500_000_000) fail('素材解压总量超出 500 MB。');
  }
  return value as unknown as LessonPackageManifest;
}

/**
 * 双修订结构检查独立于可上课校验，允许保留尚未完成的教学草稿。
 * @param value 受限读取后的 lesson.json。
 * @param manifest 可选已验证清单；提供时同时检查所有快照的素材引用。
 * @param validateRevision 已注册游戏提供的结构 / 版本校验，必须覆盖每一份快照。
 * @returns 保留原始草稿输入、来源和两版独立配置的包数据。
 * @throws PackageValidationError 通用结构、游戏结构 / 版本或素材引用不完整。
 */
export function validatePackageData(
  value: unknown,
  manifest?: LessonPackageManifest,
  validateRevision?: (value: unknown) => ValidationIssue[],
): LessonPackageData {
  if (
    !record(value) ||
    !text(value.lessonId) ||
    !text(value.name) ||
    !text(value.gameId) ||
    !integer(value.draftRevision)
  )
    fail('课件正文缺少必要信息。');
  if (value.preparedRevision !== null && !integer(value.preparedRevision))
    fail('已准备版本指针不合法。');
  if (!Array.isArray(value.revisions) || value.revisions.length < 1 || value.revisions.length > 2)
    fail('课件包应包含 1～2 份修订。');
  const revisions = new Set<number>();
  for (const [index, revision] of value.revisions.entries()) {
    if (
      !record(revision) ||
      revision.id !== value.lessonId ||
      revision.gameId !== value.gameId ||
      !integer(revision.revision) ||
      !integer(revision.dataVersion) ||
      !text(revision.name) ||
      !text(revision.createdAt) ||
      !text(revision.updatedAt) ||
      Number.isNaN(Date.parse(revision.createdAt as string)) ||
      Number.isNaN(Date.parse(revision.updatedAt as string)) ||
      !Object.hasOwn(revision, 'gameData') ||
      revision.gameData === undefined
    )
      fail('修订结构或所属课件不一致。', `revisions.${index}`);
    if (revisions.has(revision.revision)) fail('课件包包含重复修订。', `revisions.${index}`);
    if (revision.draftInputs !== undefined) {
      if (!record(revision.draftInputs))
        fail('未完成输入必须为按字段定位的对象。', `revisions.${index}.draftInputs`);
      for (const [field, input] of Object.entries(revision.draftInputs)) {
        if (
          !field ||
          !record(input) ||
          typeof input.raw !== 'string' ||
          typeof input.message !== 'string' ||
          (input.objectId !== undefined && !text(input.objectId))
        )
          fail(
            '未完成输入须保留原始文本、错误和可选对象位置。',
            `revisions.${index}.draftInputs.${field}`,
          );
      }
    }
    if (
      revision.sourceLesson !== undefined &&
      (!record(revision.sourceLesson) ||
        !text(revision.sourceLesson.id) ||
        !integer(revision.sourceLesson.revision))
    )
      fail('来源课件身份或修订不完整。', `revisions.${index}.sourceLesson`);
    if (
      revision.preparedRevision !== undefined &&
      revision.preparedRevision !== null &&
      (!integer(revision.preparedRevision) || revision.preparedRevision > revision.revision)
    )
      fail('快照中的已准备指针不合法。', `revisions.${index}.preparedRevision`);
    const structuralError = validateRevision?.(revision).find(
      (issue) => issue.severity === 'error',
    );
    if (structuralError)
      throw new PackageValidationError(
        structuralError.code,
        structuralError.message,
        `revisions.${index}${structuralError.field ? `.${structuralError.field}` : ''}`,
      );
    if (manifest) {
      const available = new Set(manifest.assets.map((asset) => asset.assetId));
      // 包内未启用或已失效的声音也属于实际引用，不能只检查当前运行所需集合。
      const pending: unknown[] = [revision.gameData];
      const visited = new Set<object>();
      while (pending.length) {
        const item = pending.pop();
        if (typeof item !== 'object' || item === null || visited.has(item)) continue;
        visited.add(item);
        if (
          record(item) &&
          Object.hasOwn(item, 'assetId') &&
          (typeof item.assetId !== 'string' || !available.has(item.assetId))
        )
          fail('快照引用了清单中没有的素材。', `revisions.${index}.gameData`);
        for (const child of Object.values(item)) pending.push(child);
      }
    }
    revisions.add(revision.revision);
  }
  const draftRevision = Number(value.draftRevision);
  if (
    !revisions.has(draftRevision) ||
    (value.preparedRevision !== null &&
      (!revisions.has(Number(value.preparedRevision)) ||
        Number(value.preparedRevision) > draftRevision))
  )
    fail('草稿或已准备版本未对应完整修订。');
  if (
    revisions.size !==
    (value.preparedRevision !== null && value.preparedRevision !== draftRevision ? 2 : 1)
  )
    fail('课件包包含与指针无关的修订。');
  if (manifest && (manifest.sourceLessonId !== value.lessonId || manifest.gameId !== value.gameId))
    fail('清单与正文所属课件不一致。');
  return value as unknown as LessonPackageData;
}

/** 为原生打包创建双快照，prepared 缺失时保留 null，不能伪造可上课版本。 */
export function createPackageData(
  draft: LessonDocument,
  prepared?: LessonDocument | null,
): LessonPackageData {
  if (prepared && (prepared.id !== draft.id || prepared.gameId !== draft.gameId))
    fail('草稿与已准备版本所属课件不一致。');
  const revisions = prepared && prepared.revision !== draft.revision ? [draft, prepared] : [draft];
  return validatePackageData({
    lessonId: draft.id,
    name: draft.name,
    gameId: draft.gameId,
    draftRevision: draft.revision,
    preparedRevision: prepared?.revision ?? null,
    revisions: structuredClone(revisions),
  });
}

/** 映射已核验的素材元信息；实际文件内容由原生服务读取并重算哈希。 */
export function packageAsset(asset: AudioAsset): PackageAsset {
  return {
    assetId: asset.assetId,
    path: `assets/${asset.sha256}`,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    durationMs: asset.durationMs,
    sha256: asset.sha256,
    ...(asset.kind ? { kind: asset.kind } : {}),
  };
}
