//! Whole-library backups are streamed, checked independently of single-lesson packages,
//! and restored through a staged directory swap. No old connection survives the swap.
//! Author: ahui.
use crate::{
    assets::asset_path,
    database::{now, read_asset_meta, AppState, DATABASE_VERSION},
    error::{AppError, AppResult},
    files::{hash_file, save_export_file},
    model::ExportResult,
    packages::checked_archive_path,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_COMPRESSED: u64 = 5_000_000_000;
const MAX_UNPACKED: u64 = 10_000_000_000;
const MAX_ITEMS: usize = 100_000;
const MAX_MANIFEST: u64 = 20_000_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    path: String,
    byte_length: u64,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    database_version: i64,
    created_at: String,
    files: Vec<BackupEntry>,
}

/// Owned temporary paths are always children of the explicitly provided workspace.
/// A successful rename moves the directory away, so Drop cannot remove live data.
struct TemporaryPath {
    path: PathBuf,
    directory: bool,
}
impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if self.directory {
            let _ = std::fs::remove_dir_all(&self.path);
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
struct SnapshotPins<'a> {
    state: &'a AppState,
    owner: String,
}
impl Drop for SnapshotPins<'_> {
    fn drop(&mut self) {
        if let Ok(db) = self.state.connection() {
            let _ = db.execute("DELETE FROM pins WHERE owner_id=?1", [&self.owner]);
        }
    }
}

/// The SQLite snapshot and every asset it registers form one immutable backup set.
/// Registered cache/resource rows are included too, so restoration cannot create
/// dangling metadata for sounds not currently used by a lesson.
fn build_backup_file(state: &AppState) -> AppResult<PathBuf> {
    let owner = Uuid::new_v4().to_string();
    // Pin cleanup must also cover errors while the pin set is being populated.
    // This earlier declaration drops after the later connection guard releases.
    let _pins = SnapshotPins {
        state,
        owner: owner.clone(),
    };
    let snapshot = TemporaryPath {
        path: state.root.join("tasks").join(format!("{owner}.sqlite3")),
        directory: false,
    };
    let db = state.connection()?;
    db.backup("main", &snapshot.path, None)?;
    let snapshot_db = rusqlite::Connection::open(&snapshot.path)?;
    // Process-owned editor/export inputs are temporary references, not reusable
    // lesson or task history. Restore must never revive a former process owner.
    snapshot_db.execute("DELETE FROM session_inputs", [])?;
    let mut query = snapshot_db.prepare("SELECT id FROM assets ORDER BY sha256,id")?;
    let ids = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut sources = BTreeMap::new();
    sources.insert("library.sqlite3".to_owned(), (snapshot.path.clone(), None));
    for id in ids {
        let asset = read_asset_meta(&snapshot_db, &id)?;
        sources.insert(
            format!("assets/{}", asset.sha256),
            (
                asset_path(state, &asset.sha256)?,
                Some((asset.byte_length, asset.sha256)),
            ),
        );
        db.execute(
            "INSERT OR IGNORE INTO pins(owner_id,asset_id) VALUES(?1,?2)",
            params![owner, id],
        )?;
    }
    drop(query);
    drop(snapshot_db);
    drop(db);
    if sources.len() + 1 > MAX_ITEMS {
        return Err(AppError::validation("完整备份文件数量超过 100,000 项"));
    }
    let output = state
        .root
        .join("exports")
        .join(format!("{}_英语课堂备份.ecgbackup", Uuid::new_v4()));
    let result = (|| {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(&output)?;
        let mut writer = ZipWriter::new(file);
        let mut entries = Vec::new();
        let mut total = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        for (name, (source, expected)) in sources {
            writer
                .start_file(
                    &name,
                    SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .map_err(AppError::zip)?;
            let mut input = File::open(source)?;
            let mut length = 0_u64;
            let mut digest = Sha256::new();
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                length = length.saturating_add(count as u64);
                total = total.saturating_add(count as u64);
                if total > MAX_UNPACKED {
                    return Err(AppError::validation("完整备份解压内容超过 10,000 MB"));
                }
                writer.write_all(&buffer[..count])?;
                digest.update(&buffer[..count]);
                if std::fs::metadata(&output)?.len() > MAX_COMPRESSED {
                    return Err(AppError::validation("完整备份超过 5,000 MB"));
                }
            }
            let digest = format!("{:x}", digest.finalize());
            if expected.is_some_and(|(size, hash)| size != length || hash != digest) {
                return Err(AppError::new("ASSET_INVALID", "备份素材丢失或校验失败"));
            }
            entries.push(BackupEntry {
                path: name,
                byte_length: length,
                sha256: digest,
            });
        }
        let manifest = serde_json::to_vec(&BackupManifest {
            format_version: 1,
            database_version: DATABASE_VERSION,
            created_at: now(),
            files: entries,
        })?;
        if manifest.len() as u64 > MAX_MANIFEST || total + manifest.len() as u64 > MAX_UNPACKED {
            return Err(AppError::validation("完整备份清单或解压内容超过上限"));
        }
        writer
            .start_file(
                "backup.json",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(AppError::zip)?;
        writer.write_all(&manifest)?;
        let file = writer.finish().map_err(AppError::zip)?;
        file.sync_all()?;
        drop(file);
        hash_file(&output, MAX_COMPRESSED)?;
        Ok(output.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(output);
    }
    result
}

pub fn export_backup(state: &AppState) -> AppResult<ExportResult> {
    let local = build_backup_file(state)?;
    save_export_file(
        state,
        &format!(
            "英语课堂备份_{}.ecgbackup",
            chrono::Local::now().format("%Y-%m-%d")
        ),
        &local,
        MAX_COMPRESSED,
    )
}

/// Validate names, counts and a bounded manifest before writing any archive content.
/// Actual extracted bytes and hashes are checked incrementally; headers are hints.
fn extract_backup(source: &Path, stage: &Path) -> AppResult<()> {
    let input = File::open(source)?;
    if input.metadata()?.len() > MAX_COMPRESSED {
        return Err(AppError::validation("备份文件超过 5,000 MB"));
    }
    let mut archive = ZipArchive::new(input).map_err(AppError::zip)?;
    if archive.len() > MAX_ITEMS {
        return Err(AppError::validation("备份条目超过 100,000 项"));
    }
    let mut actual = HashSet::new();
    let mut manifest_index = None;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(AppError::zip)?;
        let key = checked_archive_path(entry.name())?;
        if !actual.insert(key.clone())
            || entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::validation("备份包含重名、目录或符号链接条目"));
        }
        if key == "backup.json" {
            manifest_index = Some(index);
        } else if key != "library.sqlite3"
            && !(key.starts_with("assets/")
                && key.len() == 71
                && key[7..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err(AppError::validation("备份包含未知文件"));
        }
    }
    let manifest_bytes = {
        let mut entry = archive
            .by_index(manifest_index.ok_or_else(|| AppError::validation("缺少完整备份清单"))?)
            .map_err(AppError::zip)?;
        if entry.size() > MAX_MANIFEST {
            return Err(AppError::validation("备份清单超过 20 MB"));
        }
        let mut bytes = Vec::new();
        entry
            .by_ref()
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err(AppError::validation("备份清单超过 20 MB"));
        }
        bytes
    };
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.format_version != 1 || manifest.database_version != DATABASE_VERSION {
        return Err(AppError::new(
            "UNSUPPORTED_VERSION",
            "完整备份格式或数据库版本不受支持",
        ));
    }
    let mut expected = BTreeMap::new();
    for item in manifest.files {
        let key = checked_archive_path(&item.path)?;
        if key == "backup.json"
            || item.sha256.len() != 64
            || !item.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || expected.insert(key, item).is_some()
        {
            return Err(AppError::validation("备份清单包含重复路径或非法校验值"));
        }
    }
    if !expected.contains_key("library.sqlite3")
        || actual.len() != expected.len() + 1
        || !expected.keys().all(|key| actual.contains(key))
    {
        return Err(AppError::validation("完整备份清单与实际文件集合不一致"));
    }
    std::fs::create_dir_all(stage.join("assets"))?;
    let mut total = manifest_bytes.len() as u64;
    let mut buffer = [0_u8; 64 * 1024];
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(AppError::zip)?;
        let key = checked_archive_path(entry.name())?;
        if key == "backup.json" {
            continue;
        }
        let item = &expected[&key];
        if entry.size() != item.byte_length || item.byte_length > MAX_UNPACKED.saturating_sub(total)
        {
            return Err(AppError::validation("备份解压大小或清单长度不符"));
        }
        let destination = stage.join(&key);
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let mut digest = Sha256::new();
        let mut length = 0_u64;
        loop {
            let count = entry.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total = total.saturating_add(count as u64);
            length = length.saturating_add(count as u64);
            if total > MAX_UNPACKED || length > item.byte_length {
                return Err(AppError::validation("备份实际解压内容超过预算"));
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
        }
        output.sync_all()?;
        if length != item.byte_length || format!("{:x}", digest.finalize()) != item.sha256 {
            return Err(AppError::new("ASSET_INVALID", "完整备份文件校验失败"));
        }
    }
    Ok(())
}

fn verify_library(stage: &Path) -> AppResult<()> {
    // No untrusted trigger/view may execute during startup recovery of the staged DB.
    let raw = rusqlite::Connection::open_with_flags(
        stage.join("library.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let unsafe_schema: u64 = raw.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('trigger','view')",
        [],
        |row| row.get(0),
    )?;
    let integrity: String = raw.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    let foreign_errors: u64 =
        raw.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    let version: i64 = raw.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if unsafe_schema > 0 || integrity != "ok" || foreign_errors > 0 || version != DATABASE_VERSION {
        return Err(AppError::new(
            "ASSET_INVALID",
            "备份数据库结构或完整性校验失败",
        ));
    }
    drop(raw);
    let verified = AppState::open(stage.to_path_buf())?;
    let db = verified.connection()?;
    // A well-formed SQLite file can still contain malformed teaching metadata.
    // Reuse the write boundary before switching; unknown historical review data
    // stays absent rather than being inferred from the teacher's confirmation.
    let mut shared = db.prepare("SELECT key,value FROM app_data")?;
    let values = shared
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (key, body) in values {
        if body.len() > 20_000_000 {
            return Err(AppError::validation("备份应用数据超过 20 MB 限制"));
        }
        crate::database::validate_app_data(&key, &serde_json::from_str(&body)?)?;
    }
    let mut query = db.prepare("SELECT id FROM assets")?;
    let ids = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        let asset = read_asset_meta(&db, &id)?;
        let (length, digest) = hash_file(&asset_path(&verified, &asset.sha256)?, 50_000_000)?;
        if length != asset.byte_length || digest != asset.sha256 {
            return Err(AppError::new("ASSET_INVALID", "备份素材与数据库登记不一致"));
        }
        let bytes =
            crate::assets::read_limited(&asset_path(&verified, &asset.sha256)?, 50_000_000)?;
        if crate::assets::detect_mime(&bytes)? != asset.mime_type {
            return Err(AppError::new("ASSET_INVALID", "备份声音格式与登记不一致"));
        }
        let maximum = match asset.kind.as_str() {
            "music" => 600_000.0,
            "recording" | "speech" if length <= 20_000_000 => 30_000.0,
            _ => return Err(AppError::new("ASSET_INVALID", "备份声音用途或大小无效")),
        };
        let information = crate::assets::audio_information(&bytes, &asset.mime_type, maximum)?;
        // The decoder tolerance only covers positive metadata rounding. Without
        // this check a genuine short clip could validate a zero/negative record.
        if !asset.duration_ms.is_finite()
            || asset.duration_ms <= 0.0
            || (information.duration_ms - asset.duration_ms).abs() > 100.0
        {
            return Err(AppError::new(
                "ASSET_INVALID",
                "备份声音真实时长与登记不一致",
            ));
        }
        if asset
            .sample_rate
            .is_some_and(|value| value != information.sample_rate)
            || asset
                .channels
                .is_some_and(|value| value != information.channels)
            || asset
                .frame_count
                .is_some_and(|value| value != information.frame_count)
        {
            return Err(AppError::new(
                "ASSET_INVALID",
                "备份声音采样信息与实际解码不符",
            ));
        }
    }
    Ok(())
}

/// Restore blocks new writers, waits for admitted operations, creates a rollback
/// backup, checks a staged library, and only then swaps complete directories.
pub fn restore_backup(state: &AppState, token: &str, data_epoch: Option<u64>) -> AppResult<()> {
    if state.maintenance.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("MAINTENANCE", "已有恢复操作正在进行"));
    }
    let result = (|| {
        // Check after owning the maintenance barrier as well: an old renderer may
        // have been descheduled after its first check while another restore ran.
        state.check_data_epoch(data_epoch)?;
        let active = {
            let db = state.connection()?;
            let mut query = db
                .prepare("SELECT id FROM tasks WHERE state IN ('queued','running','cancelling')")?;
            let result = query
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            result
        };
        for id in active {
            crate::speech::cancel_task(state, &id)?;
        }
        let started = Instant::now();
        loop {
            let count: u64 = state.connection()?.query_row(
                "SELECT COUNT(*) FROM tasks WHERE state IN ('queued','running','cancelling')",
                [],
                |row| row.get(0),
            )?;
            if count == 0 && state.active_writes.load(Ordering::SeqCst) == 0 {
                break;
            }
            if started.elapsed() > Duration::from_secs(35) {
                return Err(AppError::new(
                    "MAINTENANCE",
                    "写入任务尚未停止，本次恢复未切换，请稍后重试",
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let safety = build_backup_file(state)?;
        let safety_name = format!("before-restore-{}.ecgbackup", Uuid::new_v4());
        let safety_path = state.root.join("backups").join(&safety_name);
        std::fs::rename(safety, &safety_path)?;
        let parent = state
            .root
            .parent()
            .ok_or_else(|| AppError::io("数据目录无父目录"))?;
        let stage = TemporaryPath {
            path: parent.join(format!("restore-{}", Uuid::new_v4())),
            directory: true,
        };
        extract_backup(&crate::files::selected_path(state, token)?, &stage.path)?;
        verify_library(&stage.path)?;
        std::fs::create_dir_all(stage.path.join("backups"))?;
        let safety_hash = hash_file(&safety_path, MAX_COMPRESSED)?.1;
        crate::files::write_verified_target(
            &safety_path,
            &stage.path.join("backups").join(&safety_name),
            &safety_hash,
            MAX_COMPRESSED,
        )?;
        let mut connection = state.connection()?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let old = std::mem::replace(&mut *connection, rusqlite::Connection::open_in_memory()?);
        drop(old);
        let previous = parent.join(format!("previous-{}", Uuid::new_v4()));
        if let Err(error) = std::fs::rename(&state.root, &previous) {
            *connection = crate::database::open_connection(&state.root.join("library.sqlite3"))?;
            return Err(error.into());
        }
        if let Err(error) = std::fs::rename(&stage.path, &state.root) {
            std::fs::rename(&previous, &state.root)?;
            *connection = crate::database::open_connection(&state.root.join("library.sqlite3"))?;
            return Err(error.into());
        }
        match crate::database::open_connection(&state.root.join("library.sqlite3")) {
            Ok(reopened) => *connection = reopened,
            Err(error) => {
                std::fs::rename(
                    &state.root,
                    parent.join(format!("failed-restore-{}", Uuid::new_v4())),
                )?;
                std::fs::rename(&previous, &state.root)?;
                *connection =
                    crate::database::open_connection(&state.root.join("library.sqlite3"))?;
                return Err(error);
            }
        }
        state.replace_data_epoch();
        state
            .selected
            .lock()
            .map_err(|_| AppError::io("文件选择状态异常"))?
            .clear();
        state
            .exported
            .lock()
            .map_err(|_| AppError::io("成品状态异常"))?
            .clear();
        Ok(())
    })();
    state.maintenance.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Use the actual public teaching shape so backup tests cover recoverable
    /// teacher data rather than a string-only fixture the application never saves.
    fn common_word(english: &str) -> serde_json::Value {
        json!([{"id":"common-entry","english":english,"meaning":"","priority":false}])
    }

    #[test]
    fn partial_backup_pin_failure_releases_prior_pins_and_snapshot_file() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        for duration in [900, 1200] {
            crate::assets::store_audio(
                &state,
                &crate::assets::test_pcm(duration),
                None,
                None,
                20_000_000,
                30_000.0,
                None,
            )
            .unwrap();
        }
        state.connection().unwrap().execute_batch(
            "CREATE TRIGGER fail_second_pin BEFORE INSERT ON pins WHEN EXISTS(SELECT 1 FROM pins) BEGIN SELECT RAISE(ABORT,'injected second pin failure'); END;",
        ).unwrap();
        assert!(build_backup_file(&state).is_err());
        let count: u64 = state
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pins", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            std::fs::read_dir(state.root.join("tasks")).unwrap().count(),
            0
        );
        assert_eq!(
            std::fs::read_dir(state.root.join("exports"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn task_input_survives_source_deletion_and_backup_until_its_record_is_cleared() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let sound = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(900),
            Some("原快照配音".into()),
            Some("snapshot-only"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let document = crate::database::save_lesson(
            &state,
            json!({"id":Uuid::new_v4().to_string(),
            "name":"任务原始输入", "gameId":"word-beat", "dataVersion":1,
            "gameData":{"originalText":"responsibility", "assetId":sound.asset_id}}),
            0,
        )
        .unwrap();
        let task: crate::model::TaskRecord = serde_json::from_value(json!({
            "taskId":Uuid::new_v4().to_string(), "kind":"speech", "lessonId":document["id"],
            "inputRevision":1, "state":"completed", "stage":"声音制作完成", "completed":1,
            "total":1, "results":[], "failures":[], "cancelRequested":false,
            "createdAt":crate::database::now(), "updatedAt":crate::database::now()
        }))
        .unwrap();
        {
            let mut db = state.connection().unwrap();
            let tx = db.transaction().unwrap();
            tx.execute("INSERT INTO tasks(id,lesson_id,input_revision,kind,input_hash,state,record,updated_at) VALUES(?1,?2,?3,'speech','snapshot-test','completed',?4,?5)",
                rusqlite::params![task.task_id, task.lesson_id, task.input_revision, serde_json::to_string(&task).unwrap(), task.updated_at]).unwrap();
            // An old task without a copied input can only use its real revision.
            tx.commit().unwrap();
        }
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id).unwrap(),
            document
        );
        crate::database::save_task_input(&state.connection().unwrap(), &task).unwrap();
        crate::database::delete_lesson(&state, document["id"].as_str().unwrap()).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 0);
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id).unwrap(),
            document
        );
        let local = build_backup_file(&state).unwrap();
        let outside = temp.path().join("任务输入独立备份.ecgbackup");
        std::fs::copy(local, &outside).unwrap();
        crate::database::clear_task(&state, &task.task_id).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id)
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
        state
            .selected
            .lock()
            .unwrap()
            .insert("task-backup".into(), outside);
        restore_backup(
            &state,
            "task-backup",
            Some(state.data_epoch.load(Ordering::SeqCst)),
        )
        .unwrap();
        assert!(crate::database::list_lessons(&state).unwrap().is_empty());
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id).unwrap(),
            document
        );
        assert!(crate::assets::read_asset(&state, &sound.asset_id).is_ok());
        // Removing a new snapshot emulates an old already-orphaned record. No
        // current draft or fabricated content may stand in for the missing input.
        state
            .connection()
            .unwrap()
            .execute("DELETE FROM task_inputs WHERE task_id=?1", [&task.task_id])
            .unwrap();
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id)
                .unwrap_err()
                .code,
            "TASK_INPUT_UNAVAILABLE"
        );
        crate::database::clear_task(&state, &task.task_id).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
    }

    #[test]
    fn complete_backup_restores_library_resources_preferences_and_invalidates_old_pages() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(900),
            Some("未使用的音乐".into()),
            None,
            50_000_000,
            600_000.0,
            None,
        )
        .unwrap();
        crate::database::set_app_data(
            &state,
            "materials",
            json!([{"id":"reading","name":"高中阅读","original":"High school English","entries":[],"revision":1,"createdAt":now(),"updatedAt":now()}]),
        )
        .unwrap();
        crate::database::set_app_data(&state, "preferences", json!({"voice":"teacher-choice"}))
            .unwrap();
        let document = crate::database::save_lesson(&state,json!({"id":Uuid::new_v4().to_string(),"name":"恢复测试","gameId":"word-beat","dataVersion":1,"gameData":{}}),0).unwrap();
        let export_history = json!({"version":1,"tasks":[{"id":"fixed-export","lessonId":document["id"],"name":"恢复测试","draftRevision":1,"selectedRevision":1,"stage":"已结束","running":false,"outcomes":[{"kind":"html","state":"completed","result":{"path":"E:/课堂.html","localCopy":"C:/成品.html","sha256":"a".repeat(64),"byteLength":100,"completed":true}}]}]});
        crate::database::set_app_data(&state, "exportHistory", export_history.clone()).unwrap();
        let export_owner = Uuid::new_v4().to_string();
        crate::database::retain_assets(
            &state,
            &export_owner,
            &[],
            Some(document["id"].as_str().unwrap()),
            Some(1),
        )
        .unwrap();
        let backup = build_backup_file(&state).unwrap();
        let outside = temp.path().join("带走的完整备份.ecgbackup");
        std::fs::copy(backup, &outside).unwrap();
        let id = document["id"].as_str().unwrap();
        crate::database::delete_lesson(&state, id).unwrap();
        crate::database::set_app_data(&state, "materials", json!([])).unwrap();
        state
            .selected
            .lock()
            .unwrap()
            .insert("restore".into(), outside);
        let data_epoch = state.data_epoch.load(Ordering::SeqCst);
        restore_backup(&state, "restore", Some(data_epoch)).unwrap();
        assert_eq!(
            crate::database::get_app_data(&state, "exportHistory").unwrap(),
            export_history
        );
        assert_eq!(
            state
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM session_inputs", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            crate::database::get_lesson(&state, id, None).unwrap()["name"],
            "恢复测试"
        );
        assert_eq!(
            crate::database::get_app_data(&state, "materials").unwrap()[0]["id"],
            "reading"
        );
        assert_eq!(
            crate::database::get_app_data(&state, "preferences").unwrap()["voice"],
            "teacher-choice"
        );
        assert_eq!(
            crate::assets::read_asset(&state, &asset.asset_id)
                .unwrap()
                .kind,
            "music"
        );
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 0);
        assert_eq!(
            state.check_data_epoch(Some(data_epoch)).unwrap_err().code,
            "DATA_REPLACED"
        );
        assert!(state.selected.lock().unwrap().is_empty());
        assert!(!state.maintenance.load(Ordering::SeqCst));
        assert_eq!(
            std::fs::read_dir(state.root.join("backups"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn invalid_backup_keeps_existing_library_and_releases_maintenance() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        crate::database::set_app_data(&state, "commonWords", common_word("responsibility"))
            .unwrap();
        let bad = temp.path().join("invalid.ecgbackup");
        std::fs::write(&bad, b"not a zip").unwrap();
        state.selected.lock().unwrap().insert("bad".into(), bad);
        let data_epoch = state.data_epoch.load(Ordering::SeqCst);
        assert!(restore_backup(&state, "bad", Some(data_epoch)).is_err());
        assert_eq!(state.data_epoch.load(Ordering::SeqCst), data_epoch);
        assert_eq!(
            crate::database::get_app_data(&state, "commonWords").unwrap(),
            common_word("responsibility")
        );
        assert!(!state.maintenance.load(Ordering::SeqCst));
    }

    #[test]
    fn malformed_shared_metadata_in_valid_sqlite_cannot_replace_the_live_library() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("live")).unwrap();
        let original = common_word("responsibility");
        crate::database::set_app_data(&state, "commonWords", original.clone()).unwrap();
        let foreign = AppState::open(temp.path().join("foreign")).unwrap();
        let mut malformed = common_word("knowledge");
        malformed[0]["partOfSpeech"] = json!("😀".repeat(41));
        // Bypass the ordinary write boundary to model a valid but untrusted
        // SQLite backup. Integrity/hash validation alone cannot find this error.
        foreign
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO app_data(key,value) VALUES('commonWords',?1)",
                [serde_json::to_string(&malformed).unwrap()],
            )
            .unwrap();
        let backup = build_backup_file(&foreign).unwrap();
        let outside = temp.path().join("invalid-metadata.ecgbackup");
        std::fs::copy(backup, &outside).unwrap();
        state
            .selected
            .lock()
            .unwrap()
            .insert("metadata".into(), outside);
        let epoch = state.data_epoch.load(Ordering::SeqCst);
        let failure = restore_backup(&state, "metadata", Some(epoch)).unwrap_err();
        assert_eq!(failure.code, "VALIDATION_ERROR");
        assert_eq!(state.data_epoch.load(Ordering::SeqCst), epoch);
        assert_eq!(
            crate::database::get_app_data(&state, "commonWords").unwrap(),
            original
        );
        assert!(!state.maintenance.load(Ordering::SeqCst));
    }

    #[test]
    fn nonpositive_short_audio_metadata_cannot_replace_the_live_library() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("live")).unwrap();
        let original = common_word("responsibility");
        crate::database::set_app_data(&state, "commonWords", original.clone()).unwrap();
        for duration in [0.0, -1.0] {
            let foreign = AppState::open(temp.path().join(format!("foreign-{duration}"))).unwrap();
            let asset = crate::assets::store_audio(
                &foreign,
                &crate::assets::test_pcm(50),
                None,
                None,
                20_000_000,
                30_000.0,
                None,
            )
            .unwrap();
            assert_eq!(asset.duration_ms, 50.0);
            // Forge only SQLite metadata. Bytes, hashes, decoding and frame
            // counts remain real, so this specifically tests the tolerance hole.
            foreign
                .connection()
                .unwrap()
                .execute(
                    "UPDATE assets SET duration_ms=?1 WHERE id=?2",
                    rusqlite::params![duration, asset.asset_id],
                )
                .unwrap();
            let backup = build_backup_file(&foreign).unwrap();
            let outside = temp
                .path()
                .join(format!("invalid-duration-{duration}.ecgbackup"));
            std::fs::copy(backup, &outside).unwrap();
            state
                .selected
                .lock()
                .unwrap()
                .insert("duration".into(), outside);
            let epoch = state.data_epoch.load(Ordering::SeqCst);
            let failure = restore_backup(&state, "duration", Some(epoch)).unwrap_err();
            assert_eq!(failure.code, "ASSET_INVALID");
            assert_eq!(state.data_epoch.load(Ordering::SeqCst), epoch);
            assert_eq!(
                crate::database::get_app_data(&state, "commonWords").unwrap(),
                original
            );
            assert!(crate::assets::list_assets(&state).unwrap().is_empty());
            assert!(!state.maintenance.load(Ordering::SeqCst));
        }
    }

    #[test]
    fn restore_waits_for_admitted_writes_and_rejects_new_writes_before_switching() {
        let temp = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(AppState::open(temp.path().join("library")).unwrap());
        crate::database::set_app_data(&state, "preferences", json!({"state":"backup"})).unwrap();
        let backup = build_backup_file(&state).unwrap();
        let outside = temp.path().join("restore.ecgbackup");
        std::fs::copy(backup, &outside).unwrap();
        crate::database::set_app_data(&state, "preferences", json!({"state":"current"})).unwrap();
        state
            .selected
            .lock()
            .unwrap()
            .insert("restore".into(), outside);
        let data_epoch = state.data_epoch.load(Ordering::SeqCst);
        let admitted = crate::database::WriteOperation::begin(&state).unwrap();
        let restoring = state.clone();
        let worker =
            std::thread::spawn(move || restore_backup(&restoring, "restore", Some(data_epoch)));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !state.maintenance.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(state.maintenance.load(Ordering::SeqCst));
        assert_eq!(state.data_epoch.load(Ordering::SeqCst), data_epoch);
        assert_eq!(
            crate::database::get_app_data(&state, "preferences").unwrap()["state"],
            "current"
        );
        assert_eq!(
            crate::database::WriteOperation::begin(&state)
                .err()
                .unwrap()
                .code,
            "MAINTENANCE"
        );
        assert_eq!(
            crate::database::set_app_data(&state, "preferences", json!({"state":"late"}))
                .unwrap_err()
                .code,
            "MAINTENANCE"
        );
        // Only releasing the already admitted operation permits the directory
        // swap. No test relies on a guessed file-copy duration or sleep race.
        drop(admitted);
        worker.join().unwrap().unwrap();
        assert_ne!(state.data_epoch.load(Ordering::SeqCst), data_epoch);
        assert_eq!(
            crate::database::get_app_data(&state, "preferences").unwrap()["state"],
            "backup"
        );
        assert!(!state.maintenance.load(Ordering::SeqCst));
    }

    #[test]
    fn failed_safety_backup_never_replaces_existing_library() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let valid = build_backup_file(&state).unwrap();
        let outside = temp.path().join("valid.ecgbackup");
        std::fs::copy(valid, &outside).unwrap();
        let asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(900),
            None,
            Some("safety-missing"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        std::fs::remove_file(asset_path(&state, &asset.sha256).unwrap()).unwrap();
        crate::database::set_app_data(&state, "commonWords", common_word("current-input")).unwrap();
        state
            .selected
            .lock()
            .unwrap()
            .insert("restore".into(), outside);
        let data_epoch = state.data_epoch.load(Ordering::SeqCst);
        assert!(restore_backup(&state, "restore", Some(data_epoch)).is_err());
        assert_eq!(state.data_epoch.load(Ordering::SeqCst), data_epoch);
        assert_eq!(
            crate::database::get_app_data(&state, "commonWords").unwrap(),
            common_word("current-input")
        );
        assert!(crate::assets::list_assets(&state)
            .unwrap()
            .iter()
            .any(|item| item.asset_id == asset.asset_id));
        assert!(!state.maintenance.load(Ordering::SeqCst));
        assert!(crate::database::WriteOperation::begin(&state).is_ok());
    }
}
