//! Safe self-contained lesson packages and full-library backups.
//! Every referenced file is checked; a missing resource cannot be hidden by omitting
//! it from the manifest. Imported game data never becomes executable native code.
//! Author: ahui.
use crate::{
    assets::{
        asset_path, audio_information, detect_mime, read_asset_bytes, read_limited, sha256,
        AudioInformation,
    },
    database::{asset_ids, get_lesson_from, now, validate_document, AppState},
    error::{AppError, AppResult},
    identities::{remap_revisions, PackageIdentityPlan},
    model::{AudioAsset, ExportResult},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Cursor, Read, Write},
};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

// Import and export share the same on-disk contract. Compressed size alone is
// insufficient: highly compressible PCM must still fit the receiver's budget.
const MAX_COMPRESSED: u64 = 200_000_000;
const MAX_UNPACKED: u64 = 500_000_000;
const MAX_ITEMS: usize = 2000;
const MAX_MANIFEST: usize = 2_000_000;
const MAX_LESSON: usize = 10_000_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageAsset {
    asset_id: String,
    path: String,
    mime_type: String,
    byte_length: u64,
    duration_ms: f64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channels: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frame_count: Option<u64>,
    /// Decoder evidence is transient and never affects source-package identity.
    /// Old manifests keep their original optional-field representation for dedup.
    #[serde(skip)]
    verified_audio: Option<AudioInformation>,
}
impl PackageAsset {
    /// Earlier V1 development packages omitted provenance. Preserve a supplied
    /// category; for those old files choose a limit that can contain the validated
    /// audio instead of pretending a known musical/voice provenance exists.
    fn effective_kind(&self) -> &str {
        self.kind.as_deref().unwrap_or(
            if self.duration_ms > 30_000.0 || self.byte_length > 20_000_000 {
                "music"
            } else {
                "recording"
            },
        )
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    game_id: String,
    minimum_platform_version: String,
    runtime_version: u32,
    source_lesson_id: String,
    generated_at: String,
    lesson_sha256: String,
    assets: Vec<PackageAsset>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LessonPackage {
    lesson_id: String,
    name: String,
    game_id: String,
    draft_revision: u64,
    prepared_revision: Option<u64>,
    revisions: Vec<Value>,
}

/// Reject Windows aliases before extraction, including NTFS streams and names that
/// differ only by case or trailing dots. The returned normalized key is for duplicate checks.
pub fn checked_archive_path(name: &str) -> AppResult<String> {
    if name.is_empty() || name.contains('\0') || name.contains(':') || name.starts_with(['/', '\\'])
    {
        return Err(AppError::validation("包内路径不安全"));
    }
    let name = name.replace('\\', "/");
    let mut normalized = Vec::new();
    for segment in name.trim_end_matches('/').split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.chars().any(char::is_control)
        {
            return Err(AppError::validation("包内路径越界或包含控制字符"));
        }
        let clean = segment.trim_end_matches(['.', ' ']);
        if clean.is_empty() {
            return Err(AppError::validation("包内路径名称无效"));
        }
        let base = clean
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((base.starts_with("COM") || base.starts_with("LPT"))
                && base.len() == 4
                && base.as_bytes()[3].is_ascii_digit());
        if device {
            return Err(AppError::validation("包内路径包含 Windows 保留设备名"));
        }
        if clean.chars().any(|character| "<>\"|?*".contains(character)) {
            return Err(AppError::validation("包内路径包含非法字符"));
        }
        normalized.push(clean.to_lowercase());
    }
    Ok(normalized.join("/"))
}

/// Read entries under actual decompressed-byte budgets. No path is written to disk
/// here, so even an adversarial archive cannot escape a temporary directory.
pub fn check_archive(
    bytes: &[u8],
    maximum_unpacked: u64,
    maximum_items: usize,
    strict: bool,
) -> AppResult<BTreeMap<String, Vec<u8>>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| AppError::validation("ZIP 容器损坏或无法读取"))?;
    if archive.len() > maximum_items {
        return Err(AppError::validation("压缩包文件数量超过上限"));
    }
    let mut names = HashSet::new();
    let mut files = BTreeMap::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| AppError::validation("压缩包条目损坏或加密"))?;
        let normalized = checked_archive_path(entry.name())?;
        if !names.insert(normalized.clone()) {
            return Err(AppError::validation("压缩包包含规范化后重名路径"));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::validation("压缩包不能包含符号链接"));
        }
        if entry.is_dir() {
            continue;
        }
        if strict
            && !(normalized == "manifest.json"
                || normalized == "lesson.json"
                || normalized.starts_with("assets/")
                || normalized == "attribution.txt"
                || normalized == "license.txt")
        {
            return Err(AppError::validation("课件包包含未知文件或可执行内容"));
        }
        if entry.size() > maximum_unpacked.saturating_sub(total) {
            return Err(AppError::validation("压缩包解压大小超过上限"));
        }
        let mut data = Vec::new();
        entry
            .by_ref()
            .take(maximum_unpacked.saturating_sub(total) + 1)
            .read_to_end(&mut data)
            .map_err(|_| AppError::validation("压缩条目读取失败"))?;
        total = total.saturating_add(data.len() as u64);
        if total > maximum_unpacked {
            return Err(AppError::validation("实际解压内容超过上限"));
        }
        files.insert(normalized, data);
    }
    Ok(files)
}

/// Bounded archive contents plus their independently verified source digest.
type LoadedPackage = (Manifest, LessonPackage, BTreeMap<String, Vec<u8>>, String);

fn load_package(state: &AppState, token: &str) -> AppResult<LoadedPackage> {
    let bytes = read_limited(&crate::files::selected_path(state, token)?, MAX_COMPRESSED)?;
    let files = check_archive(&bytes, MAX_UNPACKED, MAX_ITEMS, true)?;
    let manifest_bytes = files
        .get("manifest.json")
        .ok_or_else(|| AppError::validation("课件包缺少清单"))?;
    if manifest_bytes.len() > MAX_MANIFEST {
        return Err(AppError::validation("包清单超过 2 MB"));
    }
    let mut manifest: Manifest = serde_json::from_slice(manifest_bytes)?;
    if manifest.format_version != 1
        || ![1, 2, 3].contains(&manifest.runtime_version)
        || semver::Version::parse(&manifest.minimum_platform_version)
            .map(|minimum| minimum > semver::Version::new(1, 0, 0))
            .unwrap_or(true)
    {
        return Err(AppError::new(
            "UNSUPPORTED_VERSION",
            "课件包需要当前软件不支持的格式、平台或运行核心版本",
        ));
    }
    let lesson_bytes = files
        .get("lesson.json")
        .ok_or_else(|| AppError::validation("课件包缺少教学内容"))?;
    if lesson_bytes.len() > MAX_LESSON || sha256(lesson_bytes) != manifest.lesson_sha256 {
        return Err(AppError::new("ASSET_INVALID", "课件内容大小或校验值不符"));
    }
    let lesson: LessonPackage = serde_json::from_slice(lesson_bytes)?;
    if lesson.game_id != manifest.game_id
        || lesson.lesson_id != manifest.source_lesson_id
        || lesson.revisions.is_empty()
        || lesson.revisions.len() > 2
    {
        return Err(AppError::validation("课件包身份或快照结构不一致"));
    }
    let mut revisions = HashSet::new();
    let mut referenced = HashSet::new();
    for document in &lesson.revisions {
        validate_document(document)?;
        if document["id"] != lesson.lesson_id || document["gameId"] != lesson.game_id {
            return Err(AppError::validation("快照身份与课件包不一致"));
        }
        let revision = document["revision"]
            .as_u64()
            .filter(|revision| *revision > 0)
            .ok_or_else(|| AppError::validation("快照缺少修订号"))?;
        if !revisions.insert(revision) {
            return Err(AppError::validation("课件包存在重复修订"));
        }
        referenced.extend(asset_ids(document));
    }
    if !revisions.contains(&lesson.draft_revision)
        || lesson
            .prepared_revision
            .is_some_and(|id| !revisions.contains(&id) || id > lesson.draft_revision)
    {
        return Err(AppError::validation("草稿或已准备指针没有对应快照"));
    }
    let expected_count = if lesson
        .prepared_revision
        .is_some_and(|r| r != lesson.draft_revision)
    {
        2
    } else {
        1
    };
    if revisions.len() != expected_count {
        return Err(AppError::validation("课件包包含没有对应指针的额外快照"));
    }
    let mut declared = HashSet::new();
    let mut declared_paths = HashSet::new();
    for asset in &mut manifest.assets {
        Uuid::parse_str(&asset.asset_id)
            .map_err(|_| AppError::validation("素材标识不是有效 UUID"))?;
        if !matches!(asset.effective_kind(), "speech" | "recording" | "music") {
            return Err(AppError::validation("素材用途不受支持"));
        }
        if !declared.insert(asset.asset_id.clone()) {
            return Err(AppError::validation("清单包含重复素材标识"));
        }
        let key = checked_archive_path(&asset.path)?;
        declared_paths.insert(key.clone());
        if !key.starts_with("assets/") {
            return Err(AppError::validation("素材路径必须位于 assets 目录"));
        }
        let contents = files.get(&key).ok_or_else(|| {
            AppError::new("ASSET_MISSING", "清单引用的素材未打包").field(&asset.asset_id)
        })?;
        if contents.len() as u64 != asset.byte_length || sha256(contents) != asset.sha256 {
            return Err(
                AppError::new("ASSET_INVALID", "包内素材大小或校验值不符").field(&asset.asset_id)
            );
        }
        if !matches!(asset.mime_type.as_str(), "audio/wav" | "audio/mpeg")
            || contents.len() > 50_000_000
            || detect_mime(contents)? != asset.mime_type
        {
            return Err(AppError::new("ASSET_INVALID", "素材类型或大小不受支持"));
        }
        let max_ms = if asset.effective_kind() == "music" {
            600_000.0
        } else {
            30_000.0
        };
        if asset.effective_kind() != "music" && contents.len() > 20_000_000 {
            return Err(AppError::new("ASSET_INVALID", "录音或配音素材超过 20 MB"));
        }
        let actual = audio_information(contents, &asset.mime_type, max_ms)?;
        // Decoder tolerance accommodates small rounding differences, never an
        // invalid zero/negative duration even when the actual clip is very short.
        if !asset.duration_ms.is_finite()
            || asset.duration_ms <= 0.0
            || (actual.duration_ms - asset.duration_ms).abs() > 100.0
        {
            return Err(AppError::new("ASSET_INVALID", "声音真实时长与清单不符"));
        }
        if asset
            .sample_rate
            .is_some_and(|value| value != actual.sample_rate)
            || asset.channels.is_some_and(|value| value != actual.channels)
            || asset
                .frame_count
                .is_some_and(|value| value != actual.frame_count)
        {
            return Err(AppError::new("ASSET_INVALID", "声音采样信息与实际解码不符"));
        }
        asset.verified_audio = Some(actual);
    }
    if referenced != declared {
        return Err(AppError::new(
            "ASSET_MISSING",
            "课件引用与清单素材集合不一致",
        ));
    }
    if files.keys().any(|path| {
        !matches!(
            path.as_str(),
            "manifest.json" | "lesson.json" | "attribution.txt" | "license.txt"
        ) && !declared_paths.contains(path)
    }) {
        return Err(AppError::validation(
            "课件包包含未声明文件，不允许夹带额外内容",
        ));
    }
    let digest = sha256(lesson_bytes);
    Ok((manifest, lesson, files, digest))
}

pub fn inspect_package(state: &AppState, token: &str) -> AppResult<Value> {
    let (manifest, lesson, _, _) = load_package(state, token)?;
    let assets: Vec<AudioAsset> = manifest
        .assets
        .iter()
        .map(|entry| AudioAsset {
            asset_id: entry.asset_id.clone(),
            mime_type: entry.mime_type.clone(),
            byte_length: entry.byte_length,
            duration_ms: entry.duration_ms,
            sha256: entry.sha256.clone(),
            data_url: None,
            name: None,
            kind: entry.effective_kind().into(),
            sample_rate: entry.verified_audio.as_ref().map(|audio| audio.sample_rate),
            channels: entry.verified_audio.as_ref().map(|audio| audio.channels),
            frame_count: entry.verified_audio.as_ref().map(|audio| audio.frame_count),
        })
        .collect();
    Ok(json!({"manifest":manifest,"lesson":lesson,"assets":assets}))
}

/// Import all validated snapshots in one database transaction. Existing lesson IDs
/// are never overwritten, including a forged package claiming the same revision.
pub fn import_package(
    state: &AppState,
    token: &str,
    as_copy: bool,
    identity_plan: &PackageIdentityPlan,
) -> AppResult<Value> {
    // Only one archive is decoded/imported at a time, bounding memory and ensuring
    // two simultaneous imports cannot race their duplicate-record decision.
    let _serial = state
        .import_gate
        .lock()
        .map_err(|_| AppError::io("导入队列异常"))?;
    let (manifest, mut package, files, digest) = load_package(state, token)?;
    if identity_plan.lesson_sha256 != digest {
        return Err(AppError::validation(
            "预览后的课件包已变化，请重新选择并检查",
        ));
    }
    let asset_digest = sha256(&serde_json::to_vec(&manifest.assets)?);
    let mut db = state.connection()?;
    state.ensure_writable()?;
    if !as_copy {
        let existing: Option<(String, String)> = db.query_row("SELECT local_id,local_digest FROM imports WHERE source_id=?1 AND source_revision=?2 AND digest=?3 AND asset_digest=?4", params![package.lesson_id, package.draft_revision, digest, asset_digest], |row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((id, fingerprint)) = existing {
            // Historical import records are evidence of origin, not proof that
            // the latest local draft still contains that imported material.
            let candidate = get_lesson_from(&db, &id, None).ok();
            if candidate.as_ref().is_some_and(|value| {
                value["revision"].as_u64() == Some(package.draft_revision)
                    && value["preparedRevision"].as_u64() == package.prepared_revision
            }) && import_fingerprint(&db, &id, package.draft_revision, package.prepared_revision)
                .is_ok_and(|actual| actual == fingerprint)
            {
                return Ok(candidate.unwrap());
            }
        }
    }
    let mut replacements = HashMap::new();
    for asset in &manifest.assets {
        let existing: Option<String> = db
            .query_row(
                "SELECT id FROM assets WHERE sha256=?1 AND kind=?2 ORDER BY created_at LIMIT 1",
                params![asset.sha256, asset.effective_kind()],
                |row| row.get(0),
            )
            .optional()?;
        let new_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        replacements.insert(asset.asset_id.clone(), new_id.clone());
    }
    // Game declarations and both snapshots are checked before creating any assets
    // or rows. All revisions then use the same identity and resource mappings.
    let local_id = remap_revisions(
        &mut package.revisions,
        &package.lesson_id,
        &digest,
        identity_plan,
        &replacements,
    )?;
    for document in &package.revisions {
        validate_document(document)?;
    }
    let transaction = db.transaction()?;
    for asset in &manifest.assets {
        let new_id = &replacements[&asset.asset_id];
        let destination = asset_path(state, &asset.sha256)?;
        if crate::files::hash_file(&destination, 50_000_000)
            .map_or(true, |(_, hash)| hash != asset.sha256)
        {
            let temporary = state
                .root
                .join("tasks")
                .join(format!("{}.import", Uuid::new_v4()));
            let bytes = &files[&checked_archive_path(&asset.path)?];
            let written = (|| {
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                output.write_all(bytes)?;
                output.sync_all()?;
                drop(output);
                if crate::files::hash_file(&temporary, 50_000_000)?.1 != asset.sha256 {
                    return Err(AppError::new("ASSET_INVALID", "导入素材落盘校验失败"));
                }
                crate::files::replace_file(&temporary, &destination)
            })();
            if written.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            written?;
        }
        let audio = asset
            .verified_audio
            .as_ref()
            .ok_or_else(|| AppError::new("ASSET_INVALID", "导入声音尚未完成解码检查"))?;
        transaction.execute("INSERT OR IGNORE INTO assets(id,sha256,mime_type,byte_length,duration_ms,name,created_at,kind,sample_rate,channels,frame_count) VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10)",params![new_id,asset.sha256,asset.mime_type,asset.byte_length,asset.duration_ms,now(),asset.effective_kind(),audio.sample_rate,audio.channels,audio.frame_count])?;
        // A deduplicated sound from an earlier library may still lack decoder
        // metadata. Fill it from this import's verified bytes in the same transaction.
        transaction.execute(
            "UPDATE assets SET sample_rate=?2,channels=?3,frame_count=?4 WHERE id=?1",
            params![new_id, audio.sample_rate, audio.channels, audio.frame_count],
        )?;
    }
    transaction.execute("INSERT INTO lessons(id,name,game_id,draft_revision,prepared_revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![local_id,package.name,package.game_id,package.draft_revision,package.prepared_revision,now()])?;
    for document in &mut package.revisions {
        let original_revision = document["revision"].as_u64().unwrap_or(0);
        document["sourceLesson"] = json!({"id":package.lesson_id,"revision":original_revision});
        // The historical pointer is retained as a candidate only. Every start/export
        // still runs the current game's validator and native physical-resource checks.
        document
            .as_object_mut()
            .map(|object| object.remove("preparedRevision"));
        transaction.execute(
            "INSERT INTO revisions(lesson_id,revision,document,created_at) VALUES(?1,?2,?3,?4)",
            params![
                local_id,
                original_revision,
                serde_json::to_string(document)?,
                now()
            ],
        )?;
        for id in asset_ids(document) {
            transaction.execute(
                "INSERT INTO revision_assets(lesson_id,revision,asset_id) VALUES(?1,?2,?3)",
                params![local_id, original_revision, id],
            )?;
        }
    }
    let local_digest = import_fingerprint(
        &transaction,
        &local_id,
        package.draft_revision,
        package.prepared_revision,
    )?;
    transaction.execute("INSERT OR REPLACE INTO imports(source_id,source_revision,digest,asset_digest,local_id,local_digest) VALUES(?1,?2,?3,?4,?5,?6)",params![package.lesson_id,package.draft_revision,digest,asset_digest,local_id,local_digest])?;
    transaction.commit()?;
    get_lesson_from(&db, &local_id, None)
}

/// Fingerprint only retained immutable local snapshots. Transient prepared pointers
/// returned by get_lesson are excluded; the explicit pair is part of this digest.
fn import_fingerprint(
    db: &rusqlite::Connection,
    id: &str,
    draft: u64,
    prepared: Option<u64>,
) -> AppResult<String> {
    let mut numbers = vec![draft];
    if let Some(revision) = prepared {
        if revision != draft {
            numbers.push(revision);
        }
    }
    let mut documents = Vec::new();
    for revision in numbers {
        let text: String = db.query_row(
            "SELECT document FROM revisions WHERE lesson_id=?1 AND revision=?2",
            params![id, revision],
            |row| row.get(0),
        )?;
        documents.push(serde_json::from_str::<Value>(&text)?);
    }
    Ok(sha256(&serde_json::to_vec(
        &json!({"draftRevision":draft,"preparedRevision":prepared,"revisions":documents}),
    )?))
}

fn zip_files(files: &BTreeMap<String, Vec<u8>>) -> AppResult<Vec<u8>> {
    zip_files_with_limits(files, MAX_UNPACKED, MAX_ITEMS)
}

/// Check actual independent entries before compression, including the lesson,
/// manifest and attribution overhead. Explicit budgets allow small real-ZIP
/// boundary regressions without allocating a 500 MB test fixture.
fn zip_files_with_limits(
    files: &BTreeMap<String, Vec<u8>>,
    maximum_unpacked: u64,
    maximum_items: usize,
) -> AppResult<Vec<u8>> {
    if files.len() > maximum_items {
        return Err(AppError::validation("课件包文件数量超过上限"));
    }
    let mut total = 0_u64;
    for (name, bytes) in files {
        if bytes.len() as u64 > maximum_unpacked.saturating_sub(total) {
            return Err(AppError::validation("课件包解压大小超过上限"));
        }
        total += bytes.len() as u64;
        if name == "manifest.json" && bytes.len() > MAX_MANIFEST {
            return Err(AppError::validation("包清单超过 2 MB"));
        }
        if name == "lesson.json" && bytes.len() > MAX_LESSON {
            return Err(AppError::validation("课件内容超过 10 MB"));
        }
    }
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(AppError::zip)?;
        writer.write_all(bytes)?;
    }
    Ok(writer.finish().map_err(AppError::zip)?.into_inner())
}

/// Pins outlive reads/copies, so deleting the source lesson cannot invalidate export.
struct Pins<'a> {
    state: &'a AppState,
    owner: String,
}
impl Drop for Pins<'_> {
    fn drop(&mut self) {
        if let Ok(db) = self.state.connection() {
            let _ = db.execute("DELETE FROM pins WHERE owner_id=?1", [&self.owner]);
            let _ = db.execute("DELETE FROM revision_pins WHERE owner_id=?1", [&self.owner]);
        }
    }
}

pub fn export_package_retained(
    state: &AppState,
    lesson_id: &str,
    draft_revision: Option<u64>,
    prepared_revision: Option<u64>,
    snapshot_owners: &[String],
) -> AppResult<ExportResult> {
    let _operation = crate::database::WriteOperation::begin(state)?;
    let (name, bytes) = package_bytes_retained(
        state,
        lesson_id,
        draft_revision,
        prepared_revision,
        snapshot_owners,
    )?;
    crate::files::export_bytes(
        state,
        &format!("{name}.ecglesson"),
        &bytes,
        MAX_COMPRESSED as usize,
    )
}

#[cfg(test)]
fn package_bytes(
    state: &AppState,
    lesson_id: &str,
    requested_draft: Option<u64>,
    requested_prepared: Option<u64>,
) -> AppResult<(String, Vec<u8>)> {
    package_bytes_retained(state, lesson_id, requested_draft, requested_prepared, &[])
}

/// Optional owners refer only to independent inputs previously captured by native
/// retention. Draft and prepared owners follow that order, sharing one for equal
/// revisions; later edits or cascading source deletion cannot change their bytes.
fn package_bytes_retained(
    state: &AppState,
    lesson_id: &str,
    requested_draft: Option<u64>,
    requested_prepared: Option<u64>,
    snapshot_owners: &[String],
) -> AppResult<(String, Vec<u8>)> {
    let owner = Uuid::new_v4().to_string();
    // Establish cleanup before acquiring the database guard. If pin insertion
    // fails midway, the guard drops first and cleanup can lock SQLite safely.
    let _pins = Pins {
        state,
        owner: owner.clone(),
    };
    let db = state.connection()?;
    state.ensure_writable()?;
    let draft = if let Some(owner) = snapshot_owners.first() {
        crate::database::retained_document(
            &db,
            owner,
            lesson_id,
            requested_draft.ok_or_else(|| AppError::validation("固定快照导出必须指定草稿修订"))?,
        )?
    } else {
        get_lesson_from(&db, lesson_id, requested_draft)?
    };
    let draft_revision = draft["revision"].as_u64().unwrap_or(0);
    let prepared_revision = if requested_draft.is_some() {
        requested_prepared
    } else {
        draft["preparedRevision"].as_u64()
    };
    if prepared_revision.is_some_and(|revision| revision == 0 || revision > draft_revision) {
        return Err(AppError::validation("已准备修订不得晚于本次草稿修订"));
    }
    if !snapshot_owners.is_empty()
        && snapshot_owners.len()
            != if prepared_revision.is_some_and(|revision| revision != draft_revision) {
                2
            } else {
                1
            }
    {
        return Err(AppError::validation("导出快照数量与修订关系不一致"));
    }
    let mut revisions = vec![draft.clone()];
    if let Some(revision) = prepared_revision {
        if revision != draft_revision {
            revisions.push(if let Some(owner) = snapshot_owners.get(1) {
                crate::database::retained_document(&db, owner, lesson_id, revision)?
            } else {
                get_lesson_from(&db, lesson_id, Some(revision))?
            });
        }
    }
    let mut ids = HashSet::new();
    for document in &revisions {
        ids.extend(asset_ids(document));
    }
    for id in &ids {
        db.execute(
            "INSERT INTO pins(owner_id,asset_id) VALUES(?1,?2)",
            params![owner, id],
        )?;
    }
    for document in &revisions {
        db.execute(
            "INSERT INTO revision_pins(owner_id,lesson_id,revision) VALUES(?1,?2,?3)",
            params![owner, lesson_id, document["revision"].as_u64()],
        )?;
    }
    drop(db);
    let mut files = BTreeMap::new();
    let mut unpacked = 0_u64;
    let mut assets = Vec::new();
    let mut sorted: Vec<_> = ids.into_iter().collect();
    sorted.sort();
    for id in sorted {
        let (asset, bytes) = read_asset_bytes(state, &id)?;
        let path = format!("assets/{}", asset.sha256);
        // Different logical assets may share identical bytes. Budget the actual
        // ZIP path once and stop before retaining unbounded compressible audio.
        if !files.contains_key(&path) {
            if files.len() >= MAX_ITEMS
                || bytes.len() as u64 > MAX_UNPACKED.saturating_sub(unpacked)
            {
                return Err(AppError::validation("课件包素材数量或解压大小超过上限"));
            }
            unpacked += bytes.len() as u64;
            files.insert(path.clone(), bytes);
        }
        assets.push(PackageAsset {
            asset_id: asset.asset_id,
            path,
            mime_type: asset.mime_type,
            byte_length: asset.byte_length,
            duration_ms: asset.duration_ms,
            sha256: asset.sha256,
            kind: Some(asset.kind),
            sample_rate: asset.sample_rate,
            channels: asset.channels,
            frame_count: asset.frame_count,
            verified_audio: None,
        });
    }
    let package = LessonPackage {
        lesson_id: lesson_id.into(),
        name: draft["name"].as_str().unwrap_or("课件").into(),
        game_id: draft["gameId"].as_str().unwrap_or_default().into(),
        draft_revision,
        prepared_revision,
        revisions,
    };
    let lesson_bytes = serde_json::to_vec(&package)?;
    let manifest = Manifest {
        format_version: 1,
        game_id: package.game_id.clone(),
        minimum_platform_version: "1.0.0".into(),
        // Tempo settings require runtime 3; older cores must reject rather than silently play at the wrong speed.
        runtime_version: if package.revisions.iter().any(|revision| {
            let music = &revision["gameData"]["music"];
            !music["playbackRate"].is_null()
                || !music["preservePitch"].is_null()
                || (!music["sync"].is_null()
                    && music["sync"]["bpm"] != revision["gameData"]["bpm"]["value"])
        }) {
            3
        } else if package
            .revisions
            .iter()
            .any(|revision| revision["gameData"]["soundMode"] == "chorus")
        {
            2
        } else {
            1
        },
        source_lesson_id: lesson_id.into(),
        generated_at: now(),
        lesson_sha256: sha256(&lesson_bytes),
        assets,
    };
    files.insert("lesson.json".into(), lesson_bytes);
    files.insert("manifest.json".into(), serde_json::to_vec(&manifest)?);
    // Attribution travels with editable content even on an offline destination.
    // Keep upstream/full template grants intact rather than paraphrasing rights.
    files.insert(
        "attribution.txt".into(),
        include_bytes!("../../resources/ATTRIBUTION.txt").to_vec(),
    );
    files.insert(
        "license.txt".into(),
        format!(
            "This editable package contains teaching data and media, not executable player code.\nTeaching content and generated audio retain their own rights; use of this software does not relicense them under GPL.\nEnglish Class Games software: GPL-3.0-only. A newly exported HTML carries player source and notices.\n\n{}\n\n{}\n\nECDICT\n\n{}\n\nEnglish Class Games slogan templates\n\n{}",
            include_str!("../../COPYRIGHT"),
            include_str!("../../LICENSE"),
            include_str!("../../resources/dictionary/LICENSE-ECDICT.txt"),
            include_str!("../../resources/LICENSE-SLOGAN-TEMPLATES.txt"),
        )
        .into_bytes(),
    );
    let bytes = zip_files(&files)?;
    if bytes.len() as u64 > MAX_COMPRESSED {
        return Err(AppError::validation("课件包超过 200 MB"));
    }
    Ok((package.name, bytes))
}

/// Full-library backups use streaming I/O and their own schema and budgets.
pub fn export_backup(state: &AppState) -> AppResult<ExportResult> {
    crate::backups::export_backup(state)
}

/// Restore validates a staged whole library before switching the live connection.
pub fn restore_backup(state: &AppState, token: &str, data_epoch: Option<u64>) -> AppResult<()> {
    crate::backups::restore_backup(state, token, data_epoch)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This fixture's game declares one internal identity. Tests exercise real
    /// archive validation and SQL while keeping native code independent of games.
    fn import_fixture_package(state: &AppState, token: &str, as_copy: bool) -> AppResult<Value> {
        let (_, lesson, _, digest) = load_package(state, token)?;
        let plan = PackageIdentityPlan {
            lesson_sha256: digest,
            revisions: lesson
                .revisions
                .iter()
                .map(|document| crate::identities::RevisionIdentityPlan {
                    revision: document["revision"].as_u64().unwrap(),
                    layout: crate::identities::IdentityLayout {
                        identities: vec!["/gameData/entry/id".into()],
                        ..Default::default()
                    },
                })
                .collect(),
        };
        import_package(state, token, as_copy, &plan)
    }
    #[test]
    fn windows_path_aliases_and_traversal_are_rejected() {
        for bad in [
            "../a",
            "..\\a",
            "C:\\a",
            "\\\\server\\a",
            "assets/a:stream",
            "assets/CON.wav",
        ] {
            assert!(checked_archive_path(bad).is_err(), "{bad}");
        }
        assert_eq!(
            checked_archive_path("Assets/A.wav. ").unwrap(),
            "assets/a.wav"
        );
    }
    #[test]
    fn duplicate_paths_are_detected_after_windows_normalization() {
        let mut files = BTreeMap::new();
        files.insert("assets/a.wav".into(), vec![1]);
        files.insert("assets/A.wav".into(), vec![2]);
        let bytes = zip_files(&files).unwrap();
        assert!(check_archive(&bytes, 1000, 10, false).is_err());
    }
    #[test]
    fn actual_decompression_budget_is_enforced() {
        let files = BTreeMap::from([("data.txt".into(), vec![b'x'; 1000])]);
        let bytes = zip_files(&files).unwrap();
        assert!(check_archive(&bytes, 999, 2, false).is_err());
    }

    #[test]
    fn export_counts_actual_unpacked_headers_and_matches_import_boundaries() {
        // Repetitive audio-like bytes compress very well. The actual content and
        // all three supporting entries must nevertheless fit the same budget.
        let files = BTreeMap::from([
            ("assets/sound".into(), vec![0; 4096]),
            ("manifest.json".into(), vec![b' '; 256]),
            ("attribution.txt".into(), vec![b'a'; 64]),
            ("license.txt".into(), vec![b'l'; 64]),
        ]);
        let exact = 4480;
        let bytes = zip_files_with_limits(&files, exact, 4).unwrap();
        assert!(bytes.len() < exact as usize);
        assert_eq!(check_archive(&bytes, exact, 4, true).unwrap(), files);
        assert!(zip_files_with_limits(&files, exact - 1, 4).is_err());
        assert!(check_archive(&bytes, exact - 1, 4, true).is_err());
    }

    #[test]
    fn export_accepts_2000_actual_files_and_rejects_the_next() {
        let mut files: BTreeMap<String, Vec<u8>> = (0..MAX_ITEMS)
            .map(|index| (format!("assets/{index}"), Vec::new()))
            .collect();
        let bytes = zip_files(&files).unwrap();
        assert_eq!(
            check_archive(&bytes, MAX_UNPACKED, MAX_ITEMS, true)
                .unwrap()
                .len(),
            MAX_ITEMS
        );
        files.insert("assets/overflow".into(), Vec::new());
        assert_eq!(zip_files(&files).unwrap_err().code, "VALIDATION_ERROR");
    }

    #[test]
    fn export_preserves_manifest_and_lesson_byte_limits() {
        for (name, maximum) in [("manifest.json", MAX_MANIFEST), ("lesson.json", MAX_LESSON)] {
            let mut files = BTreeMap::from([(name.into(), vec![b' '; maximum])]);
            // Check both edges with real ZIP output, without a 500 MB allocation.
            let bytes = zip_files(&files).unwrap();
            assert_eq!(
                check_archive(&bytes, MAX_UNPACKED, MAX_ITEMS, true).unwrap()[name].len(),
                maximum
            );
            files.get_mut(name).unwrap().push(b' ');
            assert_eq!(zip_files(&files).unwrap_err().code, "VALIDATION_ERROR");
        }
    }

    fn source_package(root: &std::path::Path) -> (AppState, Vec<u8>, String) {
        source_package_with_duration(root, 900)
    }

    /// Exercise the real storage/export path with a selected PCM duration. Short
    /// clips are needed to expose metadata errors hidden by the 100 ms tolerance.
    fn source_package_with_duration(
        root: &std::path::Path,
        duration_ms: u32,
    ) -> (AppState, Vec<u8>, String) {
        let state = AppState::open(root.to_owned()).unwrap();
        let asset = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(duration_ms),
            Some("responsibility".into()),
            Some("test-speech"),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let id = Uuid::new_v4().to_string();
        let entry_id = Uuid::new_v4().to_string();
        let first = crate::database::save_lesson(&state,json!({"id":id,"name":"高中复习","gameId":"word-beat","dataVersion":1,"gameData":{"entry":{"id":entry_id,"assetId":asset.asset_id,"english":entry_id},"text":"responsibility"}}),0).unwrap();
        crate::database::mark_prepared(&state, &id, 1, &[asset.asset_id], false).unwrap();
        let mut invalid = first;
        invalid["draftInputs"] = json!({
            "rounds":{"raw":"-","message":"请输入数字"},
            format!("{entry_id}.rounds"):{"raw":entry_id,"message":"请校对数字","objectId":entry_id}
        });
        crate::database::save_lesson(&state, invalid, 1).unwrap();
        let bytes = package_bytes(&state, &id, Some(2), Some(1)).unwrap().1;
        (state, bytes, id)
    }

    #[test]
    fn zero_and_negative_manifest_durations_reject_real_short_audio_before_import() {
        let temp = tempfile::tempdir().unwrap();
        let (_source, bytes, _) = source_package_with_duration(&temp.path().join("source"), 50);
        let original = check_archive(&bytes, MAX_UNPACKED, MAX_ITEMS, true).unwrap();
        for duration in [50, 0, -1] {
            let mut files = original.clone();
            let mut manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
            assert_eq!(manifest["assets"][0]["frameCount"], 800);
            manifest["assets"][0]["durationMs"] = json!(duration);
            files.insert(
                "manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            );
            let file = temp.path().join(format!("duration-{duration}.ecglesson"));
            std::fs::write(&file, zip_files(&files).unwrap()).unwrap();
            let target = AppState::open(temp.path().join(format!("target-{duration}"))).unwrap();
            target.selected.lock().unwrap().insert("short".into(), file);
            if duration > 0 {
                inspect_package(&target, "short").unwrap();
                import_fixture_package(&target, "short", true).unwrap();
                assert_eq!(
                    crate::assets::list_assets(&target).unwrap()[0].duration_ms,
                    50.0
                );
            } else {
                assert_eq!(
                    inspect_package(&target, "short").unwrap_err().code,
                    "ASSET_INVALID"
                );
                assert_eq!(
                    import_fixture_package(&target, "short", true)
                        .unwrap_err()
                        .code,
                    "ASSET_INVALID"
                );
                assert!(crate::database::list_lessons(&target).unwrap().is_empty());
                assert!(crate::assets::list_assets(&target).unwrap().is_empty());
                assert_eq!(
                    std::fs::read_dir(target.root.join("assets"))
                        .unwrap()
                        .count(),
                    0
                );
            }
        }
    }

    #[test]
    fn editable_export_carries_full_source_and_template_grants() {
        let temp = tempfile::tempdir().unwrap();
        let (_, bytes, _) = source_package(temp.path());
        let files = check_archive(&bytes, 500_000_000, 2000, true).unwrap();
        assert_eq!(
            files["attribution.txt"],
            include_bytes!("../../resources/ATTRIBUTION.txt")
        );
        let license = String::from_utf8(files["license.txt"].clone()).unwrap();
        // Data/media are not relicensed by using the exporter; the complete
        // software license accompanies the package without asserting ownership.
        assert!(license.contains("Teaching content and generated audio retain their own rights"));
        assert!(license.contains("GPL-3.0-only"));
        assert!(license.contains(include_str!("../../LICENSE")));
        assert!(license.contains(include_str!(
            "../../resources/dictionary/LICENSE-ECDICT.txt"
        )));
        assert!(license.contains(include_str!("../../resources/LICENSE-SLOGAN-TEMPLATES.txt")));
    }

    /// Import the shipped TypeScript-generated examples through real native ZIP,
    /// identity, SQLite and audio services, then re-export and import them again.
    /// Every library lives under a fresh temporary directory; no user database or
    /// system voice installation is involved. An optional evidence destination
    /// retains only the resulting report and re-exported packages for inspection.
    #[test]
    fn shipped_examples_cross_the_native_package_boundary_and_roundtrip() {
        let examples = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
        let temp = tempfile::tempdir().unwrap();
        let evidence_path =
            std::env::var_os("ECG_NATIVE_RELEASE_EVIDENCE").map(std::path::PathBuf::from);
        let mut reports = Vec::new();
        for (mode, filename, expected_audio) in [
            ("voiced", "高中单词节拍-配音跟读.ecglesson", 9),
            ("teacher", "高中单词节拍-文字领读.ecglesson", 1),
            ("chorus", "高中单词节拍-学生自主齐读.ecglesson", 1),
            ("tempo", "单词节拍-保音高变速校准.ecglesson", 1),
        ] {
            let source_path = examples.join(filename).canonicalize().unwrap();
            let source_bytes = std::fs::read(&source_path).unwrap();
            let plan: PackageIdentityPlan = serde_json::from_slice(
                &std::fs::read(examples.join(format!("validation/{mode}.identity.json"))).unwrap(),
            )
            .unwrap();
            let target = AppState::open(temp.path().join(format!("{mode}-first"))).unwrap();
            target
                .selected
                .lock()
                .unwrap()
                .insert("source".into(), source_path);
            let (manifest, original, original_files, digest) =
                load_package(&target, "source").unwrap();
            assert_eq!(digest, plan.lesson_sha256);
            assert_eq!(manifest.assets.len(), expected_audio);
            inspect_package(&target, "source").unwrap();
            let imported = import_package(&target, "source", true, &plan).unwrap();
            let id = imported["id"].as_str().unwrap();
            assert_ne!(id, original.lesson_id);
            assert_eq!(imported["revision"], 1);
            assert_eq!(imported["preparedRevision"], 1);
            assert_eq!(imported["gameId"], original.game_id);
            for revision in &plan.revisions {
                let source = original
                    .revisions
                    .iter()
                    .find(|item| item["revision"] == revision.revision)
                    .unwrap();
                let local =
                    crate::database::get_lesson(&target, id, Some(revision.revision)).unwrap();
                for pointer in &revision.layout.identities {
                    assert_ne!(source.pointer(pointer), local.pointer(pointer), "{pointer}");
                    assert!(local.pointer(pointer).and_then(Value::as_str).is_some());
                }
            }
            for asset in &manifest.assets {
                // The release sample uses explicit imported recordings. Successful
                // native decode is not evidence of WinRT English synthesis.
                assert!(matches!(asset.effective_kind(), "recording" | "music"));
                let imported_asset = crate::assets::list_assets(&target)
                    .unwrap()
                    .into_iter()
                    .find(|item| item.sha256 == asset.sha256)
                    .unwrap();
                let (metadata, bytes) =
                    crate::assets::read_asset_bytes(&target, &imported_asset.asset_id).unwrap();
                assert_eq!(metadata.kind, asset.effective_kind());
                assert_eq!(
                    bytes,
                    original_files[&checked_archive_path(&asset.path).unwrap()]
                );
            }
            assert_eq!(
                import_package(&target, "source", false, &plan).unwrap()["id"],
                id
            );
            let (_, reexported) = package_bytes(&target, id, Some(1), Some(1)).unwrap();
            let roundtrip_path = temp.path().join(format!("{mode}-roundtrip.ecglesson"));
            std::fs::write(&roundtrip_path, &reexported).unwrap();
            let second = AppState::open(temp.path().join(format!("{mode}-second"))).unwrap();
            second
                .selected
                .lock()
                .unwrap()
                .insert("roundtrip".into(), roundtrip_path);
            let (_, _, _, roundtrip_digest) = load_package(&second, "roundtrip").unwrap();
            let mut roundtrip_plan = plan.clone();
            roundtrip_plan.lesson_sha256 = roundtrip_digest;
            let reimported = import_package(&second, "roundtrip", true, &roundtrip_plan).unwrap();
            assert_ne!(reimported["id"], imported["id"]);
            assert_eq!(reimported["preparedRevision"], 1);
            if mode == "chorus" {
                assert_eq!(manifest.runtime_version, 2);
                assert_eq!(reimported["gameData"]["soundMode"], "chorus");
                assert_eq!(
                    reimported["gameData"]["segments"][0]["entries"][5]["chorus"]["beatsPerRead"]
                        ["value"],
                    2
                );
            }
            // 新运行能力必须跨真实导入、保存、导出、再导入保留，不能只检查 ZIP 字段。
            if mode == "tempo" {
                assert_eq!(manifest.runtime_version, 3);
                assert_eq!(reimported["gameData"]["music"]["preservePitch"], true);
                assert_eq!(reimported["gameData"]["music"]["sync"]["bpm"], 120);
                assert_eq!(reimported["gameData"]["bpm"]["value"], 144);
            }
            // Music must keep a remapped, playable reference after the complete
            // editable-package export/import boundary, not merely exist in ZIP.
            assert_eq!(reimported["gameData"]["music"]["enabled"], true);
            let music_id = reimported["gameData"]["music"]["assetId"].as_str().unwrap();
            let music = crate::assets::read_asset(&second, music_id).unwrap();
            assert_eq!(music.kind, "music");
            assert_eq!(
                music.sha256,
                if mode == "tempo" {
                    manifest.assets[0].sha256.clone()
                } else {
                    include_str!("../../resources/music/source.json")
                        .parse::<serde_json::Value>()
                        .unwrap()["sha256"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                }
            );
            assert_eq!(
                crate::assets::list_assets(&second).unwrap().len(),
                expected_audio
            );
            if let Some(directory) = evidence_path.as_ref().and_then(|path| path.parent()) {
                std::fs::create_dir_all(directory).unwrap();
                std::fs::write(
                    directory.join(format!("{mode}.native-roundtrip.ecglesson")),
                    &reexported,
                )
                .unwrap();
            }
            reports.push(json!({"mode":mode,"sourceFile":filename,"sourceSha256":sha256(&source_bytes),"nativeRoundtripSha256":sha256(&reexported),"audioCount":expected_audio,"preparedRevision":1,"identityCount":plan.revisions.iter().map(|item| item.layout.identities.len()).sum::<usize>(),"nativeImportExportReimport":true}));
        }
        if let Some(path) = evidence_path {
            std::fs::write(path, serde_json::to_vec_pretty(&json!({"checkedAt":now(),"isolatedTemporaryLibraries":true,"examples":reports})).unwrap()).unwrap();
        }
    }

    #[test]
    fn retained_package_uses_fixed_dual_snapshots_after_source_is_reprepared_and_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let (state, _, id) = source_package(temp.path());
        let draft_owner = Uuid::new_v4().to_string();
        let prepared_owner = Uuid::new_v4().to_string();
        crate::database::retain_assets(&state, &draft_owner, &[], Some(&id), Some(2)).unwrap();
        crate::database::retain_assets(&state, &prepared_owner, &[], Some(&id), Some(1)).unwrap();
        let mut later = crate::database::get_lesson(&state, &id, None).unwrap();
        later["name"] = json!("后来修改不应混入");
        later.as_object_mut().unwrap().remove("draftInputs");
        crate::database::save_lesson(&state, later, 2).unwrap();
        crate::database::mark_prepared(&state, &id, 3, &[], false).unwrap();
        crate::database::delete_lesson(&state, &id).unwrap();
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 0);
        let owners = vec![draft_owner.clone(), prepared_owner.clone()];
        let (_, bytes) = package_bytes_retained(&state, &id, Some(2), Some(1), &owners).unwrap();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut body = String::new();
        archive
            .by_name("lesson.json")
            .unwrap()
            .read_to_string(&mut body)
            .unwrap();
        let package: LessonPackage = serde_json::from_str(&body).unwrap();
        assert_eq!(package.draft_revision, 2);
        assert_eq!(package.prepared_revision, Some(1));
        assert_eq!(package.revisions.len(), 2);
        assert_ne!(package.name, "后来修改不应混入");
        assert_eq!(package.revisions[0]["draftInputs"]["rounds"]["raw"], "-");
        assert_eq!(
            package_bytes_retained(
                &state,
                &id,
                Some(2),
                Some(1),
                &[prepared_owner.clone(), draft_owner.clone()]
            )
            .unwrap_err()
            .code,
            "EXPORT_INPUT_UNAVAILABLE"
        );
        crate::database::release_assets(&state, &draft_owner).unwrap();
        crate::database::release_assets(&state, &prepared_owner).unwrap();
        assert_eq!(
            package_bytes_retained(&state, &id, Some(2), Some(1), &owners)
                .unwrap_err()
                .code,
            "EXPORT_INPUT_UNAVAILABLE"
        );
    }

    #[test]
    fn export_rejects_prepared_after_draft_before_pinning_or_writing() {
        let temp = tempfile::tempdir().unwrap();
        let (state, _, id) = source_package(temp.path());
        assert_eq!(
            package_bytes(&state, &id, Some(1), Some(2))
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
        let db = state.connection().unwrap();
        for table in ["pins", "revision_pins"] {
            let count: u64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
        assert_eq!(
            std::fs::read_dir(state.root.join("exports"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn partial_export_pin_failure_releases_the_already_inserted_pin() {
        let temp = tempfile::tempdir().unwrap();
        let (state, _, id) = source_package(temp.path());
        let second = crate::assets::store_audio(
            &state,
            &crate::assets::test_pcm(1200),
            None,
            None,
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let mut draft = crate::database::get_lesson(&state, &id, None).unwrap();
        draft["gameData"]["secondary"] = json!({"assetId":second.asset_id});
        crate::database::save_lesson(&state, draft, 2).unwrap();
        state.connection().unwrap().execute_batch(
            "CREATE TRIGGER fail_second_pin BEFORE INSERT ON pins WHEN EXISTS(SELECT 1 FROM pins) BEGIN SELECT RAISE(ABORT,'injected second pin failure'); END;",
        ).unwrap();
        assert!(package_bytes(&state, &id, Some(3), Some(1)).is_err());
        let count: u64 = state
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pins", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "A failed export cannot keep an abandoned asset reservation"
        );
    }

    #[test]
    fn double_snapshot_roundtrip_preserves_invalid_draft_and_prepared_audio() {
        let temp = tempfile::tempdir().unwrap();
        let (source, bytes, source_id) = source_package(&temp.path().join("source"));
        let original = crate::database::get_lesson(&source, &source_id, Some(1)).unwrap();
        let old_entry_id = original["gameData"]["entry"]["id"].as_str().unwrap();
        let target = AppState::open(temp.path().join("target")).unwrap();
        let file = temp.path().join("高中课件.ecglesson");
        std::fs::write(&file, bytes).unwrap();
        target
            .selected
            .lock()
            .unwrap()
            .insert("package".into(), file);
        let imported = import_fixture_package(&target, "package", false).unwrap();
        let local = imported["id"].as_str().unwrap();
        assert_ne!(local, source_id);
        assert_eq!(imported["revision"], 2);
        assert_eq!(imported["preparedRevision"], 1);
        assert_eq!(imported["draftInputs"]["rounds"]["raw"], "-");
        assert_eq!(
            crate::database::mark_prepared(&target, local, 2, &[], false)
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
        let prepared = crate::database::get_lesson(&target, local, Some(1)).unwrap();
        let new_entry_id = imported["gameData"]["entry"]["id"].as_str().unwrap();
        assert_ne!(new_entry_id, old_entry_id);
        assert_eq!(prepared["gameData"]["entry"]["id"], new_entry_id);
        assert_eq!(imported["gameData"]["entry"]["english"], old_entry_id);
        let draft_location = &imported["draftInputs"][format!("{new_entry_id}.rounds")];
        assert_eq!(draft_location["objectId"], new_entry_id);
        assert_eq!(draft_location["raw"], old_entry_id);
        assert!(imported["draftInputs"]
            .get(format!("{old_entry_id}.rounds"))
            .is_none());
        let ids: Vec<_> = asset_ids(&prepared).into_iter().collect();
        assert_eq!(ids.len(), 1);
        assert_eq!(
            crate::assets::read_asset(&target, &ids[0]).unwrap().kind,
            "speech"
        );
        assert_eq!(
            import_fixture_package(&target, "package", false).unwrap()["id"],
            local
        );
        let mut edited = imported.clone();
        edited["name"] = json!("本机已修改");
        crate::database::save_lesson(&target, edited, 2).unwrap();
        assert_ne!(
            import_fixture_package(&target, "package", false).unwrap()["id"],
            local
        );
        assert_eq!(
            crate::database::get_lesson(&target, local, None).unwrap()["name"],
            "本机已修改"
        );
        assert_eq!(crate::assets::list_assets(&target).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_second_snapshot_is_rejected_even_when_draft_is_valid() {
        let temp = tempfile::tempdir().unwrap();
        let (_source, bytes, _) = source_package(&temp.path().join("source"));
        let mut files = check_archive(&bytes, 500_000_000, 2000, true).unwrap();
        let mut lesson: Value = serde_json::from_slice(&files["lesson.json"]).unwrap();
        lesson["revisions"][1]["id"] = Value::Null;
        let lesson_bytes = serde_json::to_vec(&lesson).unwrap();
        let mut manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
        manifest["lessonSha256"] = json!(sha256(&lesson_bytes));
        files.insert("lesson.json".into(), lesson_bytes);
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        let target = AppState::open(temp.path().join("target")).unwrap();
        let file = temp.path().join("损坏.ecglesson");
        std::fs::write(&file, zip_files(&files).unwrap()).unwrap();
        target.selected.lock().unwrap().insert("bad".into(), file);
        assert!(import_fixture_package(&target, "bad", true).is_err());
        assert!(crate::database::list_lessons(&target).unwrap().is_empty());
        assert!(crate::assets::list_assets(&target).unwrap().is_empty());
    }

    #[test]
    fn undeclared_archive_content_and_invalid_revision_order_never_write_data() {
        let temp = tempfile::tempdir().unwrap();
        let (_source, bytes, _) = source_package(&temp.path().join("source"));
        let original = check_archive(&bytes, 500_000_000, 2000, true).unwrap();
        let target = AppState::open(temp.path().join("target")).unwrap();
        for case in ["undeclared", "zero-revision", "prepared-after-draft"] {
            let mut files = original.clone();
            if case == "undeclared" {
                files.insert("assets/payload.exe".into(), b"unlisted executable".to_vec());
            } else {
                let mut lesson: Value = serde_json::from_slice(&files["lesson.json"]).unwrap();
                if case == "zero-revision" {
                    lesson["revisions"][0]["revision"] = json!(0);
                } else {
                    lesson["draftRevision"] = json!(1);
                    lesson["preparedRevision"] = json!(2);
                }
                let lesson_bytes = serde_json::to_vec(&lesson).unwrap();
                let mut manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
                manifest["lessonSha256"] = json!(sha256(&lesson_bytes));
                files.insert("lesson.json".into(), lesson_bytes);
                files.insert(
                    "manifest.json".into(),
                    serde_json::to_vec(&manifest).unwrap(),
                );
            }
            let file = temp.path().join(format!("{case}.ecglesson"));
            std::fs::write(&file, zip_files(&files).unwrap()).unwrap();
            target.selected.lock().unwrap().insert(case.into(), file);
            assert!(
                import_fixture_package(&target, case, true).is_err(),
                "{case}"
            );
        }
        assert!(crate::database::list_lessons(&target).unwrap().is_empty());
        assert!(crate::assets::list_assets(&target).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(target.root.join("assets"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn changed_preview_digest_is_rejected_before_asset_or_lesson_writes() {
        let temp = tempfile::tempdir().unwrap();
        let (_source, bytes, _) = source_package(&temp.path().join("source"));
        let target = AppState::open(temp.path().join("target")).unwrap();
        let file = temp.path().join("changed.ecglesson");
        std::fs::write(&file, bytes).unwrap();
        target
            .selected
            .lock()
            .unwrap()
            .insert("changed".into(), file);
        let plan = PackageIdentityPlan {
            lesson_sha256: "digest-of-previous-preview".into(),
            revisions: vec![],
        };
        let error = import_package(&target, "changed", true, &plan).unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
        assert!(crate::database::list_lessons(&target).unwrap().is_empty());
        assert!(crate::assets::list_assets(&target).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(target.root.join("assets"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn forged_audio_sampling_metadata_is_rejected_before_import() {
        let temp = tempfile::tempdir().unwrap();
        let (_source, bytes, _) = source_package(&temp.path().join("source"));
        let original = check_archive(&bytes, 500_000_000, 2000, true).unwrap();
        let target = AppState::open(temp.path().join("target")).unwrap();
        for (field, forged) in [("sampleRate", 48_000), ("channels", 2), ("frameCount", 1)] {
            let mut files = original.clone();
            let mut manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
            manifest["assets"][0][field] = json!(forged);
            files.insert(
                "manifest.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            );
            let file = temp.path().join(format!("forged-{field}.ecglesson"));
            std::fs::write(&file, zip_files(&files).unwrap()).unwrap();
            target.selected.lock().unwrap().insert(field.into(), file);
            assert_eq!(
                import_fixture_package(&target, field, true)
                    .unwrap_err()
                    .code,
                "ASSET_INVALID"
            );
        }
        assert!(crate::database::list_lessons(&target).unwrap().is_empty());
        assert!(crate::assets::list_assets(&target).unwrap().is_empty());
    }

    #[test]
    fn legacy_package_gets_real_audio_metadata_without_changing_import_identity() {
        let temp = tempfile::tempdir().unwrap();
        let (_source, bytes, _) = source_package(&temp.path().join("source"));
        let mut files = check_archive(&bytes, 500_000_000, 2000, true).unwrap();
        let mut manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
        for field in ["sampleRate", "channels", "frameCount"] {
            manifest["assets"][0].as_object_mut().unwrap().remove(field);
        }
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        let target = AppState::open(temp.path().join("target")).unwrap();
        let file = temp.path().join("旧版采样信息缺省.ecglesson");
        std::fs::write(&file, zip_files(&files).unwrap()).unwrap();
        target
            .selected
            .lock()
            .unwrap()
            .insert("legacy".into(), file);
        let inspected = inspect_package(&target, "legacy").unwrap();
        assert_eq!(inspected["assets"][0]["sampleRate"], 16_000);
        assert_eq!(inspected["assets"][0]["channels"], 1);
        assert_eq!(inspected["assets"][0]["frameCount"], 14_400);
        // Decoder evidence belongs to the inspection result, not a rewritten
        // source manifest: importing the same old package still deduplicates.
        assert!(inspected["manifest"]["assets"][0]
            .get("sampleRate")
            .is_none());
        let first = import_fixture_package(&target, "legacy", false).unwrap();
        let second = import_fixture_package(&target, "legacy", false).unwrap();
        assert_eq!(first["id"], second["id"]);
        let asset = crate::assets::list_assets(&target).unwrap().pop().unwrap();
        assert_eq!(asset.sample_rate, Some(16_000));
        assert_eq!(asset.channels, Some(1));
        assert_eq!(asset.frame_count, Some(14_400));
    }
}
