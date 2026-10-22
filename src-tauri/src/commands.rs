//! IPC boundary: expensive I/O stays on blocking workers and errors remain structured.
//! File commands accept only dialog tokens; game modules validate their own business data.
//! Author: ahui.
use crate::{
    assets,
    database::{self, AppState},
    error::{AppError, AppResult},
    files,
    identities::PackageIdentityPlan,
    model::{AudioAsset, ExportResult, SelectedFile, SpeechItem, TaskRecord, VoiceInfo},
    packages, speech,
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

type NativeState<'a> = State<'a, Arc<AppState>>;

/// Inspect without storing; only a dialog token grants local file access.
#[tauri::command]
pub async fn inspect_music(
    state: NativeState<'_>,
    token: String,
) -> AppResult<crate::music_import::MusicInspection> {
    let state = state.inner().clone();
    blocking(move || crate::music_import::inspect(&files::selected_path(&state, &token)?)).await
}

/// Register before await, then perform bounded decoding outside the UI thread.
#[tauri::command]
pub async fn prepare_music(
    state: NativeState<'_>,
    token: String,
    operation_id: String,
    track: Option<u32>,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    state.check_data_epoch(data_epoch)?;
    let path = files::selected_path(&state, &token)?;
    let name = format!(
        "{} · 背景音乐",
        path.file_stem().unwrap_or_default().to_string_lossy()
    );
    let cancel = crate::music_import::begin(&state, &operation_id, name)?;
    let state = state.inner().clone();
    let cleanup_id = operation_id.clone();
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_started = started.clone();
    let result = writing(state.clone(), data_epoch, move |state| {
        worker_started.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::music_import::prepare(state, &operation_id, &path, track, cancel)
    })
    .await;
    // A restore barrier can reject before the worker starts; release its reservation too.
    if result.is_err() && !started.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = crate::music_import::cancel_import(&state, &cleanup_id);
        state
            .music_import
            .1
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
    result
}

#[tauri::command]
pub async fn cancel_music(state: NativeState<'_>, operation_id: String) -> AppResult<()> {
    let state = state.inner().clone();
    blocking(move || crate::music_import::cancel_import(&state, &operation_id)).await
}

/// Short publication is protected by the same data-epoch/restore barrier as audio imports.
#[tauri::command]
pub async fn commit_music(
    state: NativeState<'_>,
    operation_id: String,
    data_epoch: Option<u64>,
) -> AppResult<AudioAsset> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        crate::music_import::commit(state, &operation_id)
    })
    .await
}

/// The full immutable input is read only when opening task results, keeping normal
/// task refreshes small even when the source teaching material is substantial.
#[tauri::command]
pub async fn get_task_input(state: NativeState<'_>, task_id: String) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || database::get_task_input(&state, &task_id)).await
}

/// Admitting a write increments the restore barrier before checking its data_epoch.
/// Restore waits for that guard, so validation and the eventual commit cannot straddle
/// a database replacement even when a background operation waits for another lock.
async fn writing<T: Send + 'static>(
    state: Arc<AppState>,
    data_epoch: Option<u64>,
    operation: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    blocking(move || {
        let _operation = database::WriteOperation::begin(&state)?;
        state.check_data_epoch(data_epoch)?;
        operation(&state)
    })
    .await
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| AppError::new("INTERNAL_ERROR", "后台操作异常，请重试"))?
}

#[tauri::command]
pub async fn list_lessons(state: NativeState<'_>) -> AppResult<Vec<Value>> {
    let state = state.inner().clone();
    blocking(move || database::list_lessons(&state)).await
}
#[tauri::command]
pub async fn get_lesson(
    state: NativeState<'_>,
    lesson_id: String,
    revision: Option<u64>,
) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || database::get_lesson(&state, &lesson_id, revision)).await
}
#[tauri::command]
pub async fn save_lesson(
    state: NativeState<'_>,
    document: Value,
    expected_revision: u64,
    data_epoch: Option<u64>,
) -> AppResult<Value> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::save_lesson(state, document, expected_revision)
    })
    .await
}
/// Persist an independent local conflict copy; data-epoch admission still applies.
#[tauri::command]
pub async fn save_lesson_copy(
    state: NativeState<'_>,
    documents: Vec<Value>,
    layouts: Vec<crate::identities::RevisionIdentityPlan>,
    data_epoch: Option<u64>,
) -> AppResult<Value> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::save_lesson_copy(state, documents, layouts)
    })
    .await
}
#[tauri::command]
pub async fn delete_lesson(
    state: NativeState<'_>,
    lesson_id: String,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::delete_lesson(state, &lesson_id)
    })
    .await
}
#[tauri::command]
pub async fn mark_prepared(
    state: NativeState<'_>,
    lesson_id: String,
    revision: u64,
    required_asset_ids: Vec<String>,
    allow_historical: Option<bool>,
    data_epoch: Option<u64>,
) -> AppResult<Value> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::mark_prepared(
            state,
            &lesson_id,
            revision,
            &required_asset_ids,
            allow_historical.unwrap_or(false),
        )
    })
    .await
}
#[tauri::command]
pub async fn get_app_data(state: NativeState<'_>, key: String) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || database::get_app_data(&state, &key)).await
}
#[tauri::command]
pub async fn set_app_data(
    state: NativeState<'_>,
    key: String,
    value: Value,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::set_app_data(state, &key, value)
    })
    .await
}
#[tauri::command]
pub async fn list_assets(state: NativeState<'_>) -> AppResult<Vec<AudioAsset>> {
    let state = state.inner().clone();
    blocking(move || assets::list_assets(&state)).await
}
#[tauri::command]
pub async fn read_asset(state: NativeState<'_>, asset_id: String) -> AppResult<AudioAsset> {
    let state = state.inner().clone();
    blocking(move || assets::read_asset(&state, &asset_id)).await
}
#[tauri::command]
pub async fn import_audio(
    state: NativeState<'_>,
    token: String,
    kind: String,
    data_epoch: Option<u64>,
) -> AppResult<AudioAsset> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        let (max_bytes, max_ms) = match kind.as_str() {
            "recording" => (20_000_000, 30_000.0),
            "music" => (50_000_000, 600_000.0),
            _ => return Err(AppError::validation("未知音频用途")),
        };
        let path = files::selected_path(state, &token)?;
        let bytes = assets::read_limited(&path, max_bytes)?;
        let asset = assets::store_audio(
            state,
            &bytes,
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            None,
            max_bytes as usize,
            max_ms,
            None,
        )?;
        assets::read_asset(state, &asset.asset_id)
    })
    .await
}
#[tauri::command]
pub async fn list_voices() -> AppResult<Vec<VoiceInfo>> {
    blocking(speech::list_voices).await
}
#[tauri::command]
pub async fn synthesize_speech(
    state: NativeState<'_>,
    items: Vec<SpeechItem>,
    lesson_id: Option<String>,
    input_revision: Option<u64>,
    retry_of: Option<String>,
    data_epoch: Option<u64>,
) -> AppResult<TaskRecord> {
    let _operation = database::WriteOperation::begin(state.inner())?;
    state.check_data_epoch(data_epoch)?;
    speech::start_task(
        state.inner().clone(),
        items,
        lesson_id,
        input_revision,
        retry_of,
    )
}
/// Only terminal task records may be cleared; saved lesson references remain intact.
#[tauri::command]
pub async fn clear_task(
    state: NativeState<'_>,
    task_id: String,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::clear_task(state, &task_id)
    })
    .await
}
#[tauri::command]
pub async fn get_task(state: NativeState<'_>, task_id: String) -> AppResult<TaskRecord> {
    let state = state.inner().clone();
    blocking(move || database::get_task(&state, &task_id)).await
}
#[tauri::command]
pub async fn list_tasks(state: NativeState<'_>) -> AppResult<Vec<TaskRecord>> {
    let state = state.inner().clone();
    blocking(move || {
        let ids = {
            let db = state.connection()?;
            let mut query =
                db.prepare("SELECT id FROM tasks ORDER BY updated_at DESC LIMIT 100")?;
            let ids = query
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        ids.iter()
            .map(|id| database::get_task(&state, id))
            .collect()
    })
    .await
}
#[tauri::command]
pub async fn cancel_task(
    state: NativeState<'_>,
    task_id: String,
    data_epoch: Option<u64>,
) -> AppResult<TaskRecord> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        speech::cancel_task(state, &task_id)
    })
    .await
}
#[tauri::command]
pub async fn select_file(state: NativeState<'_>, kind: String) -> AppResult<Option<SelectedFile>> {
    let state = state.inner().clone();
    blocking(move || files::select_file(&state, &kind)).await
}
#[tauri::command]
pub async fn read_material(
    state: NativeState<'_>,
    token: String,
    encoding: String,
) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || files::read_material(&state, &token, &encoding)).await
}
#[tauri::command]
pub async fn inspect_lesson_package(state: NativeState<'_>, token: String) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || packages::inspect_package(&state, &token)).await
}
#[tauri::command]
pub async fn import_lesson_package(
    state: NativeState<'_>,
    token: String,
    as_copy: bool,
    identity_plan: PackageIdentityPlan,
    data_epoch: Option<u64>,
) -> AppResult<Value> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        packages::import_package(state, &token, as_copy, &identity_plan)
    })
    .await
}
#[tauri::command]
pub async fn export_lesson_package(
    state: NativeState<'_>,
    lesson_id: String,
    draft_revision: Option<u64>,
    prepared_revision: Option<u64>,
    snapshot_owner_ids: Option<Vec<String>>,
    data_epoch: Option<u64>,
) -> AppResult<ExportResult> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        packages::export_package_retained(
            state,
            &lesson_id,
            draft_revision,
            prepared_revision,
            &snapshot_owner_ids.unwrap_or_default(),
        )
    })
    .await
}
/// Keep the flat Tauri IPC contract compatible while adding an optional retained
/// snapshot owner; state and epoch are infrastructure arguments, not game data.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_html(
    state: NativeState<'_>,
    html: String,
    suggested_name: String,
    lesson_id: String,
    revision: u64,
    required_asset_ids: Option<Vec<String>>,
    snapshot_owner_id: Option<String>,
    data_epoch: Option<u64>,
) -> AppResult<ExportResult> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        database::validate_export_source(
            state,
            &lesson_id,
            revision,
            snapshot_owner_id.as_deref(),
            &required_asset_ids.unwrap_or_default(),
        )?;
        if !html
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<!doctype html>")
        {
            return Err(AppError::validation("课堂成品不是完整 HTML 文件"));
        }
        files::export_bytes(state, &suggested_name, html.as_bytes(), 100_000_000)
    })
    .await
}
#[tauri::command]
pub async fn export_backup(
    state: NativeState<'_>,
    data_epoch: Option<u64>,
) -> AppResult<ExportResult> {
    let state = state.inner().clone();
    writing(state, data_epoch, packages::export_backup).await
}
#[tauri::command]
pub async fn restore_backup(
    state: NativeState<'_>,
    app: tauri::AppHandle,
    token: String,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    let state = state.inner().clone();
    let restored = blocking(move || {
        state.check_data_epoch(data_epoch)?;
        packages::restore_backup(&state, &token, data_epoch)
    })
    .await;
    if restored.is_ok() {
        // Every renderer invalidates queries, undo stacks and its cached data_epoch.
        // The committed restore remains successful if a closing window misses an
        // event; subsequent writes are independently rejected by data_epoch checks.
        let fresh = app
            .state::<Arc<AppState>>()
            .data_epoch
            .load(std::sync::atomic::Ordering::SeqCst);
        let _ = app.emit("library-restored", fresh);
    }
    restored
}
#[tauri::command]
pub async fn clean_cache(state: NativeState<'_>, data_epoch: Option<u64>) -> AppResult<usize> {
    let state = state.inner().clone();
    writing(state, data_epoch, assets::clean_cache).await
}

/// Managed ownership operations expose identities, never arbitrary filesystem paths.
#[tauri::command]
pub async fn retain_assets(
    state: NativeState<'_>,
    owner_id: String,
    asset_ids: Vec<String>,
    lesson_id: Option<String>,
    revision: Option<u64>,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    writing(state.inner().clone(), data_epoch, move |state| {
        database::retain_assets(state, &owner_id, &asset_ids, lesson_id.as_deref(), revision)
    })
    .await
}
#[tauri::command]
pub async fn release_assets(
    state: NativeState<'_>,
    owner_id: String,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    writing(state.inner().clone(), data_epoch, move |state| {
        database::release_assets(state, &owner_id)
    })
    .await
}
#[tauri::command]
pub async fn delete_resource(
    state: NativeState<'_>,
    asset_id: String,
    data_epoch: Option<u64>,
) -> AppResult<()> {
    writing(state.inner().clone(), data_epoch, move |state| {
        assets::delete_resource(state, &asset_id)
    })
    .await
}
#[tauri::command]
pub async fn resource_usage(state: NativeState<'_>, asset_id: String) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || assets::resource_usage(&state, &asset_id)).await
}
#[tauri::command]
pub fn get_data_epoch(state: NativeState<'_>) -> u64 {
    state.data_epoch.load(std::sync::atomic::Ordering::SeqCst)
}
#[tauri::command]
pub async fn open_export(state: NativeState<'_>, path: String, folder: bool) -> AppResult<()> {
    let state = state.inner().clone();
    blocking(move || files::open_export(&state, &path, folder)).await
}
/// Recopy the verified local artifact after removable-media or target failure.
#[tauri::command]
pub async fn recopy_export(
    state: NativeState<'_>,
    path: String,
    sha256: String,
    suggested_name: String,
    data_epoch: Option<u64>,
) -> AppResult<ExportResult> {
    let state = state.inner().clone();
    writing(state, data_epoch, move |state| {
        files::recopy_export(state, &path, &sha256, &suggested_name)
    })
    .await
}
#[tauri::command]
pub fn get_data_location(state: NativeState<'_>) -> String {
    state.root.to_string_lossy().into_owned()
}

/// Local copies are listed before explicit selection; external targets never appear.
#[tauri::command]
pub async fn list_export_copies(state: NativeState<'_>) -> AppResult<Value> {
    let state = state.inner().clone();
    blocking(move || files::export_copies(&state)).await
}
#[tauri::command]
pub async fn clear_export_copies(
    state: NativeState<'_>,
    paths: Vec<String>,
    data_epoch: Option<u64>,
) -> AppResult<Value> {
    writing(state.inner().clone(), data_epoch, move |state| {
        files::clear_export_copies(state, &paths)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    /// A same-ID/same-revision late request must fail at the actual write boundary,
    /// before its closure can update SQLite in the new database generation.
    #[test]
    fn late_write_is_rejected_even_when_lesson_revision_still_matches() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::open(temp.path().to_owned()).unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let original = database::save_lesson(
            &state,
            json!({"id":id,"name":"已恢复的课件","gameId":"generic","dataVersion":1,"gameData":{}}),
            0,
        )
        .unwrap();
        let stale_epoch = state.data_epoch.load(Ordering::SeqCst);
        state.replace_data_epoch();
        let mut late = original.clone();
        late["name"] = json!("旧页面的迟到输入");
        let error = tauri::async_runtime::block_on(writing(
            state.clone(),
            Some(stale_epoch),
            move |state| database::save_lesson(state, late, 1),
        ))
        .unwrap_err();
        assert_eq!(error.code, "DATA_REPLACED");
        let saved = database::get_lesson(&state, &id, None).unwrap();
        assert_eq!(saved["name"], original["name"]);
        assert_eq!(saved["revision"], 1);
        assert_eq!(state.active_writes.load(Ordering::SeqCst), 0);
    }
}
