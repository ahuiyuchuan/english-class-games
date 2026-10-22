/**
 * Desktop IPC adapter. Browser previews never pretend a Windows operation succeeded.
 * Native errors retain stable codes and field locations so inputs can be corrected.
 * @author ahui
 */
import { invoke } from '@tauri-apps/api/core';
import type { AudioAsset, AudioRequest, LessonDocument, PackageIdentityPlan } from './types';

/** Captured once per renderer. Restore invalidates it; old page writes must fail. */
let dataEpochLoading: Promise<number> | undefined;

export interface NativeError {
  code: string;
  message: string;
  field?: string | null;
  retryable: boolean;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}
export interface SelectedFile {
  token: string;
  name: string;
  byteLength: number;
}
export interface MaterialFile {
  name: string;
  rawText?: string;
  sheets: { name: string; rows: string[][] }[];
  warnings: string[];
}
export interface TaskRecord {
  taskId: string;
  kind: string;
  lessonId?: string;
  inputRevision?: number;
  state:
    | 'queued'
    | 'running'
    | 'completed'
    | 'partialFailure'
    | 'failed'
    | 'cancelling'
    | 'cancelled'
    | 'interrupted';
  stage: string;
  completed: number;
  total: number;
  results: { requestId: string; objectId: string; asset: AudioAsset; cached: boolean }[];
  failures: { requestId: string; objectId: string; error: NativeError }[];
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  retryOf?: string;
}
export interface ExportResult {
  path: string;
  localCopy: string;
  sha256: string;
  byteLength: number;
  completed: boolean;
  /** Target failure is distinct from generation failure: localCopy remains verified. */
  error?: NativeError;
}
export type AppDataKey =
  'materials' | 'commonWords' | 'preferences' | 'importHistory' | 'exportHistory';

/** True only in the actual Tauri window, never based on a user-agent guess. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Reject with a uniform teacher-readable error; callers retain their current inputs. */
async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isDesktop()) {
    throw {
      code: 'NATIVE_UNAVAILABLE',
      message: '此操作需要 Windows 备课软件；浏览器预览可编辑和运行已带声音的课件。',
      retryable: false,
    } satisfies NativeError;
  }
  try {
    dataEpochLoading ??= invoke<number>('get_data_epoch').catch((error: unknown) => {
      // A transient startup IPC failure may be retried. DATA_REPLACED deliberately
      // keeps the old epoch: silently refreshing it could authorize stale edits.
      dataEpochLoading = undefined;
      throw error;
    });
    const dataEpoch = await dataEpochLoading;
    return await invoke<T>(command, { ...args, dataEpoch });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) throw error;
    throw { code: 'NATIVE_ERROR', message: String(error), retryable: true } satisfies NativeError;
  }
}

export const listLessons = () => call<LessonDocument[]>('list_lessons');
/** Optional revision obtains an immutable historical snapshot, including the prepared version. */
export const getLesson = <T = unknown>(lessonId: string, revision?: number) =>
  call<LessonDocument<T>>('get_lesson', { lessonId, revision: revision ?? null });
/** New documents use expectedRevision=0. A successful save returns the next revision. */
export const saveLesson = <T>(document: LessonDocument<T>, expectedRevision: number) =>
  call<LessonDocument<T>>('save_lesson', { document, expectedRevision });
/** Persist a local conflict copy and optional prepared snapshot in one transaction. */
export const saveLessonCopy = <T>(
  documents: LessonDocument<T>[],
  layouts: PackageIdentityPlan['revisions'],
) => call<LessonDocument<T>>('save_lesson_copy', { documents, layouts });
export const deleteLesson = (lessonId: string) => call<void>('delete_lesson', { lessonId });
/** Call only after the registered game module validates/compiles the current snapshot. */
export const markPrepared = <T = unknown>(
  lessonId: string,
  revision: number,
  requiredAssetIds: string[],
  allowHistorical = false,
) =>
  call<LessonDocument<T>>('mark_prepared', {
    lessonId,
    revision,
    requiredAssetIds,
    allowHistorical,
  });
export const getAppData = <T>(key: AppDataKey) => call<T | null>('get_app_data', { key });
export const setAppData = (key: AppDataKey, value: unknown) =>
  call<void>('set_app_data', { key, value });
export const listAssets = () => call<AudioAsset[]>('list_assets');
export const readAsset = (assetId: string) => call<AudioAsset>('read_asset', { assetId });
export const importAudio = (token: string, kind: 'recording' | 'music') =>
  call<AudioAsset>('import_audio', { token, kind });
export const listVoices = () => call<VoiceInfo[]>('list_voices');
export const synthesizeSpeech = (
  items: AudioRequest[],
  lessonId?: string,
  inputRevision?: number,
  retryOf?: string,
) =>
  call<TaskRecord>('synthesize_speech', {
    items,
    lessonId: lessonId ?? null,
    inputRevision: inputRevision ?? null,
    retryOf: retryOf ?? null,
  });
export const getTask = (taskId: string) => call<TaskRecord>('get_task', { taskId });
/**
 * Read the task-owned input snapshot only when opening its results. New tasks keep
 * it after source-lesson deletion; old records without a surviving input reject
 * with TASK_INPUT_UNAVAILABLE and do not fabricate content from the current draft.
 */
export const getTaskInput = (taskId: string) => call<LessonDocument>('get_task_input', { taskId });
export const listTasks = () => call<TaskRecord[]>('list_tasks');
export const cancelTask = (taskId: string) => call<TaskRecord>('cancel_task', { taskId });
/** Clear only a stopped task; saved lesson audio keeps its independent references. */
export const clearTask = (taskId: string) => call<void>('clear_task', { taskId });
export const selectFile = (kind: 'material' | 'audio' | 'music' | 'lessonPackage' | 'backup') =>
  call<SelectedFile | null>('select_file', { kind });

/** Container inspection never creates a resource; ambiguous tracks require explicit selection. */
export interface MusicInspection {
  video: boolean;
  tracks: { id: number; codec: string; language: string; default: boolean; supported: boolean }[];
  selectedTrack: number | null;
}
export const inspectMusic = (token: string) => call<MusicInspection>('inspect_music', { token });
/** Prepare remains temporary until commit; operationId supports cancellation across awaits. */
export const prepareMusic = (token: string, operationId: string, track: number | null) =>
  call<void>('prepare_music', { token, operationId, track });
export const cancelMusic = (operationId: string) => call<void>('cancel_music', { operationId });
export const commitMusic = (operationId: string) =>
  call<AudioAsset>('commit_music', { operationId });
export const readMaterial = (token: string, encoding: 'utf-8' | 'gb18030' = 'utf-8') =>
  call<MaterialFile>('read_material', { token, encoding });
export const inspectLessonPackage = (token: string) =>
  call<{ manifest: unknown; lesson: unknown; assets: AudioAsset[] }>('inspect_lesson_package', {
    token,
  });
export const importLessonPackage = (
  token: string,
  asCopy: boolean,
  identityPlan: PackageIdentityPlan,
) => call<LessonDocument>('import_lesson_package', { token, asCopy, identityPlan });
export const exportLessonPackage = (
  lessonId: string,
  draftRevision?: number,
  preparedRevision?: number | null,
  snapshotOwnerIds?: string[],
) =>
  call<ExportResult>('export_lesson_package', {
    lessonId,
    draftRevision: draftRevision ?? null,
    preparedRevision: preparedRevision ?? null,
    snapshotOwnerIds: snapshotOwnerIds ?? [],
  });
/** HTML must already contain the shared browser runtime, data and all enabled media. */
export const exportHtml = (
  html: string,
  suggestedName: string,
  lessonId: string,
  revision: number,
  requiredAssetIds: string[] = [],
  snapshotOwnerId?: string,
) =>
  call<ExportResult>('export_html', {
    html,
    suggestedName,
    lessonId,
    revision,
    requiredAssetIds,
    snapshotOwnerId: snapshotOwnerId ?? null,
  });
export const exportBackup = () => call<ExportResult>('export_backup');
export const restoreBackup = (token: string) => call<void>('restore_backup', { token });
export const cleanCache = () => call<number>('clean_cache');
export const openExport = (path: string, folder = false) =>
  call<void>('open_export', { path, folder });
/** Recopy the same verified managed artifact, without rereading any lesson version. */
export const recopyExport = (path: string, sha256: string, suggestedName: string) =>
  call<ExportResult>('recopy_export', { path, sha256, suggestedName });
export const getDataLocation = () => call<string>('get_data_location');
export interface ExportCopies {
  files: { path: string; name: string; byteLength: number }[];
  count: number;
  byteLength: number;
}
/** Enumerate managed local copies before asking the teacher which ones to remove. */
export const listExportCopies = () => call<ExportCopies>('list_export_copies');
/** Only paths returned by listExportCopies are accepted; exported external files stay. */
export const clearExportCopies = (paths: string[]) =>
  call<{ count: number; byteLength: number }>('clear_export_copies', { paths });
/**
 * Retain unsaved/undo/runtime assets; replacing one owner's set is atomic.
 * Supplying a lesson and revision also retains every asset declared by that fixed
 * snapshot, even when assetIds is empty or the source lesson is later deleted.
 */
export const retainAssets = (
  ownerId: string,
  assetIds: string[],
  lessonId?: string,
  revision?: number,
) =>
  call<void>('retain_assets', {
    ownerId,
    assetIds,
    lessonId: lessonId ?? null,
    revision: revision ?? null,
  });
/** Release one closed session without affecting lesson, task or resource ownership. */
export const releaseAssets = (ownerId: string) => call<void>('release_assets', { ownerId });
/** Confirm its usage first; this only removes the library's independent reference. */
export const deleteResource = (assetId: string) => call<void>('delete_resource', { assetId });
export const resourceUsage = (assetId: string) =>
  call<{ inLibrary: boolean; lessons: { id: string; name: string }[] }>('resource_usage', {
    assetId,
  });
