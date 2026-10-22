//! SQLite is the authoritative local store. Revisions are append-only and saved with
//! compare-and-swap, so delayed autosaves never overwrite a teacher's newer edits.
//! Author: ahui.
use crate::{
    error::{AppError, AppResult},
    model::{AudioAsset, TaskRecord},
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
};
use uuid::Uuid;

pub const DATABASE_VERSION: i64 = 1;
pub const MAX_DOCUMENT_BYTES: usize = 5_000_000;
const MAX_DATA_EPOCH: u64 = (1_u64 << 53) - 1;

/// An epoch is process-local, never restored from SQLite. UUID entropy prevents a
/// rapid restart or adjusted system clock from reusing an old renderer's token.
/// The mask keeps the IPC integer exact in JavaScript's safe integer range.
fn new_data_epoch() -> u64 {
    ((Uuid::new_v4().as_u128() as u64) & MAX_DATA_EPOCH).max(1)
}

/// Native state contains only managed paths and explicit dialog selections.
/// A single connection lock makes revision checks and resource references transactional.
pub struct AppState {
    pub music_import: crate::music_import::ImportSlot,
    pub root: PathBuf,
    pub db: Mutex<Connection>,
    pub selected: Mutex<HashMap<String, PathBuf>>,
    pub exported: Mutex<HashSet<PathBuf>>,
    pub speech_gate: Mutex<()>,
    pub maintenance: AtomicBool,
    pub active_writes: AtomicUsize,
    /// Old browser requests cannot write into a newly restored database, even when
    /// its numeric lesson revision happens to equal the previous database's value.
    pub data_epoch: AtomicU64,
    pub import_gate: Mutex<()>,
    pub export_gate: Mutex<()>,
}

impl AppState {
    pub fn open(root: PathBuf) -> AppResult<Self> {
        for directory in ["assets", "tasks", "exports", "backups"] {
            std::fs::create_dir_all(root.join(directory))?;
        }
        let connection = open_connection(&root.join("library.sqlite3"))?;
        // A process restart cannot resume an in-flight WinRT operation safely.
        connection.execute("UPDATE tasks SET state='interrupted', updated_at=?1 WHERE state IN ('queued','running','cancelling')", [now()])?;
        connection.execute(
            "DELETE FROM pins WHERE owner_id NOT IN (SELECT id FROM tasks)",
            [],
        )?;
        connection.execute("DELETE FROM revision_pins", [])?;
        connection.execute("DELETE FROM session_inputs", [])?;
        // Files left before the metadata transaction committed are recoverable garbage.
        // Only managed asset filenames not referenced anywhere in the database are removed.
        let mut query = connection.prepare("SELECT DISTINCT sha256 FROM assets")?;
        let referenced = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        drop(query);
        for entry in std::fs::read_dir(root.join("assets"))? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && !referenced.contains(&entry.file_name().to_string_lossy().into_owned())
            {
                std::fs::remove_file(entry.path())?;
            }
        }
        for entry in std::fs::read_dir(root.join("tasks"))? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(Self {
            music_import: Default::default(),
            root,
            db: Mutex::new(connection),
            selected: Mutex::new(HashMap::new()),
            exported: Mutex::new(HashSet::new()),
            speech_gate: Mutex::new(()),
            maintenance: AtomicBool::new(false),
            active_writes: AtomicUsize::new(0),
            data_epoch: AtomicU64::new(new_data_epoch()),
            import_gate: Mutex::new(()),
            export_gate: Mutex::new(()),
        })
    }

    pub fn connection(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::new("DATABASE_ERROR", "本地数据锁异常，请重启软件"))
    }

    /// Must be checked after acquiring the connection, avoiding a race with restore.
    pub fn ensure_writable(&self) -> AppResult<()> {
        if self.maintenance.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "MAINTENANCE",
                "正在备份恢复或迁移，请稍后操作",
            ));
        }
        Ok(())
    }

    pub fn check_data_epoch(&self, data_epoch: Option<u64>) -> AppResult<()> {
        if data_epoch != Some(self.data_epoch.load(Ordering::SeqCst)) {
            return Err(AppError::new(
                "DATA_REPLACED",
                "本地资料已恢复，请重新打开当前页面后再操作",
            ));
        }
        Ok(())
    }

    /// Only restore's exclusive maintenance barrier advances the live token.
    /// Even an extremely unlikely random collision must not keep the old epoch.
    pub fn replace_data_epoch(&self) {
        let old = self.data_epoch.load(Ordering::SeqCst);
        let next = new_data_epoch();
        self.data_epoch.store(
            if next == old {
                old % MAX_DATA_EPOCH + 1
            } else {
                next
            },
            Ordering::SeqCst,
        );
    }
}

/// A restore cannot switch directories while an export/import is outside the SQLite
/// lock copying bytes. Double-checking maintenance closes the admission race.
pub struct WriteOperation<'a> {
    state: &'a AppState,
}
impl<'a> WriteOperation<'a> {
    pub fn begin(state: &'a AppState) -> AppResult<Self> {
        state.ensure_writable()?;
        state.active_writes.fetch_add(1, Ordering::SeqCst);
        if let Err(error) = state.ensure_writable() {
            state.active_writes.fetch_sub(1, Ordering::SeqCst);
            return Err(error);
        }
        Ok(Self { state })
    }
}
impl Drop for WriteOperation<'_> {
    fn drop(&mut self) {
        self.state.active_writes.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Initial migration is additive; a future unknown database is never opened for writing.
pub fn open_connection(path: &Path) -> AppResult<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > DATABASE_VERSION {
        return Err(AppError::new(
            "UNSUPPORTED_VERSION",
            "数据库版本高于当前软件，请使用更新版本",
        ));
    }
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,name TEXT NOT NULL,game_id TEXT NOT NULL,draft_revision INTEGER NOT NULL,prepared_revision INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(lesson_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(lesson_id,revision),FOREIGN KEY(lesson_id) REFERENCES lessons(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,mime_type TEXT NOT NULL,byte_length INTEGER NOT NULL,duration_ms REAL NOT NULL,name TEXT,cache_key TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS asset_cache ON assets(cache_key);
      CREATE TABLE IF NOT EXISTS revision_assets(lesson_id TEXT NOT NULL,revision INTEGER NOT NULL,asset_id TEXT NOT NULL,PRIMARY KEY(lesson_id,revision,asset_id),FOREIGN KEY(lesson_id,revision) REFERENCES revisions(lesson_id,revision) ON DELETE CASCADE,FOREIGN KEY(asset_id) REFERENCES assets(id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,lesson_id TEXT,input_revision INTEGER,kind TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_inputs(task_id TEXT PRIMARY KEY,document TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS pins(owner_id TEXT NOT NULL,asset_id TEXT NOT NULL,PRIMARY KEY(owner_id,asset_id),FOREIGN KEY(asset_id) REFERENCES assets(id));
      CREATE TABLE IF NOT EXISTS resource_assets(asset_id TEXT PRIMARY KEY,kind TEXT NOT NULL,FOREIGN KEY(asset_id) REFERENCES assets(id));
      CREATE TABLE IF NOT EXISTS revision_pins(owner_id TEXT NOT NULL,lesson_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(owner_id,lesson_id,revision));
      CREATE TABLE IF NOT EXISTS session_inputs(owner_id TEXT PRIMARY KEY,lesson_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_data(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,digest TEXT NOT NULL,asset_digest TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(source_id,source_revision,digest,asset_digest));
      PRAGMA user_version=1;")?;
    // These additive fields keep work created by earlier V1 development builds
    // readable. No public schema is downgraded and existing asset identities stay.
    let columns = connection
        .prepare("PRAGMA table_info(assets)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    if !columns.contains("kind") {
        connection.execute_batch("ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'recording'; UPDATE assets SET kind='speech' WHERE cache_key IS NOT NULL; UPDATE assets SET kind=(SELECT kind FROM resource_assets WHERE asset_id=assets.id) WHERE id IN (SELECT asset_id FROM resource_assets);")?;
    }
    // Nullable metadata keeps existing V1 libraries readable. New imports fill
    // it from decoded frames; an absent value never means a zero-memory sound.
    for (column, definition) in [
        ("sample_rate", "INTEGER"),
        ("channels", "INTEGER"),
        ("frame_count", "INTEGER"),
    ] {
        if !columns.contains(column) {
            connection.execute_batch(&format!(
                "ALTER TABLE assets ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    let import_columns = connection
        .prepare("PRAGMA table_info(imports)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    if !import_columns.contains("local_digest") {
        connection.execute(
            "ALTER TABLE imports ADD COLUMN local_digest TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(connection)
}

/// Collect explicit asset identities anywhere in opaque game JSON. This is reference
/// bookkeeping, not a game rule; actual required/enabled assets come from the module.
pub fn asset_ids(value: &Value) -> HashSet<String> {
    let mut found = HashSet::new();
    fn visit(value: &Value, found: &mut HashSet<String>) {
        match value {
            Value::Object(object) => {
                if let Some(Value::String(id)) = object.get("assetId") {
                    if !id.is_empty() {
                        found.insert(id.clone());
                    }
                }
                for child in object.values() {
                    visit(child, found);
                }
            }
            Value::Array(array) => {
                for child in array {
                    visit(child, found);
                }
            }
            _ => {}
        }
    }
    visit(value, &mut found);
    found
}

pub fn validate_document(document: &Value) -> AppResult<()> {
    let object = document
        .as_object()
        .ok_or_else(|| AppError::validation("课件必须为对象"))?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("课件缺少标识"))?;
    Uuid::parse_str(id).map_err(|_| AppError::validation("课件标识不是有效 UUID"))?;
    let game = object.get("gameId").and_then(Value::as_str).unwrap_or("");
    if game.is_empty()
        || game.len() > 80
        || !game.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(AppError::validation("游戏标识不正确"));
    }
    if object.get("dataVersion").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::new("UNSUPPORTED_VERSION", "课件数据版本暂不支持"));
    }
    if !object.contains_key("gameData") || !object.get("name").is_some_and(Value::is_string) {
        return Err(AppError::validation("课件缺少名称或游戏数据"));
    }
    if serde_json::to_vec(document)?.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::validation("课件数据超过 5 MB 限制"));
    }
    Ok(())
}

pub fn list_lessons(state: &AppState) -> AppResult<Vec<Value>> {
    let db = state.connection()?;
    let mut statement = db.prepare("SELECT r.document,l.prepared_revision FROM lessons l JOIN revisions r ON r.lesson_id=l.id AND r.revision=l.draft_revision ORDER BY l.updated_at DESC")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<u64>>(1)?))
    })?;
    rows.map(|row| {
        let (body, prepared) = row?;
        let mut value: Value = serde_json::from_str(&body)?;
        value["preparedRevision"] = json!(prepared);
        Ok(value)
    })
    .collect()
}

pub fn get_lesson(state: &AppState, lesson_id: &str, revision: Option<u64>) -> AppResult<Value> {
    let db = state.connection()?;
    get_lesson_from(&db, lesson_id, revision)
}

pub fn get_lesson_from(
    db: &Connection,
    lesson_id: &str,
    revision: Option<u64>,
) -> AppResult<Value> {
    let selected = db
        .query_row(
            "SELECT draft_revision,prepared_revision FROM lessons WHERE id=?1",
            [lesson_id],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, Option<u64>>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::validation("课件不存在或已删除"))?;
    let body: String = db
        .query_row(
            "SELECT document FROM revisions WHERE lesson_id=?1 AND revision=?2",
            params![lesson_id, revision.unwrap_or(selected.0)],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::validation("该课件修订不存在"))?;
    let mut document: Value = serde_json::from_str(&body)?;
    document["preparedRevision"] = json!(selected.1);
    Ok(document)
}

/// One transaction creates the immutable revision and all asset references together.
/// Invalid draft field text is allowed, while malformed identities/foreign references fail.
pub fn save_lesson(
    state: &AppState,
    mut document: Value,
    expected_revision: u64,
) -> AppResult<Value> {
    validate_document(&document)?;
    let id = document["id"].as_str().unwrap_or_default().to_owned();
    let mut db = state.connection()?;
    state.ensure_writable()?;
    let transaction = db.transaction()?;
    let current = transaction
        .query_row(
            "SELECT draft_revision,game_id FROM lessons WHERE id=?1",
            [&id],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if current.as_ref().map(|(revision, _)| *revision).unwrap_or(0) != expected_revision {
        return Err(AppError::new(
            "REVISION_CONFLICT",
            "课件已被更新，已保留当前输入，请重新载入比较",
        ));
    }
    if current
        .as_ref()
        .is_some_and(|(_, game)| document["gameId"].as_str() != Some(game.as_str()))
    {
        return Err(AppError::validation(
            "已有课件不能切换为另一个游戏；请新建课件",
        ));
    }
    let revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| AppError::validation("修订号超限"))?;
    let timestamp = now();
    document["revision"] = json!(revision);
    document["updatedAt"] = json!(timestamp);
    if current.is_none() {
        document["createdAt"] = json!(timestamp);
    }
    document
        .as_object_mut()
        .map(|obj| obj.remove("preparedRevision"));
    if current.is_none() {
        transaction.execute("INSERT INTO lessons(id,name,game_id,draft_revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)", params![id, document["name"].as_str(), document["gameId"].as_str(), revision, timestamp])?;
    } else {
        transaction.execute(
            "UPDATE lessons SET name=?2,draft_revision=?3,updated_at=?4 WHERE id=?1",
            params![id, document["name"].as_str(), revision, timestamp],
        )?;
    }
    transaction.execute(
        "INSERT INTO revisions(lesson_id,revision,document,created_at) VALUES(?1,?2,?3,?4)",
        params![id, revision, serde_json::to_string(&document)?, timestamp],
    )?;
    for asset_id in asset_ids(&document) {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
            [&asset_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::new("ASSET_MISSING", "课件引用了尚未导入的素材").field(asset_id));
        }
        transaction.execute(
            "INSERT INTO revision_assets(lesson_id,revision,asset_id) VALUES(?1,?2,?3)",
            params![id, revision, asset_id],
        )?;
    }
    transaction.commit()?;
    drop(db);
    get_lesson(state, &id, Some(revision))
}

pub fn delete_lesson(state: &AppState, lesson_id: &str) -> AppResult<()> {
    let db = state.connection()?;
    state.ensure_writable()?;
    db.execute("DELETE FROM lessons WHERE id=?1", [lesson_id])?;
    Ok(())
}

/// Save the renderer's complete local copy, including unfinished inputs, without
/// rereading the conflicting saved head. Both snapshots share the existing game
/// identity mapper; all rows and resource references commit together or roll back.
pub fn save_lesson_copy(
    state: &AppState,
    mut documents: Vec<Value>,
    layouts: Vec<crate::identities::RevisionIdentityPlan>,
) -> AppResult<Value> {
    if documents.is_empty() || documents.len() > 2 {
        return Err(AppError::validation("另存须提供草稿及可选准备快照"));
    }
    let source_id = documents[0]["id"].as_str().unwrap_or_default().to_owned();
    let game_id = documents[0]["gameId"].clone();
    let draft_revision = documents.len() as u64;
    let copy_name = documents
        .last()
        .and_then(|document| document["name"].as_str())
        .unwrap_or_default()
        .trim()
        .to_owned();
    if copy_name.is_empty() || copy_name.chars().count() > 80 {
        return Err(AppError::validation("副本名称需为1～80字符"));
    }
    for (index, document) in documents.iter().enumerate() {
        validate_document(document)?;
        if document["id"].as_str() != Some(source_id.as_str())
            || document["gameId"] != game_id
            || document["revision"].as_u64() != Some(index as u64 + 1)
        {
            return Err(AppError::validation("另存快照的身份、游戏或修订关系不一致"));
        }
    }
    let digest = crate::assets::sha256(&serde_json::to_vec(&documents)?);
    let plan = crate::identities::PackageIdentityPlan {
        lesson_sha256: digest.clone(),
        revisions: layouts,
    };
    let id = crate::identities::remap_revisions(
        &mut documents,
        &source_id,
        &digest,
        &plan,
        &HashMap::new(),
    )?;
    let mut db = state.connection()?;
    state.ensure_writable()?;
    let transaction = db.transaction()?;
    let draft = documents.last().unwrap();
    let prepared = (documents.len() == 2).then_some(1_u64);
    let timestamp = now();
    transaction.execute("INSERT INTO lessons(id,name,game_id,draft_revision,prepared_revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
        params![id, draft["name"].as_str(), draft["gameId"].as_str(), draft_revision, prepared, timestamp])?;
    for document in &mut documents {
        document.as_object_mut().unwrap().remove("preparedRevision");
        let revision = document["revision"].as_u64().unwrap();
        transaction.execute(
            "INSERT INTO revisions(lesson_id,revision,document,created_at) VALUES(?1,?2,?3,?4)",
            params![id, revision, serde_json::to_string(document)?, timestamp],
        )?;
        for asset in asset_ids(document) {
            // Metadata must already belong to the managed library. Missing bytes
            // remain repairable draft problems, matching ordinary save semantics.
            read_asset_meta(&transaction, &asset)?;
            transaction.execute(
                "INSERT INTO revision_assets(lesson_id,revision,asset_id) VALUES(?1,?2,?3)",
                params![id, revision, asset],
            )?;
        }
    }
    transaction.commit()?;
    get_lesson_from(&db, &id, None)
}

/// Game validation is performed by the registered JS game module. Native validation
/// independently checks draft errors, revision CAS and every required physical asset.
pub fn mark_prepared(
    state: &AppState,
    lesson_id: &str,
    revision: u64,
    required: &[String],
    allow_historical: bool,
) -> AppResult<Value> {
    let document = get_lesson(state, lesson_id, Some(revision)).map_err(|error| {
        // The source may be deleted after an export captured an independent
        // snapshot. This is a pointer-publication conflict, not invalid input.
        if error.code == "VALIDATION_ERROR" {
            AppError::new("REVISION_CONFLICT", "源课件或修订已变化，未更新准备状态")
        } else {
            error
        }
    })?;
    if document
        .get("draftInputs")
        .and_then(Value::as_object)
        .is_some_and(|fields| !fields.is_empty())
    {
        return Err(AppError::validation("当前仍有未完成输入，请先修正"));
    }
    let name = document["name"].as_str().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::validation("课件名需为 1～80 字符"));
    }
    for id in required {
        crate::assets::read_asset_bytes(state, id)?;
    }
    let db = state.connection()?;
    state.ensure_writable()?;
    let changed = db.execute(
        "UPDATE lessons SET prepared_revision=?2 WHERE id=?1 AND (draft_revision=?2 OR (?3 AND prepared_revision=?2))",
        params![lesson_id, revision, allow_historical],
    )?;
    if changed != 1 {
        return Err(AppError::new(
            "REVISION_CONFLICT",
            "检查期间课件已变化，请重新检查",
        ));
    }
    drop(db);
    get_lesson(state, lesson_id, Some(revision))
}

pub fn read_asset_meta(db: &Connection, id: &str) -> AppResult<AudioAsset> {
    db.query_row(
        "SELECT id,mime_type,byte_length,duration_ms,sha256,name,kind,sample_rate,channels,frame_count FROM assets WHERE id=?1",
        [id],
        |row| {
            Ok(AudioAsset {
                asset_id: row.get(0)?,
                mime_type: row.get(1)?,
                byte_length: row.get(2)?,
                duration_ms: row.get(3)?,
                sha256: row.get(4)?,
                data_url: None,
                name: row.get(5)?,
                kind: row.get(6)?,
                sample_rate: row.get(7)?,
                channels: row.get(8)?,
                frame_count: row.get(9)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::new("ASSET_MISSING", "素材不存在").field(id))
}

pub fn put_task(db: &Connection, task: &TaskRecord) -> AppResult<()> {
    let previous: Option<(String, String)> = db
        .query_row(
            "SELECT state,record FROM tasks WHERE id=?1",
            [&task.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mut next = task.clone();
    if let Some((state, record)) = previous {
        if matches!(
            state.as_str(),
            "completed" | "partialFailure" | "failed" | "cancelled" | "interrupted"
        ) {
            return Ok(());
        }
        let stored: TaskRecord = serde_json::from_str(&record)?;
        if stored.cancel_requested {
            next.cancel_requested = true;
            next.state = if next.state == "interrupted" {
                "interrupted"
            } else if is_terminal_task(&next.state) {
                "cancelled"
            } else {
                "cancelling"
            }
            .into();
        }
    }
    db.execute(
        "UPDATE tasks SET state=?2,record=?3,updated_at=?4 WHERE id=?1",
        params![
            next.task_id,
            next.state,
            serde_json::to_string(&next)?,
            next.updated_at
        ],
    )?;
    Ok(())
}

pub fn get_task(state: &AppState, id: &str) -> AppResult<TaskRecord> {
    let db = state.connection()?;
    let body: String = db
        .query_row("SELECT record FROM tasks WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::validation("任务不存在"))?;
    let mut task: TaskRecord = serde_json::from_str(&body)?;
    // State is in a separate column so crash recovery can update it atomically.
    task.state = db.query_row("SELECT state FROM tasks WHERE id=?1", [id], |row| {
        row.get(0)
    })?;
    Ok(task)
}

/// Copy a task's actual immutable input inside its creation transaction. Separate
/// ownership survives deleting the source lesson; all input audio shares the task
/// pin owner and is released together with its outputs when the record is cleared.
pub fn save_task_input(db: &Connection, task: &TaskRecord) -> AppResult<()> {
    let document = match (&task.lesson_id, task.input_revision) {
        (Some(lesson), Some(revision)) => get_lesson_from(db, lesson, Some(revision))?,
        (None, None) => return Ok(()),
        _ => return Err(AppError::validation("配音任务必须同时指定课件和输入修订号")),
    };
    db.execute(
        "INSERT INTO task_inputs(task_id,document) VALUES(?1,?2)",
        params![task.task_id, serde_json::to_string(&document)?],
    )?;
    for id in asset_ids(&document) {
        db.execute(
            "INSERT OR IGNORE INTO pins(owner_id,asset_id) VALUES(?1,?2)",
            params![task.task_id, id],
        )?;
    }
    Ok(())
}

/// Fetch the full input only for an explicit result view, never in task polling.
/// Old development tasks can still read their genuine revision; if it was already
/// deleted, return a readable error rather than reconstructing an invented lesson.
pub fn get_task_input(state: &AppState, task_id: &str) -> AppResult<Value> {
    let db = state.connection()?;
    let snapshot: Option<String> = db
        .query_row(
            "SELECT document FROM task_inputs WHERE task_id=?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(snapshot) = snapshot {
        return Ok(serde_json::from_str(&snapshot)?);
    }
    let input: Option<(Option<String>, Option<u64>)> = db
        .query_row(
            "SELECT lesson_id,input_revision FROM tasks WHERE id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((lesson, revision)) = input else {
        return Err(AppError::validation("配音任务不存在"));
    };
    if let (Some(lesson), Some(revision)) = (lesson, revision) {
        if let Ok(document) = get_lesson_from(&db, &lesson, Some(revision)) {
            return Ok(document);
        }
    }
    Err(AppError::new(
        "TASK_INPUT_UNAVAILABLE",
        "此任务没有可恢复的原始课件快照；现有声音成果仍可试听。",
    ))
}

/// Terminal candidates remain protected until the teacher explicitly clears their
/// record. Revisions keep independent references, so clearing never damages a lesson.
pub fn clear_task(state: &AppState, id: &str) -> AppResult<()> {
    let mut db = state.connection()?;
    state.ensure_writable()?;
    let tx = db.transaction()?;
    let status: String = tx
        .query_row("SELECT state FROM tasks WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::validation("任务不存在"))?;
    if !is_terminal_task(&status) {
        return Err(AppError::validation("请先取消并等待任务停止，再清除记录"));
    }
    tx.execute("DELETE FROM pins WHERE owner_id=?1", [id])?;
    tx.execute("DELETE FROM tasks WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(())
}

pub fn is_terminal_task(status: &str) -> bool {
    matches!(
        status,
        "completed" | "partialFailure" | "failed" | "cancelled" | "interrupted"
    )
}

/// Editor/undo/runtime ownership is explicit, so cache cleanup cannot race an
/// unsaved 500 ms edit. A retained revision also pins all its declared assets
/// independently: deleting the source lesson must not invalidate an export that
/// already owns that snapshot. Replacing one owner's set is atomic and idempotent.
pub fn retain_assets(
    state: &AppState,
    owner_id: &str,
    ids: &[String],
    lesson_id: Option<&str>,
    revision: Option<u64>,
) -> AppResult<()> {
    Uuid::parse_str(owner_id).map_err(|_| AppError::validation("会话标识不是有效 UUID"))?;
    if ids.len() > 2000 {
        return Err(AppError::validation("会话素材数量超过上限"));
    }
    let owner = format!("session:{owner_id}");
    let mut db = state.connection()?;
    state.ensure_writable()?;
    let tx = db.transaction()?;
    tx.execute("DELETE FROM pins WHERE owner_id=?1", [&owner])?;
    tx.execute("DELETE FROM revision_pins WHERE owner_id=?1", [&owner])?;
    tx.execute("DELETE FROM session_inputs WHERE owner_id=?1", [&owner])?;
    let mut retained: HashSet<String> = ids.iter().cloned().collect();
    match (lesson_id, revision) {
        (Some(lesson), Some(revision)) => {
            let document = get_lesson_from(&tx, lesson, Some(revision))?;
            retained.extend(asset_ids(&document));
            // Independent storage survives cascading source deletion. These are
            // process-owned fixed inputs, never restored as a live editor head.
            tx.execute("INSERT INTO session_inputs(owner_id,lesson_id,revision,document) VALUES(?1,?2,?3,?4)",
                params![owner, lesson, revision, serde_json::to_string(&document)?])?;
            tx.execute(
                "INSERT INTO revision_pins(owner_id,lesson_id,revision) VALUES(?1,?2,?3)",
                params![owner, lesson, revision],
            )?;
        }
        (None, None) => {}
        _ => {
            return Err(AppError::validation(
                "保留课件快照时必须同时提供课件和修订号",
            ))
        }
    }
    for id in &retained {
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(AppError::new("ASSET_MISSING", "需要保留的素材不存在").field(id));
        }
        tx.execute(
            "INSERT INTO pins(owner_id,asset_id) VALUES(?1,?2)",
            params![owner, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn release_assets(state: &AppState, owner_id: &str) -> AppResult<()> {
    Uuid::parse_str(owner_id).map_err(|_| AppError::validation("会话标识不是有效 UUID"))?;
    let owner = format!("session:{owner_id}");
    let mut db = state.connection()?;
    state.ensure_writable()?;
    let tx = db.transaction()?;
    tx.execute("DELETE FROM pins WHERE owner_id=?1", [&owner])?;
    tx.execute("DELETE FROM revision_pins WHERE owner_id=?1", [&owner])?;
    tx.execute("DELETE FROM session_inputs WHERE owner_id=?1", [&owner])?;
    tx.commit()?;
    Ok(())
}

/// Read only a native-retained immutable input; callers cannot supply replacement
/// JSON or borrow another lesson/revision through an owner identifier.
pub fn retained_document(
    db: &Connection,
    owner_id: &str,
    lesson_id: &str,
    revision: u64,
) -> AppResult<Value> {
    Uuid::parse_str(owner_id).map_err(|_| AppError::validation("快照会话标识不是有效 UUID"))?;
    let body: Option<String> = db.query_row(
        "SELECT document FROM session_inputs WHERE owner_id=?1 AND lesson_id=?2 AND revision=?3",
        params![format!("session:{owner_id}"), lesson_id, revision], |row| row.get(0)).optional()?;
    serde_json::from_str(&body.ok_or_else(|| {
        AppError::new(
            "EXPORT_INPUT_UNAVAILABLE",
            "本次导出快照已释放，请重新选择版本",
        )
    })?)
    .map_err(AppError::from)
}

/// Recheck the immutable source at the IPC boundary. Enabled assets must belong
/// to this source; game-specific validity and decoding remain the module's job.
pub fn validate_export_source(
    state: &AppState,
    lesson_id: &str,
    revision: u64,
    owner_id: Option<&str>,
    required: &[String],
) -> AppResult<Value> {
    let db = state.connection()?;
    let document = if let Some(owner) = owner_id {
        retained_document(&db, owner, lesson_id, revision)?
    } else {
        let current = get_lesson_from(&db, lesson_id, Some(revision))?;
        if current["preparedRevision"].as_u64() != Some(revision) {
            return Err(AppError::validation("请先检查所选版本，或重新固定导出快照"));
        }
        current
    };
    drop(db);
    validate_document(&document)?;
    if document
        .get("draftInputs")
        .and_then(Value::as_object)
        .is_some_and(|inputs| !inputs.is_empty())
    {
        return Err(AppError::validation("所选版本仍有未完成输入，请先修正"));
    }
    let name = document["name"].as_str().unwrap_or_default().trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::validation("课件名需为1～80字符"));
    }
    let declared = asset_ids(&document);
    for asset in required {
        if !declared.contains(asset) {
            return Err(AppError::validation("必需声音不属于所选导出版本").field(asset));
        }
        crate::assets::read_asset_bytes(state, asset)?;
    }
    Ok(document)
}

/// Only live heads, explicit sessions and task inputs retain old revisions. Undo
/// stores its own content and asset pins; unrelated autosaves do not grow forever.
pub fn prune_revisions(db: &Connection) -> AppResult<()> {
    db.execute("DELETE FROM revisions WHERE NOT EXISTS(SELECT 1 FROM lessons l WHERE l.id=revisions.lesson_id AND (l.draft_revision=revisions.revision OR l.prepared_revision=revisions.revision)) AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.lesson_id=revisions.lesson_id AND t.input_revision=revisions.revision) AND NOT EXISTS(SELECT 1 FROM revision_pins p WHERE p.lesson_id=revisions.lesson_id AND p.revision=revisions.revision)", [])?;
    Ok(())
}

const APP_KEYS: &[&str] = &[
    "materials",
    "commonWords",
    "preferences",
    "importHistory",
    "exportHistory",
];
pub fn get_app_data(state: &AppState, key: &str) -> AppResult<Value> {
    if !APP_KEYS.contains(&key) {
        return Err(AppError::validation("未知的应用数据键"));
    }
    let db = state.connection()?;
    let body: Option<String> = db
        .query_row("SELECT value FROM app_data WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    body.map(|text| serde_json::from_str(&text).map_err(AppError::from))
        .unwrap_or(Ok(Value::Null))
}
pub fn set_app_data(state: &AppState, key: &str, value: Value) -> AppResult<()> {
    let body = serde_json::to_string(&value)?;
    if body.len() > 20_000_000 {
        return Err(AppError::validation("应用数据超过 20 MB 限制"));
    }
    validate_app_data(key, &value)?;
    let db = state.connection()?;
    state.ensure_writable()?;
    db.execute("INSERT INTO app_data(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, body])?;
    Ok(())
}

/// Validate shared teaching records at the native boundary and staged restore.
/// Game snapshots stay opaque here: each game owns its own draft/run rules.
/// Validation never rewrites source snapshots or fabricates missing review data.
pub(crate) fn validate_app_data(key: &str, value: &Value) -> AppResult<()> {
    if !APP_KEYS.contains(&key) {
        return Err(AppError::validation("未知的应用数据键"));
    }
    if key == "commonWords" {
        return validate_teaching_entries(value, None);
    }
    if key != "materials" {
        return Ok(());
    }
    let collections = value
        .as_array()
        .ok_or_else(|| AppError::validation("材料集必须为列表"))?;
    let mut ids = HashSet::new();
    for collection in collections {
        checked_teaching_text(collection, "id", true, 1, usize::MAX)?;
        if !ids.insert(collection["id"].as_str().unwrap_or_default()) {
            return Err(AppError::validation("材料集标识重复"));
        }
        checked_teaching_text(collection, "name", true, 1, 80)?;
        for field in ["original", "createdAt", "updatedAt"] {
            if !collection[field].is_string() {
                return Err(AppError::validation(format!("材料集 {field} 应为文本")));
            }
        }
        if !collection["revision"]
            .as_u64()
            .is_some_and(|value| value > 0)
        {
            return Err(AppError::validation("材料集修订号应为正整数"));
        }
        validate_teaching_entries(&collection["entries"], Some(2_000))?;
    }
    Ok(())
}

/// Count teaching limits as Unicode code points after trimming, matching the UI.
/// Only teaching fields are bounded; an original dictionary explanation may be
/// longer than its teacher-adapted meaning and must survive a lossless round trip.
fn checked_teaching_text(
    object: &Value,
    field: &str,
    required: bool,
    minimum: usize,
    maximum: usize,
) -> AppResult<()> {
    let label = match field {
        "english" => "英文",
        "meaning" => "中文释义",
        "partOfSpeech" => "词性",
        "unit" => "单元",
        "tag" => "标签",
        "name" => "名称",
        "id" => "标识",
        _ => field,
    };
    let Some(value) = object.get(field) else {
        return if required {
            Err(AppError::validation(format!("缺少{label}")).field(field))
        } else {
            Ok(())
        };
    };
    let text = value
        .as_str()
        .ok_or_else(|| AppError::validation(format!("{label}应为文本")).field(field))?;
    let length = text.trim().chars().count();
    if !(minimum..=maximum).contains(&length)
        || text
            .chars()
            .any(|ch| matches!(ch, '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'))
    {
        return Err(AppError::validation(format!(
            "{label}的长度或控制字符不符合要求"
        )).field(field));
    }
    Ok(())
}

/// A material/common-word list contains confirmed teaching values, unlike the
/// intentionally incomplete values allowed in a game's saved editing draft.
fn validate_teaching_entries(value: &Value, maximum: Option<usize>) -> AppResult<()> {
    let entries = value
        .as_array()
        .ok_or_else(|| AppError::validation("教学条目必须为列表"))?;
    if maximum.is_some_and(|maximum| entries.len() > maximum) {
        return Err(AppError::validation(
            "材料集最多 2,000 条，不会截取部分内容",
        ));
    }
    let mut ids = HashSet::new();
    for entry in entries {
        for (field, required, minimum, maximum) in [
            ("id", true, 1, usize::MAX),
            ("english", true, 1, 120),
            ("meaning", true, 0, 200),
            ("partOfSpeech", false, 0, 40),
            ("unit", false, 0, 80),
        ] {
            checked_teaching_text(entry, field, required, minimum, maximum)?;
        }
        if !ids.insert(entry["id"].as_str().unwrap_or_default()) {
            return Err(AppError::validation("教学条目标识重复"));
        }
        if !entry["priority"].is_boolean()
            || entry
                .get("confirmed")
                .is_some_and(|value| !value.is_boolean())
            || entry
                .get("entryType")
                .is_some_and(|value| !matches!(value.as_str(), Some("word" | "phrase")))
        {
            return Err(AppError::validation("教学条目的重点、确认状态或类型无效"));
        }
        if let Some(value) = entry.get("tags") {
            let tags = value
                .as_array()
                .ok_or_else(|| AppError::validation("标签应为文本列表"))?;
            let mut distinct = HashSet::new();
            for tag in tags {
                let text = tag
                    .as_str()
                    .ok_or_else(|| AppError::validation("标签应为文本"))?;
                checked_teaching_text(&json!({"tag":text}), "tag", true, 0, 24)?;
                if !text.trim().is_empty() {
                    distinct.insert(text.trim());
                }
            }
            if distinct.len() > 10 {
                return Err(AppError::validation("标签最多 10 个"));
            }
        }
        if let Some(source) = entry.get("meaningSource") {
            validate_meaning_source(source)?;
        }
        if let Some(source) = entry.get("source") {
            validate_teaching_source(source)?;
        }
    }
    Ok(())
}

/// Material evidence is optional for legacy entries but complete when supplied.
/// Validate only its shape: a saved future rule version is historical evidence,
/// not a request to rerun today's matcher or manufacture missing provenance.
fn validate_teaching_source(source: &Value) -> AppResult<()> {
    if !source["name"].is_string()
        || source
            .get("original")
            .is_some_and(|value| !value.is_string())
        || ["line", "position"].iter().any(|field| {
            source
                .get(*field)
                .is_some_and(|value| !value.as_f64().is_some_and(f64::is_finite))
        })
    {
        return Err(AppError::validation("材料来源的名称、原文或位置格式无效"));
    }
    let Some(analysis) = source.get("analysis") else {
        return Ok(());
    };
    if analysis["ruleId"].as_str() != Some("platform.material.match")
        || ["ruleVersion", "functionWordsVersion"].iter().any(|field| {
            !analysis[*field].as_f64().is_some_and(|value| {
                (1.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0
            })
        })
    {
        return Err(AppError::validation("材料整理依据的规则或版本无效"));
    }
    let dictionaries = analysis["dictionaryVersions"]
        .as_array()
        .ok_or_else(|| AppError::validation("材料整理词库版本应为列表"))?;
    if dictionaries.iter().any(|dictionary| {
        ["name", "version"].iter().any(|field| {
            !dictionary[*field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        })
    }) {
        return Err(AppError::validation("材料整理词库缺少名称或版本"));
    }
    Ok(())
}

/// Review describes the original candidate, independently of teacher acceptance.
/// Optional legacy fields remain absent; accepting a reference cannot upgrade it
/// to reviewed, and source evidence is not constrained by teaching display limits.
fn validate_meaning_source(source: &Value) -> AppResult<()> {
    for field in ["name", "version", "english"] {
        if !source[field].is_string() {
            return Err(AppError::validation("义项来源缺少名称、版本或原词"));
        }
    }
    for field in ["originalMeaning", "originalPartOfSpeech"] {
        if source.get(field).is_some_and(|value| !value.is_string()) {
            return Err(AppError::validation("原义项来源应为文本"));
        }
    }
    if source
        .get("teacherRevised")
        .is_some_and(|value| !value.is_boolean())
        || source
            .get("reviewStatus")
            .is_some_and(|value| !matches!(value.as_str(), Some("reviewed-sense" | "reference")))
        || source
            .get("candidateSource")
            .is_some_and(|value| !matches!(value.as_str(), Some("dictionary" | "common")))
    {
        return Err(AppError::validation("义项来源校对状态或候选类型无效"));
    }
    if let Some(value) = source.get("acceptedFields") {
        let fields = value
            .as_array()
            .ok_or_else(|| AppError::validation("接受字段应为列表"))?;
        let mut distinct = HashSet::new();
        for field in fields {
            if !matches!(field.as_str(), Some("meaning" | "partOfSpeech"))
                || !distinct.insert(field.as_str().unwrap_or_default())
            {
                return Err(AppError::validation("接受字段无效或重复"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Conflict recovery must save the renderer's unsaved values and both snapshots
    /// atomically, including old-only identities and raw invalid field text.
    #[test]
    fn local_conflict_copy_keeps_both_snapshots_and_rolls_back_missing_resource() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let source_id = Uuid::new_v4().to_string();
        let card_id = Uuid::new_v4().to_string();
        let original = save_lesson(&state, json!({"id":source_id,"name":"原课","gameId":"fixture-game","dataVersion":1,"gameData":{"card":{"id":card_id,"text":card_id}},"revision":0}), 0).unwrap();
        let mut remote = original.clone();
        remote["name"] = json!("另一页面已保存");
        save_lesson(&state, remote.clone(), 1).unwrap();
        let prepared = original.clone();
        let mut local = prepared.clone();
        local["name"] = json!("本地副本");
        local["revision"] = json!(2);
        local["gameData"]["unsaved"] = json!("教师未落盘修改");
        local["draftInputs"] =
            json!({format!("{card_id}.answer"):{"objectId":card_id,"raw":"-","message":"未完成"}});
        let layouts = || {
            vec![1, 2]
                .into_iter()
                .map(|revision| crate::identities::RevisionIdentityPlan {
                    revision,
                    layout: crate::identities::IdentityLayout {
                        identities: vec!["/gameData/card/id".into()],
                        ..Default::default()
                    },
                })
                .collect::<Vec<_>>()
        };
        let copy =
            save_lesson_copy(&state, vec![prepared.clone(), local.clone()], layouts()).unwrap();
        let copy_id = copy["id"].as_str().unwrap();
        assert_ne!(copy_id, source_id);
        assert_eq!(copy["preparedRevision"], 1);
        assert_eq!(copy["name"], "本地副本");
        assert_eq!(
            get_lesson(&state, copy_id, Some(1)).unwrap()["name"],
            "原课"
        );
        assert_eq!(copy["gameData"]["unsaved"], "教师未落盘修改");
        let mapped = copy["gameData"]["card"]["id"].as_str().unwrap();
        assert_ne!(mapped, card_id);
        assert_eq!(copy["gameData"]["card"]["text"], card_id);
        assert_eq!(copy["draftInputs"][format!("{mapped}.answer")]["raw"], "-");
        assert_eq!(
            get_lesson(&state, copy_id, Some(1)).unwrap()["gameData"]["card"]["id"],
            mapped
        );
        assert_eq!(
            get_lesson(&state, &source_id, None).unwrap()["name"],
            "另一页面已保存"
        );
        local["gameData"]["audio"] = json!({"assetId":Uuid::new_v4().to_string()});
        assert_eq!(
            save_lesson_copy(&state, vec![prepared, local], layouts())
                .unwrap_err()
                .code,
            "ASSET_MISSING"
        );
        assert_eq!(
            list_lessons(&state).unwrap().len(),
            2,
            "failed copy leaves no partial lesson"
        );
    }
    /// Later saves and preparation move the head; fixed native input remains
    /// independently readable even after its source is deleted and cache cleaned.
    #[test]
    fn retained_export_is_independent_of_later_save_prepare_and_source_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(900),
            None,
            Some("retained-export-test"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let mut source = draft();
        source["gameData"] = json!({"voice":{"assetId":asset.asset_id},"text":"固定原文"});
        let fixed = save_lesson(&state, source, 0).unwrap();
        let id = fixed["id"].as_str().unwrap();
        let owner = Uuid::new_v4().to_string();
        retain_assets(&state, &owner, &[], Some(id), Some(1)).unwrap();
        let mut later = fixed.clone();
        later["gameData"]["text"] = json!("后来修改");
        save_lesson(&state, later, 1).unwrap();
        mark_prepared(&state, id, 2, std::slice::from_ref(&asset.asset_id), false).unwrap();
        assert_eq!(
            validate_export_source(
                &state,
                id,
                1,
                Some(&owner),
                std::slice::from_ref(&asset.asset_id),
            )
            .unwrap()["gameData"]["text"],
            "固定原文"
        );
        assert!(validate_export_source(&state, id, 2, Some(&owner), &[]).is_err());
        assert!(
            validate_export_source(&state, &Uuid::new_v4().to_string(), 1, Some(&owner), &[])
                .is_err()
        );
        let unrelated = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(1200),
            None,
            Some("unrelated-export-test"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        assert_eq!(
            validate_export_source(&state, id, 1, Some(&owner), &[unrelated.asset_id])
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
        delete_lesson(&state, id).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
        assert_eq!(
            validate_export_source(&state, id, 1, Some(&owner), &[asset.asset_id]).unwrap()
                ["gameData"]["text"],
            "固定原文"
        );
        release_assets(&state, &owner).unwrap();
        assert_eq!(
            validate_export_source(&state, id, 1, Some(&owner), &[])
                .unwrap_err()
                .code,
            "EXPORT_INPUT_UNAVAILABLE"
        );
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
    }

    fn teaching_entry() -> Value {
        json!({"id":"entry","english":"responsibility","meaning":"责任","priority":true})
    }
    fn material(entries: Vec<Value>) -> Value {
        json!([{"id":"material","name":"本周阅读","original":"Reading source","entries":entries,"revision":1,"createdAt":now(),"updatedAt":now()}])
    }

    #[test]
    fn shared_teaching_limits_count_unicode_and_failed_saves_preserve_prior_values() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let mut entry = teaching_entry();
        entry["partOfSpeech"] = json!("😀".repeat(40));
        entry["unit"] = json!("单".repeat(80));
        entry["tags"] = json!((0..10)
            .map(|index| format!("{}{}", "😀".repeat(23), index))
            .collect::<Vec<_>>());
        let valid = json!([entry.clone()]);
        set_app_data(&state, "commonWords", valid.clone()).unwrap();
        assert_eq!(get_app_data(&state, "commonWords").unwrap(), valid);
        for (field, value) in [
            ("english", json!("a".repeat(121))),
            ("meaning", json!("义".repeat(201))),
            ("partOfSpeech", json!("😀".repeat(41))),
            ("unit", json!("单".repeat(81))),
            (
                "tags",
                json!((0..11).map(|index| index.to_string()).collect::<Vec<_>>()),
            ),
            ("tags", json!(["😀".repeat(25)])),
            ("unit", json!("Unit\u{0001}1")),
        ] {
            let mut invalid = entry.clone();
            invalid[field] = value;
            assert_eq!(
                set_app_data(&state, "commonWords", json!([invalid]))
                    .unwrap_err()
                    .code,
                "VALIDATION_ERROR",
                "{field} must fail at the write boundary"
            );
            assert_eq!(get_app_data(&state, "commonWords").unwrap(), valid);
        }
        let mut empty_meaning = teaching_entry();
        empty_meaning["meaning"] = json!("");
        set_app_data(&state, "commonWords", json!([empty_meaning])).unwrap();
    }

    #[test]
    fn material_capacity_is_separate_from_game_size_and_never_truncates() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let entries = (0..2_000)
            .map(|index| {
                let mut entry = teaching_entry();
                entry["id"] = json!(format!("entry-{index}"));
                entry
            })
            .collect::<Vec<_>>();
        let valid = material(entries.clone());
        set_app_data(&state, "materials", valid.clone()).unwrap();
        assert_eq!(get_app_data(&state, "materials").unwrap(), valid);
        let mut over = entries;
        let mut extra = teaching_entry();
        extra["id"] = json!("entry-2000");
        over.push(extra);
        assert_eq!(
            set_app_data(&state, "materials", material(over))
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
        assert_eq!(get_app_data(&state, "materials").unwrap(), valid);
    }

    #[test]
    fn source_snapshots_roundtrip_without_upgrading_unknown_or_reference_review() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        for status in [None, Some("reference"), Some("reviewed-sense")] {
            let mut entry = teaching_entry();
            entry["confirmed"] = json!(true);
            entry["meaningSource"] = json!({
                "name":"原始词库","version":"1","english":"responsibility",
                "originalMeaning":"参考释文".repeat(100),"originalPartOfSpeech":"n.",
                "teacherRevised":true,"candidateSource":"common","acceptedFields":["meaning"]
            });
            if let Some(status) = status {
                entry["meaningSource"]["reviewStatus"] = json!(status);
            }
            let value = json!([entry.clone()]);
            set_app_data(&state, "commonWords", value.clone()).unwrap();
            assert_eq!(get_app_data(&state, "commonWords").unwrap(), value);
            let snapshot = material(vec![entry]);
            set_app_data(&state, "materials", snapshot.clone()).unwrap();
            assert_eq!(get_app_data(&state, "materials").unwrap(), snapshot);
        }
        let before = get_app_data(&state, "commonWords").unwrap();
        let mut invalid = before.clone();
        invalid[0]["meaningSource"]["reviewStatus"] = json!("teacher-confirmed");
        assert!(set_app_data(&state, "commonWords", invalid).is_err());
        let mut invalid = before.clone();
        invalid[0]["meaningSource"]["acceptedFields"] = json!(["meaning", "meaning"]);
        assert!(set_app_data(&state, "commonWords", invalid).is_err());
        assert_eq!(get_app_data(&state, "commonWords").unwrap(), before);
    }

    /// Both shared libraries retain historical matcher evidence exactly, while
    /// malformed optional metadata cannot poison a future game snapshot.
    #[test]
    fn material_analysis_is_optional_versioned_and_rejected_atomically_when_malformed() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let evidence = json!({
            "ruleId":"platform.material.match","ruleVersion":17,"functionWordsVersion":2,
            "dictionaryVersions":[{"name":"教师常用词","version":"teacher"}]
        });
        let wrap = |key: &str, entry: Value| {
            if key == "materials" {
                material(vec![entry])
            } else {
                json!([entry])
            }
        };
        for key in ["materials", "commonWords"] {
            for source in [
                None,
                Some(json!({"name":"旧材料"})),
                Some(
                    json!({"name":"阅读材料","original":"source","line":1,"position":0,"analysis":evidence}),
                ),
                Some(
                    json!({"name":"无词库命中","analysis":{"ruleId":"platform.material.match","ruleVersion":1,"functionWordsVersion":1,"dictionaryVersions":[]}}),
                ),
            ] {
                let mut entry = teaching_entry();
                if let Some(source) = source {
                    entry["source"] = source;
                }
                let value = wrap(key, entry);
                set_app_data(&state, key, value.clone()).unwrap();
                assert_eq!(get_app_data(&state, key).unwrap(), value);
            }
            let before = get_app_data(&state, key).unwrap();
            for (field, value) in [
                ("ruleId", json!("other.rule")),
                ("ruleVersion", json!(0)),
                ("ruleVersion", json!(1.5)),
                ("ruleVersion", json!(9_007_199_254_740_992_u64)),
                ("functionWordsVersion", json!(-1)),
                ("dictionaryVersions", json!(null)),
                ("dictionaryVersions", json!([{"name":"","version":"1"}])),
                ("dictionaryVersions", json!([{"name":"词库","version":1}])),
            ] {
                let mut entry = teaching_entry();
                entry["source"] = json!({"name":"阅读材料","analysis":evidence});
                entry["source"]["analysis"][field] = value;
                assert_eq!(
                    set_app_data(&state, key, wrap(key, entry))
                        .unwrap_err()
                        .code,
                    "VALIDATION_ERROR"
                );
                assert_eq!(get_app_data(&state, key).unwrap(), before);
            }
            for source in [
                json!(null),
                json!({"name":1}),
                json!({"name":"原文","position":"0"}),
                json!({"name":"原文","analysis":{}}),
            ] {
                let mut entry = teaching_entry();
                entry["source"] = source;
                assert!(set_app_data(&state, key, wrap(key, entry)).is_err());
                assert_eq!(get_app_data(&state, key).unwrap(), before);
            }
        }
    }

    #[test]
    fn malformed_shared_shapes_and_duplicate_identities_never_replace_valid_materials() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let valid = material(vec![teaching_entry()]);
        set_app_data(&state, "materials", valid.clone()).unwrap();
        for invalid in [
            json!({"entries":[]}),
            material(vec![json!("plain string")]),
            material(vec![teaching_entry(), teaching_entry()]),
        ] {
            assert!(set_app_data(&state, "materials", invalid).is_err());
            assert_eq!(get_app_data(&state, "materials").unwrap(), valid);
        }
    }

    fn draft() -> Value {
        json!({"id":Uuid::new_v4().to_string(),"name":"高中词汇","gameId":"word-beat","revision":0,"dataVersion":1,"gameData":{},"createdAt":now(),"updatedAt":now()})
    }
    #[test]
    fn additive_audio_metadata_migration_keeps_existing_v1_rows_readable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.sqlite3");
        {
            let legacy = Connection::open(&path).unwrap();
            legacy.execute_batch("CREATE TABLE assets(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,mime_type TEXT NOT NULL,byte_length INTEGER NOT NULL,duration_ms REAL NOT NULL,name TEXT,cache_key TEXT,created_at TEXT NOT NULL); INSERT INTO assets(id,sha256,mime_type,byte_length,duration_ms,created_at) VALUES('legacy','digest','audio/wav',100,10,'2026-10-20T00:00:00Z'); PRAGMA user_version=1;").unwrap();
        }
        let migrated = open_connection(&path).unwrap();
        let columns = migrated
            .prepare("PRAGMA table_info(assets)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap();
        assert!(columns.contains("sample_rate"));
        assert!(columns.contains("channels"));
        assert!(columns.contains("frame_count"));
        let metadata: (Option<u32>, Option<u32>, Option<u64>) = migrated
            .query_row(
                "SELECT sample_rate,channels,frame_count FROM assets WHERE id='legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(metadata, (None, None, None));
        assert_eq!(
            migrated
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    /// The engine itself reaches SQLITE_FULL under a private page budget. This
    /// exercises the real failing UPDATE and rollback, not a fabricated error
    /// value, and never consumes the host volume or changes another database.
    #[test]
    fn sqlite_page_budget_failure_keeps_saved_preferences_and_connection_usable() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let original = json!({"mode":"teacher", "value":"已保存"});
        set_app_data(&state, "preferences", original.clone()).unwrap();
        let pages: u64 = {
            let db = state.connection().unwrap();
            let pages = db
                .query_row("PRAGMA page_count", [], |row| row.get::<_, u64>(0))
                .unwrap();
            let limited = db
                .query_row(&format!("PRAGMA max_page_count={pages}"), [], |row| {
                    row.get::<_, u64>(0)
                })
                .unwrap();
            assert_eq!(limited, pages);
            pages
        };
        let error = set_app_data(
            &state,
            "preferences",
            json!({"value":"x".repeat(1_000_000)}),
        )
        .unwrap_err();
        assert_eq!(error.code, "SPACE_INSUFFICIENT");
        assert!(error.retryable);
        assert_eq!(get_app_data(&state, "preferences").unwrap(), original);
        {
            let db = state.connection().unwrap();
            assert_eq!(
                db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            db.query_row(
                &format!("PRAGMA max_page_count={}", pages + 1000),
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap();
        }
        set_app_data(&state, "preferences", json!({"value":"可重试"})).unwrap();
        assert_eq!(
            get_app_data(&state, "preferences").unwrap()["value"],
            "可重试"
        );
    }

    /// An unknown future schema is rejected before WAL/schema initialization.
    /// Byte equality proves this refusal preserves the original database; it is
    /// intentionally narrower than a failed arbitrary migration or power loss.
    #[test]
    fn unsupported_future_database_is_rejected_without_changing_original_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("library.sqlite3");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('保留原件'); PRAGMA user_version=2;").unwrap();
        }
        let original = std::fs::read(&path).unwrap();
        let error = match AppState::open(root) {
            Ok(_) => panic!("A newer database must not be opened for writing"),
            Err(error) => error,
        };
        assert_eq!(error.code, "UNSUPPORTED_VERSION");
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    /// Kill the real test subprocess with an actual SQLite transaction and an
    /// open staging file. Startup then uses the production recovery/cleanup path.
    /// The test covers this chosen pre-commit interruption, not physical power
    /// loss or every possible file/restore-directory swap instruction boundary.
    #[test]
    fn killed_process_recovers_uncommitted_write_and_retains_task_inputs_until_cleared() {
        use std::{
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        const CHILD_ROOT: &str = "ECG_NATIVE_CRASH_FIXTURE_ROOT";
        if let Some(directory) = std::env::var_os(CHILD_ROOT) {
            let directory = PathBuf::from(directory);
            assert_eq!(
                std::fs::read(directory.join("authorize-child")).unwrap(),
                b"isolated-native-crash-test"
            );
            let state = AppState::open(directory.join("library")).unwrap();
            let input = crate::assets::store_audio(
                &state,
                &crate::assets::test_pcm(600),
                None,
                Some("crash-input"),
                20_000_000,
                30_000.0,
                None,
            )
            .unwrap();
            let mut source = draft();
            source["gameData"] = json!({"assetId":input.asset_id, "originalText":"responsibility"});
            let document = save_lesson(&state, source, 0).unwrap();
            let mut tasks = Vec::new();
            for status in ["queued", "running", "cancelling"] {
                let task: TaskRecord = serde_json::from_value(json!({"taskId":Uuid::new_v4().to_string(),"kind":"speech","lessonId":document["id"],"inputRevision":1,"state":status,"stage":"声音制作","completed":0,"total":1,"results":[],"failures":[],"cancelRequested":status=="cancelling","createdAt":now(),"updatedAt":now()})).unwrap();
                let mut db = state.connection().unwrap();
                let tx = db.transaction().unwrap();
                tx.execute("INSERT INTO tasks(id,lesson_id,input_revision,kind,input_hash,state,record,updated_at) VALUES(?1,?2,1,'speech',?1,?3,?4,?5)", params![task.task_id,task.lesson_id,task.state,serde_json::to_string(&task).unwrap(),task.updated_at]).unwrap();
                save_task_input(&tx, &task).unwrap();
                tx.commit().unwrap();
                tasks.push(task);
            }
            let output = crate::assets::store_audio(
                &state,
                &crate::assets::test_pcm(750),
                None,
                Some("crash-output"),
                20_000_000,
                30_000.0,
                Some(&tasks[1].task_id),
            )
            .unwrap();
            delete_lesson(&state, document["id"].as_str().unwrap()).unwrap();
            set_app_data(&state, "preferences", json!({"value":"committed"})).unwrap();
            // These real files stand for work written before its metadata commit.
            // The open export handle is released by OS termination, not Rust Drop.
            let orphan_hash = crate::assets::sha256(b"uncommitted asset");
            std::fs::write(
                state.root.join("assets").join(&orphan_hash),
                b"uncommitted asset",
            )
            .unwrap();
            std::fs::write(
                state.root.join("tasks").join("unfinished.audio"),
                b"staging audio",
            )
            .unwrap();
            let mut staging =
                std::fs::File::create(state.root.join("tasks").join("unfinished.export")).unwrap();
            std::io::Write::write_all(&mut staging, b"unfinished classroom").unwrap();
            staging.sync_all().unwrap();
            std::fs::write(
                state.root.join("exports").join("verified.html"),
                b"verified classroom",
            )
            .unwrap();
            std::fs::write(directory.join("outside.txt"), b"outside data").unwrap();
            let mut db = state.connection().unwrap();
            db.execute_batch("PRAGMA cache_size=1; PRAGMA cache_spill=1;")
                .unwrap();
            let wal = state.root.join("library.sqlite3-wal");
            let wal_before = std::fs::metadata(&wal).unwrap().len();
            let tx = db.transaction().unwrap();
            tx.execute(
                "UPDATE app_data SET value=?1 WHERE key='preferences'",
                [json!({"value":format!("uncommitted{}", "x".repeat(100_000))}).to_string()],
            )
            .unwrap();
            let orphan_id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO assets(id,sha256,mime_type,byte_length,duration_ms,created_at) VALUES(?1,?2,'audio/wav',17,1,?3)", params![orphan_id, orphan_hash, now()]).unwrap();
            assert!(tx
                .query_row(
                    "SELECT value FROM app_data WHERE key='preferences'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap()
                .contains("uncommitted"));
            let wal_after = std::fs::metadata(wal).unwrap().len();
            assert!(
                wal_after > wal_before,
                "The fixture must spill actual uncommitted WAL frames"
            );
            let ready_partial = directory.join("ready.partial");
            std::fs::write(&ready_partial, json!({"tasks":tasks.iter().map(|task| &task.task_id).collect::<Vec<_>>(),"input":input.asset_id,"output":output.asset_id,"orphanId":orphan_id,"orphanHash":orphan_hash,"document":document,"walBeforeBytes":wal_before,"walAfterBytes":wal_after}).to_string()).unwrap();
            std::fs::rename(ready_partial, directory.join("ready.json")).unwrap();
            loop {
                std::hint::black_box((&tx, &staging));
                std::thread::park_timeout(Duration::from_secs(1));
            }
        }

        // This guard prevents a failed assertion/timeout from leaving a child or
        // open SQLite handle behind; it never owns a production application PID.
        struct CrashChild(std::process::Child);
        impl Drop for CrashChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("authorize-child"),
            b"isolated-native-crash-test",
        )
        .unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "database::tests::killed_process_recovers_uncommitted_write_and_retains_task_inputs_until_cleared", "--nocapture"])
            .env(CHILD_ROOT, temp.path()).stdout(Stdio::null()).stderr(Stdio::from(std::fs::File::create(temp.path().join("child-stderr.log")).unwrap()));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = CrashChild(command.spawn().unwrap());
        let ready = temp.path().join("ready.json");
        let deadline = Instant::now() + Duration::from_secs(15);
        while !ready.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Crash fixture exited before reaching the uncommitted transaction: {}",
                std::fs::read_to_string(temp.path().join("child-stderr.log")).unwrap_or_default()
            );
            assert!(
                Instant::now() < deadline,
                "Crash fixture did not reach its interruption point"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let fixture: Value = serde_json::from_slice(&std::fs::read(ready).unwrap()).unwrap();
        let root = temp.path().join("library");
        assert!(root.join("tasks").join("unfinished.export").exists());
        assert!(root
            .join("assets")
            .join(fixture["orphanHash"].as_str().unwrap())
            .exists());
        assert!(
            fixture["walAfterBytes"].as_u64().unwrap()
                > fixture["walBeforeBytes"].as_u64().unwrap()
        );
        {
            let observer = Connection::open_with_flags(
                root.join("library.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            assert_eq!(
                observer
                    .query_row(
                        "SELECT value FROM app_data WHERE key='preferences'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                json!({"value":"committed"}).to_string()
            );
        }
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        let state = AppState::open(root).unwrap();
        assert_eq!(
            get_app_data(&state, "preferences").unwrap(),
            json!({"value":"committed"})
        );
        assert!(list_lessons(&state).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(state.root.join("tasks")).unwrap().count(),
            0
        );
        assert!(!state
            .root
            .join("assets")
            .join(fixture["orphanHash"].as_str().unwrap())
            .exists());
        assert!(read_asset_meta(
            &state.connection().unwrap(),
            fixture["orphanId"].as_str().unwrap()
        )
        .is_err());
        assert_eq!(
            std::fs::read(state.root.join("exports").join("verified.html")).unwrap(),
            b"verified classroom"
        );
        assert_eq!(
            std::fs::read(temp.path().join("outside.txt")).unwrap(),
            b"outside data"
        );
        for task in fixture["tasks"].as_array().unwrap() {
            let id = task.as_str().unwrap();
            assert_eq!(get_task(&state, id).unwrap().state, "interrupted");
            assert_eq!(get_task_input(&state, id).unwrap(), fixture["document"]);
        }
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 0);
        for field in ["input", "output"] {
            assert!(crate::assets::read_asset(&state, fixture[field].as_str().unwrap()).is_ok());
        }
        for task in fixture["tasks"].as_array().unwrap() {
            clear_task(&state, task.as_str().unwrap()).unwrap();
        }
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 2);
        assert_eq!(
            state
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM task_inputs", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        for field in ["input", "output"] {
            assert!(crate::assets::read_asset(&state, fixture[field].as_str().unwrap()).is_err());
        }
    }
    /// Exercise the real SQLite/serde save-return boundary in an isolated library.
    /// Optional evidence paths are test-only: absence still runs a valid native
    /// roundtrip, while the UI proof supplies a full formally-created lesson.
    #[test]
    fn production_content_roundtrips_without_changing_teaching_data() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let input = std::env::var("ECG_PRODUCTION_PROOF_INPUT")
            .ok()
            .map(|path| serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap())
            .unwrap_or_else(draft);
        let first = save_lesson(&state, input.clone(), 0).unwrap();
        let second = save_lesson(&state, first.clone(), 1).unwrap();
        assert_eq!(first["revision"], 1);
        assert_eq!(second["revision"], 2);
        for field in ["name", "gameData", "draftInputs"] {
            assert_eq!(input[field], first[field]);
            assert_eq!(first[field], second[field]);
        }
        assert_eq!(
            get_lesson(&state, first["id"].as_str().unwrap(), Some(1)).unwrap(),
            first
        );
        if let Ok(path) = std::env::var("ECG_PRODUCTION_PROOF_OUTPUT") {
            std::fs::write(
                path,
                serde_json::to_vec_pretty(&json!({"first":first,"second":second})).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn stale_save_does_not_overwrite_and_draft_errors_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let mut document = draft();
        document["draftInputs"] = json!({"rounds":{"raw":"-","message":"请输入数字"}});
        let saved = save_lesson(&state, document.clone(), 0).unwrap();
        assert_eq!(saved["revision"], 1);
        assert!(saved["draftInputs"].is_object());
        assert_eq!(
            save_lesson(&state, document, 0).unwrap_err().code,
            "REVISION_CONFLICT"
        );
        assert!(mark_prepared(&state, saved["id"].as_str().unwrap(), 1, &[], false).is_err());
    }
    #[test]
    fn foreign_asset_failure_rolls_back_entire_revision() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let mut document = draft();
        document["gameData"] = json!({"assetId":"not-registered"});
        assert!(save_lesson(&state, document, 0).is_err());
        assert!(list_lessons(&state).unwrap().is_empty());
    }

    #[test]
    fn prepared_history_is_explicit_and_pruning_preserves_live_heads() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let first = save_lesson(&state, draft(), 0).unwrap();
        let id = first["id"].as_str().unwrap();
        mark_prepared(&state, id, 1, &[], false).unwrap();
        let second = save_lesson(&state, first.clone(), 1).unwrap();
        let _third = save_lesson(&state, second, 2).unwrap();
        assert_eq!(
            mark_prepared(&state, id, 1, &[], false).unwrap_err().code,
            "REVISION_CONFLICT"
        );
        mark_prepared(&state, id, 1, &[], true).unwrap();
        prune_revisions(&state.connection().unwrap()).unwrap();
        assert!(get_lesson(&state, id, Some(1)).is_ok());
        assert!(get_lesson(&state, id, Some(2)).is_err());
        assert!(get_lesson(&state, id, Some(3)).is_ok());
    }

    #[test]
    fn cancellation_is_monotonic_and_terminal_tasks_ignore_late_completion() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let mut task = TaskRecord {
            task_id: Uuid::new_v4().to_string(),
            kind: "speech".into(),
            lesson_id: None,
            input_revision: None,
            state: "running".into(),
            stage: "声音制作".into(),
            completed: 0,
            total: 1,
            results: vec![],
            failures: vec![],
            cancel_requested: false,
            created_at: now(),
            updated_at: now(),
            retry_of: None,
        };
        let db = state.connection().unwrap();
        db.execute("INSERT INTO tasks(id,kind,input_hash,state,record,updated_at) VALUES(?1,'speech','test','running',?2,?3)",params![task.task_id,serde_json::to_string(&task).unwrap(),now()]).unwrap();
        task.cancel_requested = true;
        task.state = "cancelling".into();
        put_task(&db, &task).unwrap();
        task.cancel_requested = false;
        task.state = "completed".into();
        put_task(&db, &task).unwrap();
        drop(db);
        assert_eq!(get_task(&state, &task.task_id).unwrap().state, "cancelled");
        put_task(&state.connection().unwrap(), &task).unwrap();
        assert_eq!(get_task(&state, &task.task_id).unwrap().state, "cancelled");
    }

    #[test]
    fn stale_renderer_data_epoch_cannot_write_after_restore() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let before = state.data_epoch.load(Ordering::SeqCst);
        state.check_data_epoch(Some(before)).unwrap();
        state.data_epoch.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            state.check_data_epoch(Some(before)).unwrap_err().code,
            "DATA_REPLACED"
        );
    }

    #[test]
    fn startup_epochs_are_process_local_nonzero_and_exact_for_javascript() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first = AppState::open(first.path().to_owned()).unwrap();
        let second = AppState::open(second.path().to_owned()).unwrap();
        let before = first.data_epoch.load(Ordering::SeqCst);
        assert!((1..=MAX_DATA_EPOCH).contains(&before));
        assert_ne!(before, second.data_epoch.load(Ordering::SeqCst));
        assert_eq!(
            first.check_data_epoch(None).unwrap_err().code,
            "DATA_REPLACED"
        );
        first.replace_data_epoch();
        let after = first.data_epoch.load(Ordering::SeqCst);
        assert_ne!(before, after);
        assert!((1..=MAX_DATA_EPOCH).contains(&after));
    }

    #[test]
    fn missing_registered_file_keeps_new_draft_but_blocks_preparation() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(900),
            None,
            None,
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let mut document = draft();
        document["gameData"] = json!({"assetId":asset.asset_id});
        let saved = save_lesson(&state, document, 0).unwrap();
        std::fs::remove_file(crate::assets::asset_path(&state, &asset.sha256).unwrap()).unwrap();
        let mut changed = saved;
        changed["name"] = json!("文件缺损后仍保存的新编辑");
        let saved = save_lesson(&state, changed, 1).unwrap();
        assert_eq!(saved["revision"], 2);
        assert_eq!(
            mark_prepared(
                &state,
                saved["id"].as_str().unwrap(),
                2,
                &[asset.asset_id],
                false
            )
            .unwrap_err()
            .code,
            "ASSET_MISSING"
        );
    }

    #[test]
    fn retained_revision_assets_survive_source_deletion_until_each_owner_releases() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let first_asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(900),
            None,
            Some("prepared-sound"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let second_asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(1200),
            None,
            Some("draft-sound"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let mut first = draft();
        first["gameData"] = json!({"sound":{"assetId":first_asset.asset_id}});
        let first = save_lesson(&state, first, 0).unwrap();
        let lesson_id = first["id"].as_str().unwrap();
        let mut second = first.clone();
        second["gameData"] = json!({"sound":{"assetId":second_asset.asset_id}});
        save_lesson(&state, second, 1).unwrap();
        let prepared_owner = Uuid::new_v4().to_string();
        let draft_owner = Uuid::new_v4().to_string();
        // Even empty explicit ID lists must capture every reference in the fixed
        // revision. The source deletion then removes both revision_assets rows.
        retain_assets(&state, &prepared_owner, &[], Some(lesson_id), Some(1)).unwrap();
        retain_assets(&state, &draft_owner, &[], Some(lesson_id), Some(2)).unwrap();
        delete_lesson(&state, lesson_id).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 0);
        assert!(crate::assets::read_asset(&state, &first_asset.asset_id).is_ok());
        assert!(crate::assets::read_asset(&state, &second_asset.asset_id).is_ok());
        release_assets(&state, &prepared_owner).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
        assert!(crate::assets::read_asset(&state, &first_asset.asset_id).is_err());
        assert!(crate::assets::read_asset(&state, &second_asset.asset_id).is_ok());
        release_assets(&state, &draft_owner).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
        assert!(crate::assets::list_assets(&state).unwrap().is_empty());
    }
}
