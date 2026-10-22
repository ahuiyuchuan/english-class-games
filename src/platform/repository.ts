/**
 * 持久化环境适配。正式桌面通过受限 IPC 访问 SQLite；浏览器开发预览使用独立
 * IndexedDB 数据库，不提供或假冒 Windows 配音、备份和系统文件能力。
 * @author ahui
 */
import { isTauri } from '@tauri-apps/api/core';
import * as native from './native';
import { getGame, getGames } from './games';
import type { AudioAsset, LessonDocument, TeachingEntry } from './types';
import { decodeAudioDataUrl } from '../portable/media';
import { remapLocalSnapshots } from './snapshot-copy';

/** 原始教学材料与确认条目同时保留，后续修改不级联改变已生成课件。 */
export interface MaterialCollection {
  id: string;
  name: string;
  original: string;
  entries: TeachingEntry[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * 各游戏独立保存的新课默认值。平台不假定默认值包含节拍、词表或声音字段；
 * 对应游戏模块负责校验其对象，创建课件时再复制，不建立对已有课件的实时联动。
 */
export interface TeacherPreferences {
  gameDefaults: Record<string, unknown>;
}

export const desktopAvailable = isTauri();
const PREVIEW_DATABASE = 'english-class-games-development-preview';
let databasePromise: Promise<IDBDatabase> | undefined;

/** 开发预览数据库与桌面资料隔离，结构升级失败时保留已有数据。 */
function browserDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(PREVIEW_DATABASE, 1);
    request.onupgradeneeded = () => {
      for (const name of ['lessons', 'revisions', 'metadata', 'assets']) {
        request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('预览数据无法打开，请检查浏览器存储权限。'));
  });
  return databasePromise;
}

/** 请求完成不等于事务落盘成功；只在 transaction.complete 后报告保存完成。 */
async function browserRead<T>(storeName: string, key?: string): Promise<T> {
  const database = await browserDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = key === undefined ? store.getAll() : store.get(key);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(request.result as T);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function browserWrite(storeName: string, key: string, value: unknown): Promise<void> {
  const database = await browserDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(structuredClone(value), key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('保存已中止。'));
  });
}

/** 返回完整课件而非列表摘要，游戏模块自行解释其 gameData。 */
export async function listLessons(): Promise<LessonDocument[]> {
  const documents = desktopAvailable
    ? await native.listLessons()
    : await browserRead<LessonDocument[]>('lessons');
  return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 取得固定修订供教师明确选择旧准备版；不存在时拒绝，不回退到当前草稿。 */
export async function getLesson<T = unknown>(
  lessonId: string,
  revision?: number,
): Promise<LessonDocument<T>> {
  if (desktopAvailable) return native.getLesson<T>(lessonId, revision);
  const document =
    revision === undefined
      ? await browserRead<LessonDocument<T> | undefined>('lessons', lessonId)
      : await browserRead<LessonDocument<T> | undefined>('revisions', `${lessonId}:${revision}`);
  if (!document) throw new Error('所选课件修订已不存在，请使用当前内容重新检查。');
  return document;
}

/** 草稿保存带乐观并发检查；浏览器适配也不允许旧请求覆盖新修订。 */
export async function saveLesson<T>(
  document: LessonDocument<T>,
  expectedRevision: number,
): Promise<LessonDocument<T>> {
  if (desktopAvailable) return native.saveLesson(document, expectedRevision);
  const database = await browserDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['lessons', 'revisions'], 'readwrite');
    const store = transaction.objectStore('lessons');
    const request = store.get(document.id);
    let saved: LessonDocument<T>;
    let failure = '';
    request.onsuccess = () => {
      const existing = request.result as LessonDocument<T> | undefined;
      if ((existing?.revision ?? 0) !== expectedRevision) {
        failure = '课件已有更新，请保留当前输入并重新打开比较。';
        transaction.abort();
        return;
      }
      if (existing && existing.gameId !== document.gameId) {
        failure = '已有课件不能切换为另一个游戏；请新建课件。';
        transaction.abort();
        return;
      }
      saved = {
        ...structuredClone(document),
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      // 准备指针由准备事务拥有，不能信任客户端快照。准备不推进草稿修订，
      // 因而另一页面仍可用相同CAS修订保存；它携带的旧指针不得覆盖最新准备结果。
      delete saved.preparedRevision;
      if (existing?.preparedRevision != null) saved.preparedRevision = existing.preparedRevision;
      store.put(saved, saved.id);
      transaction.objectStore('revisions').put(saved, `${saved.id}:${saved.revision}`);
    };
    transaction.oncomplete = () => resolve(saved!);
    transaction.onabort = () =>
      reject(
        Object.assign(new Error(failure || '课件保存中止，当前输入已保留。'), {
          code: failure.startsWith('课件已有更新') ? 'REVISION_CONFLICT' : 'VALIDATION_ERROR',
        }),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * 另存教师当前本地草稿，绝不读取已保存头来替代未落盘输入。准备版仅按明确修订读取；
 * 两版在一个事务内保存、共用身份映射，教学错误与手动值保留，失败不影响源课件。
 * @param document 编辑会话中的完整本地草稿，包含未完成输入与准备版指针。
 * @param name 教师确认的副本名，去首尾空白后为1～80字符。
 * @returns 新身份课件的草稿，准备版存在时仍可通过明确选版使用。
 */
export async function saveLocalLessonCopy<T>(
  document: LessonDocument<T>,
  name: string,
): Promise<LessonDocument<T>> {
  const source = structuredClone(document);
  const copyName = name.trim();
  if (!copyName || [...copyName].length > 80) throw new Error('副本名称需为1～80字符。');
  const game = getGame(source.gameId);
  if (!game) throw new Error('当前软件不含此游戏，无法另存课件。');
  const prepared =
    source.preparedRevision == null
      ? undefined
      : await getLesson<T>(source.id, source.preparedRevision);
  const timestamp = new Date().toISOString();
  const documents = [
    ...(prepared ? [{ ...prepared, revision: 1 }] : []),
    { ...source, revision: prepared ? 2 : 1 },
  ].map((snapshot, index) => ({
    ...snapshot,
    name: index === (prepared ? 1 : 0) ? copyName : snapshot.name,
    preparedRevision: prepared ? 1 : null,
    sourceLesson: {
      id: source.id,
      revision: index === 0 && prepared ? prepared.revision : source.revision,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  for (const snapshot of documents) {
    const errors = game.validateStructure(snapshot).filter((issue) => issue.severity === 'error');
    if (errors.length) throw new Error(errors[0].message);
  }
  const layouts = documents.map((snapshot) => ({
    revision: snapshot.revision,
    layout: game.describeIdentities(snapshot),
  }));
  if (desktopAvailable) return native.saveLessonCopy(documents, layouts);
  const copies = remapLocalSnapshots(documents, layouts);
  const draft = copies[copies.length - 1];
  const database = await browserDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['lessons', 'revisions'], 'readwrite');
    transaction.objectStore('lessons').add(draft, draft.id);
    for (const snapshot of copies)
      transaction.objectStore('revisions').add(snapshot, `${draft.id}:${snapshot.revision}`);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('另存失败，本地输入已保留。'));
    transaction.onerror = () => reject(transaction.error);
  });
  return draft;
}

/** 最近准备版指针只在当前版本一致时推进，调用前须通过游戏完整检查。 */
export async function markPrepared<T>(
  document: LessonDocument<T>,
  requiredAssetIds: string[] = [],
  allowHistorical = false,
): Promise<LessonDocument<T>> {
  if (desktopAvailable) {
    return native.markPrepared<T>(
      document.id,
      document.revision,
      requiredAssetIds,
      allowHistorical,
    );
  }
  const database = await browserDatabase();
  return new Promise((resolve, reject) => {
    // 同一事务内读取现有草稿和固定修订，只推进指针，不写回过时的草稿内容。
    const transaction = database.transaction(['lessons', 'revisions'], 'readwrite');
    const currentRequest = transaction.objectStore('lessons').get(document.id);
    const snapshotRequest = transaction
      .objectStore('revisions')
      .get(`${document.id}:${document.revision}`);
    let failure = '';
    snapshotRequest.onsuccess = () => {
      const current = currentRequest.result as LessonDocument<T> | undefined;
      const snapshot = snapshotRequest.result as LessonDocument<T> | undefined;
      if (
        !current ||
        !snapshot ||
        (current.revision !== document.revision &&
          (!allowHistorical || current.preparedRevision !== document.revision))
      ) {
        failure = '准备期间课件发生变化或所选修订不存在，请重新检查。';
        transaction.abort();
        return;
      }
      transaction
        .objectStore('lessons')
        .put({ ...current, preparedRevision: snapshot.revision }, current.id);
    };
    transaction.oncomplete = () => resolve({ ...document, preparedRevision: document.revision });
    transaction.onabort = () =>
      reject(
        Object.assign(new Error(failure || '准备状态未保存，请重试。'), {
          code: failure ? 'REVISION_CONFLICT' : 'DATABASE_ERROR',
        }),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}

/** 删除课件不删除共享声音；缓存清理由本地引用检查服务负责。 */
export async function deleteLesson(lessonId: string): Promise<void> {
  if (desktopAvailable) return native.deleteLesson(lessonId);
  const database = await browserDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('lessons', 'readwrite');
    transaction.objectStore('lessons').delete(lessonId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** 通用资料只允许应用声明的键，教师内容作为 JSON 数据处理。 */
export async function readAppData<T>(key: native.AppDataKey, fallback: T): Promise<T> {
  const value = desktopAvailable
    ? await native.getAppData<T>(key)
    : await browserRead<T | undefined>('metadata', key);
  return value ?? fallback;
}

export async function writeAppData(key: native.AppDataKey, value: unknown): Promise<void> {
  if (desktopAvailable) return native.setAppData(key, value);
  return browserWrite('metadata', key, value);
}

/** JSON 对象检查不接受数组和 null，避免把损坏的偏好误当作空默认值覆盖原件。 */
function isPreferenceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 验证偏好容器，并由已注册模块解释自己的字段。尚未安装的游戏对象原样保留，
 * 以后安装对应版本时再校验；平台不把它转换为单词节拍配置。
 */
function normalizeTeacherPreferences(value: unknown): TeacherPreferences {
  if (!isPreferenceRecord(value) || !isPreferenceRecord(value.gameDefaults))
    throw new Error('制作默认数据格式不受支持，原数据已保留。');
  return {
    gameDefaults: Object.fromEntries(
      Object.entries(value.gameDefaults).map(([gameId, defaults]) => {
        const game = getGame(gameId);
        return [gameId, structuredClone(game ? game.validatePreferences(defaults) : defaults)];
      }),
    ),
  };
}

/**
 * 读取按游戏隔离的新课默认值；兼容旧开发资料时，仅允许模块认领自身的历史字段。
 * 迁移只发生在内存，教师主动保存前不改写原存储，失败也不清空已有偏好。
 * @returns 独立的偏好副本；从未保存过时返回空游戏映射，各模块按自身规则取默认值。
 * @throws Error 数据损坏或对应模块拒绝字段/取值时，保留原存储并报告可读原因。
 */
export async function readTeacherPreferences(): Promise<TeacherPreferences> {
  const stored = await readAppData<unknown>('preferences', null);
  if (stored == null) return { gameDefaults: {} };
  if (!isPreferenceRecord(stored)) throw new Error('制作默认数据格式不受支持，原数据已保留。');
  if ('gameDefaults' in stored) return normalizeTeacherPreferences(stored);
  if (!Object.keys(stored).length) return { gameDefaults: {} };
  const migrated = getGames().flatMap((game) => {
    const defaults = game.migrateLegacyPreferences?.(stored);
    return defaults === undefined ? [] : [[game.id, structuredClone(defaults)] as const];
  });
  if (!migrated.length) throw new Error('旧制作默认无法由当前游戏识别，原数据已保留。');
  return { gameDefaults: Object.fromEntries(migrated) };
}

/**
 * 取得某一游戏的已校验独立副本；缺省值只由该游戏提供。
 * @param preferences 当前偏好容器，不修改调用方对象。
 * @param gameId 已注册游戏的稳定标识；未知游戏不能借用其他游戏默认值。
 * @returns 已由模块补齐并校验的创建参数，可复制进新课件。
 * @throws Error 游戏不存在或保存的游戏默认值不合法。
 */
export function getGamePreferences(
  preferences: TeacherPreferences,
  gameId: string,
): Record<string, unknown> {
  const game = getGame(gameId);
  if (!game) throw new Error('当前软件不含此游戏，无法读取其制作默认。');
  const value = Object.prototype.hasOwnProperty.call(preferences.gameDefaults, gameId)
    ? preferences.gameDefaults[gameId]
    : game.getDefaultPreferences();
  return structuredClone(game.validatePreferences(value));
}

/**
 * 构造只更新指定游戏的偏好副本，保留其他游戏对象，不写入存储或修改已有课件。
 * @param preferences 当前完整偏好，未涉及的游戏值保持原样。
 * @param gameId 已注册游戏的稳定标识。
 * @param value 教师主动提交的该游戏默认值，由模块校验后才接受。
 * @returns 可交给 saveTeacherPreferences 的新容器。
 * @throws Error 游戏不存在或模块拒绝默认值；原对象保持不变。
 */
export function withGamePreferences(
  preferences: TeacherPreferences,
  gameId: string,
  value: unknown,
): TeacherPreferences {
  const game = getGame(gameId);
  if (!game) throw new Error('当前软件不含此游戏，无法保存其制作默认。');
  const defaults = game.validatePreferences(value);
  return {
    gameDefaults: {
      ...structuredClone(preferences.gameDefaults),
      [gameId]: structuredClone(defaults),
    },
  };
}

/** 主动提交完整偏好；全部已知游戏先校验再写入，任何一项失败均不覆盖旧值。 */
export async function saveTeacherPreferences(preferences: TeacherPreferences): Promise<void> {
  const validated = normalizeTeacherPreferences(preferences);
  await writeAppData('preferences', validated);
}

/**
 * 运行器只取得实际音频字节；桌面从受管素材库读取，浏览器开发预览仅接受
 * 类型匹配的内嵌 base64 音频。用户数据不得被解释为远程 URL 或文件路径。
 */
export async function readAssetData(asset: AudioAsset): Promise<ArrayBuffer> {
  if (desktopAvailable) {
    const data = await native.readAsset(asset.assetId);
    if (!data.dataUrl) throw new Error(`声音文件不可用：${asset.name ?? asset.assetId}`);
    return decodeAssetData(data.dataUrl, asset);
  }
  if (!asset.dataUrl) throw new Error(`声音文件不可用：${asset.name ?? asset.assetId}`);
  return decodeAssetData(asset.dataUrl, asset);
}

/** 只将精确匹配的音频 data URL 解码为内存字节，不发出任何网络请求。 */
function decodeAssetData(dataUrl: string, expected: AudioAsset): ArrayBuffer {
  if (!dataUrl.startsWith(`data:${expected.mimeType};base64,`))
    throw new Error(`声音“${expected.name ?? expected.assetId}”的媒体类型不匹配。`);
  const bytes = decodeAudioDataUrl(dataUrl);
  if (bytes.byteLength !== expected.byteLength)
    throw new Error(`声音“${expected.name ?? expected.assetId}”的文件大小不匹配。`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function listAssets(): Promise<AudioAsset[]> {
  return desktopAvailable ? native.listAssets() : browserRead<AudioAsset[]>('assets');
}
