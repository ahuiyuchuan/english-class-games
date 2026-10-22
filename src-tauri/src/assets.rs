//! Managed immutable audio storage. A filename never establishes a text/audio match.
//! Decoding and hashing happen before an asset can enter the library.
//! Author: ahui.
use crate::{
    database::{now, read_asset_meta, AppState},
    error::{AppError, AppResult},
    model::AudioAsset,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{io::Cursor, path::Path};
use symphonia::core::{
    codecs::DecoderOptions,
    errors::Error as MediaError,
    formats::FormatOptions,
    io::{MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    probe::Hint,
};
use uuid::Uuid;

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Content addressing avoids path injection and permits multiple logical assets to
/// share bytes without permitting a teacher edit to overwrite an old recording.
pub fn asset_path(state: &AppState, digest: &str) -> AppResult<std::path::PathBuf> {
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::validation("素材校验值格式错误"));
    }
    Ok(state.root.join("assets").join(digest))
}

/// Actual fixed-format decoder output. frame_count counts samples per channel;
/// Web Audio float32 footprint is frame_count * channels * 4, not encoded bytes.
#[derive(Debug, Clone)]
pub struct AudioInformation {
    pub duration_ms: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: u64,
}

/// Decode every packet to reject damaged files, while retaining only one decoded
/// packet at a time. The duration limit is checked during decoding, not after loading
/// a potentially enormous uncompressed sound into memory.
pub fn audio_information(bytes: &[u8], mime: &str, maximum_ms: f64) -> AppResult<AudioInformation> {
    let mut hint = Hint::new();
    hint.with_extension(if mime == "audio/mpeg" { "mp3" } else { "wav" });
    let source = MediaSourceStream::new(
        Box::new(Cursor::new(bytes.to_vec())),
        MediaSourceStreamOptions::default(),
    );
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| AppError::new("ASSET_INVALID", "无法读取音频格式，请使用 MP3 或 PCM WAV"))?
        .format;
    let track = format
        .default_track()
        .ok_or_else(|| AppError::new("ASSET_INVALID", "音频中没有可用声音轨道"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| AppError::new("ASSET_INVALID", "音频编码不受支持"))?;
    let mut duration = 0.0;
    let mut sample_rate = None;
    let mut channels = None;
    let mut frame_count = 0_u64;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(MediaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(_) => return Err(AppError::new("ASSET_INVALID", "音频内容损坏，无法完整解码")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|_| AppError::new("ASSET_INVALID", "音频包含无法解码的数据"))?;
        if decoded.spec().rate == 0
            || decoded.spec().rate > 192_000
            || decoded.spec().channels.count() == 0
            || decoded.spec().channels.count() > 8
        {
            return Err(AppError::new("ASSET_INVALID", "音频采样参数不受支持"));
        }
        let packet_rate = decoded.spec().rate;
        let packet_channels = decoded.spec().channels.count() as u32;
        if sample_rate.is_some_and(|rate| rate != packet_rate)
            || channels.is_some_and(|count| count != packet_channels)
        {
            return Err(AppError::new(
                "ASSET_INVALID",
                "音频中途改变采样格式，请重新导出音频",
            ));
        }
        sample_rate = Some(packet_rate);
        channels = Some(packet_channels);
        frame_count = frame_count
            .checked_add(decoded.frames() as u64)
            .ok_or_else(|| AppError::new("ASSET_INVALID", "音频采样数量超过允许范围"))?;
        duration += decoded.frames() as f64 * 1000.0 / decoded.spec().rate as f64;
        if duration > maximum_ms + 1.0 {
            return Err(AppError::new(
                "ASSET_INVALID",
                format!("音频时长超过 {} 秒限制", maximum_ms / 1000.0),
            ));
        }
    }
    if !duration.is_finite() || duration <= 0.0 {
        return Err(AppError::new("ASSET_INVALID", "音频时长为零或无效"));
    }
    Ok(AudioInformation {
        duration_ms: duration,
        sample_rate: sample_rate.unwrap_or_default(),
        channels: channels.unwrap_or_default(),
        frame_count,
    })
}

/// Existing duration checks share the same real decoder and safety limits.
#[cfg(test)]
pub fn audio_duration(bytes: &[u8], mime: &str, maximum_ms: f64) -> AppResult<f64> {
    Ok(audio_information(bytes, mime, maximum_ms)?.duration_ms)
}

pub fn detect_mime(bytes: &[u8]) -> AppResult<&'static str> {
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE".as_slice()) {
        return Ok("audio/wav");
    }
    if bytes.starts_with(b"ID3")
        || bytes
            .windows(2)
            .take(4096)
            .any(|pair| pair[0] == 0xff && pair[1] & 0xe0 == 0xe0)
    {
        return Ok("audio/mpeg");
    }
    Err(AppError::new(
        "ASSET_INVALID",
        "仅支持真实的 MP3 / WAV 音频文件",
    ))
}

/// A cancellation can arrive after synthesis finished but before its database
/// lock was obtained. Check the task while holding the same lock used to retain
/// its asset, so late/cache results cannot add new ownership to a stopped task.
fn ensure_task_receives_assets(db: &rusqlite::Connection, owner: &str) -> AppResult<()> {
    let task: Option<(String, String)> = db
        .query_row(
            "SELECT state,record FROM tasks WHERE id=?1",
            [owner],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((status, record)) = task else {
        return Err(AppError::new("CANCELLED", "配音任务已被清除，丢弃迟到声音"));
    };
    let body: crate::model::TaskRecord = serde_json::from_str(&record)?;
    if !matches!(status.as_str(), "queued" | "running") || body.cancel_requested {
        return Err(AppError::new("CANCELLED", "配音任务已停止，丢弃迟到声音"));
    }
    Ok(())
}

pub fn store_audio(
    state: &AppState,
    bytes: &[u8],
    name: Option<String>,
    cache_key: Option<&str>,
    maximum_bytes: usize,
    maximum_ms: f64,
    pin_owner: Option<&str>,
) -> AppResult<AudioAsset> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(AppError::validation("音频文件大小超限或为空"));
    }
    let mime = detect_mime(bytes)?;
    let information = audio_information(bytes, mime, maximum_ms)?;
    let digest = sha256(bytes);
    let destination = asset_path(state, &digest)?;
    let asset = AudioAsset {
        asset_id: Uuid::new_v4().to_string(),
        mime_type: mime.into(),
        byte_length: bytes.len() as u64,
        duration_ms: information.duration_ms,
        sample_rate: Some(information.sample_rate),
        channels: Some(information.channels),
        frame_count: Some(information.frame_count),
        sha256: digest,
        kind: if cache_key.is_some() {
            "speech"
        } else if maximum_ms > 30_000.0 {
            "music"
        } else {
            "recording"
        }
        .into(),
        data_url: None,
        name,
    };
    let mut db = state.connection()?;
    state.ensure_writable()?;
    if let Some(owner) = pin_owner {
        ensure_task_receives_assets(&db, owner)?;
    }
    if !destination.exists()
        || sha256(&read_limited(&destination, maximum_bytes as u64)?) != asset.sha256
    {
        let temporary = state
            .root
            .join("tasks")
            .join(format!("{}.audio", Uuid::new_v4()));
        std::fs::write(&temporary, bytes)?;
        if sha256(&std::fs::read(&temporary)?) != asset.sha256 {
            let _ = std::fs::remove_file(&temporary);
            return Err(AppError::new("ASSET_INVALID", "声音文件写入校验失败"));
        }
        crate::files::replace_file(&temporary, &destination)?;
    }
    let transaction = db.transaction()?;
    transaction.execute("INSERT INTO assets(id,sha256,mime_type,byte_length,duration_ms,name,cache_key,created_at,kind,sample_rate,channels,frame_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)", params![asset.asset_id, asset.sha256, asset.mime_type, asset.byte_length, asset.duration_ms, asset.name, cache_key, now(), asset.kind, asset.sample_rate, asset.channels, asset.frame_count])?;
    if let Some(owner) = pin_owner {
        transaction.execute(
            "INSERT OR IGNORE INTO pins(owner_id,asset_id) VALUES(?1,?2)",
            params![owner, asset.asset_id],
        )?;
    } else if cache_key.is_none() {
        // Teacher imports belong to the resource library even before their first use.
        transaction.execute(
            "INSERT INTO resource_assets(asset_id,kind) VALUES(?1,?2)",
            params![
                asset.asset_id,
                if maximum_ms > 30_000.0 {
                    "music"
                } else {
                    "recording"
                }
            ],
        )?;
    }
    transaction.commit()?;
    Ok(asset)
}

pub fn read_asset_bytes(state: &AppState, asset_id: &str) -> AppResult<(AudioAsset, Vec<u8>)> {
    let db = state.connection()?;
    let asset = read_asset_meta(&db, asset_id)?;
    let bytes = read_limited(&asset_path(state, &asset.sha256)?, 50_000_000).map_err(|_| {
        AppError::new("ASSET_MISSING", "素材文件丢失，请重新导入或从备份恢复").field(asset_id)
    })?;
    if bytes.len() as u64 != asset.byte_length || sha256(&bytes) != asset.sha256 {
        return Err(AppError::new("ASSET_INVALID", "素材校验失败，请修复该声音").field(asset_id));
    }
    Ok((asset, bytes))
}

pub fn read_asset(state: &AppState, asset_id: &str) -> AppResult<AudioAsset> {
    let (mut asset, bytes) = read_asset_bytes(state, asset_id)?;
    asset.data_url = Some(format!(
        "data:{};base64,{}",
        asset.mime_type,
        STANDARD.encode(bytes)
    ));
    Ok(asset)
}

pub fn list_assets(state: &AppState) -> AppResult<Vec<AudioAsset>> {
    let db = state.connection()?;
    let mut query = db.prepare("SELECT id FROM assets ORDER BY created_at DESC")?;
    let ids = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.iter().map(|id| read_asset_meta(&db, id)).collect()
}

pub fn cached_audio(state: &AppState, key: &str, pin_owner: &str) -> AppResult<Option<AudioAsset>> {
    let db = state.connection()?;
    ensure_task_receives_assets(&db, pin_owner)?;
    let id = db
        .query_row(
            "SELECT id FROM assets WHERE cache_key=?1 ORDER BY created_at DESC LIMIT 1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(None);
    };
    let asset = read_asset_meta(&db, &id)?;
    let Ok(bytes) = read_limited(&asset_path(state, &asset.sha256)?, 50_000_000) else {
        return Ok(None);
    };
    if bytes.len() as u64 != asset.byte_length || sha256(&bytes) != asset.sha256 {
        return Ok(None);
    }
    // Lookup, verification and retention share the same database lock; a cache
    // cleanup cannot remove the file between finding it and pinning the result.
    db.execute(
        "INSERT OR IGNORE INTO pins(owner_id,asset_id) VALUES(?1,?2)",
        params![pin_owner, id],
    )?;
    Ok(Some(asset))
}

/// Only unreferenced, unpinned assets may be removed. Shared content bytes survive as
/// long as any asset metadata entry still refers to the same digest.
pub fn clean_cache(state: &AppState) -> AppResult<usize> {
    let db = state.connection()?;
    state.ensure_writable()?;
    crate::database::prune_revisions(&db)?;
    let mut query = db.prepare("SELECT id,sha256 FROM assets WHERE id NOT IN (SELECT asset_id FROM revision_assets) AND id NOT IN (SELECT asset_id FROM pins) AND id NOT IN (SELECT asset_id FROM resource_assets)")?;
    let entries = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(query);
    for (id, digest) in &entries {
        db.execute("DELETE FROM assets WHERE id=?1", [id])?;
        let remaining: u64 = db.query_row(
            "SELECT COUNT(*) FROM assets WHERE sha256=?1",
            [digest],
            |row| row.get(0),
        )?;
        if remaining == 0 {
            let _ = std::fs::remove_file(asset_path(state, digest)?);
        }
    }
    Ok(entries.len())
}

/// Removing a resource-library item never deletes independent lesson/undo/task
/// references. The bytes become reclaimable only when all owners have released them.
pub fn delete_resource(state: &AppState, asset_id: &str) -> AppResult<()> {
    let db = state.connection()?;
    state.ensure_writable()?;
    db.execute("DELETE FROM resource_assets WHERE asset_id=?1", [asset_id])?;
    Ok(())
}

pub fn resource_usage(state: &AppState, asset_id: &str) -> AppResult<serde_json::Value> {
    let db = state.connection()?;
    let mut query = db.prepare("SELECT DISTINCT l.id,l.name FROM lessons l JOIN revision_assets r ON r.lesson_id=l.id WHERE r.asset_id=?1 ORDER BY l.name")?;
    let lessons = query
        .query_map([asset_id], |row| {
            Ok(serde_json::json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let library: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM resource_assets WHERE asset_id=?1)",
        [asset_id],
        |row| row.get(0),
    )?;
    Ok(serde_json::json!({"inLibrary":library,"lessons":lessons}))
}

pub fn read_limited(path: &Path, maximum: u64) -> AppResult<Vec<u8>> {
    use std::io::Read;
    if std::fs::metadata(path)?.len() > maximum {
        return Err(AppError::validation("文件大小超过允许上限"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(AppError::validation("读取期间文件超过大小限制"));
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) fn test_pcm(duration_ms: u32) -> Vec<u8> {
    // 16 kHz mono signed 16-bit silence is sufficient to exercise actual PCM
    // decoding, byte budgets, content addressing and transferable package media.
    let length = duration_ms * 32;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(36 + length).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&16_000_u32.to_le_bytes());
    bytes.extend_from_slice(&32_000_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.resize(44 + length as usize, 0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_disguised_audio_and_zero_duration() {
        assert!(detect_mime(b"not actually an mp3").is_err());
        assert!(audio_duration(b"RIFFxxxxWAVE", "audio/wav", 30_000.0).is_err());
    }
    #[test]
    fn digest_never_accepts_a_path() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        assert!(asset_path(&state, "../outside").is_err());
    }

    #[test]
    fn persists_real_sample_metadata_and_keeps_old_library_metadata_nullable() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let bytes = test_pcm(900);
        let actual = audio_information(&bytes, "audio/wav", 30_000.0).unwrap();
        assert_eq!(actual.sample_rate, 16_000);
        assert_eq!(actual.channels, 1);
        assert_eq!(actual.frame_count, 14_400);
        assert_eq!(actual.frame_count * actual.channels as u64 * 4, 57_600);
        let asset = store_audio(&state, &bytes, None, None, 20_000_000, 30_000.0, None).unwrap();
        let saved = list_assets(&state).unwrap().pop().unwrap();
        assert_eq!(saved.sample_rate, Some(16_000));
        assert_eq!(saved.channels, Some(1));
        assert_eq!(saved.frame_count, Some(14_400));
        // Existing V1 rows without the additive metadata remain readable and do
        // not claim a decoded footprint of zero; the renderer must decode them.
        state
            .connection()
            .unwrap()
            .execute(
                "UPDATE assets SET sample_rate=NULL,channels=NULL,frame_count=NULL WHERE id=?1",
                [&asset.asset_id],
            )
            .unwrap();
        let legacy = read_asset(&state, &asset.asset_id).unwrap();
        assert_eq!(legacy.frame_count, None);
        assert!(legacy.data_url.is_some());
    }

    #[test]
    fn resource_and_session_owners_survive_cache_cleanup_independently() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        let asset = store_audio(
            &state,
            &test_pcm(900),
            Some("教师录音".into()),
            None,
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        assert_eq!(
            read_asset(&state, &asset.asset_id).unwrap().kind,
            "recording"
        );
        assert_eq!(clean_cache(&state).unwrap(), 0);
        let owner = Uuid::new_v4().to_string();
        crate::database::retain_assets(
            &state,
            &owner,
            std::slice::from_ref(&asset.asset_id),
            None,
            None,
        )
        .unwrap();
        delete_resource(&state, &asset.asset_id).unwrap();
        assert_eq!(clean_cache(&state).unwrap(), 0);
        crate::database::release_assets(&state, &owner).unwrap();
        assert_eq!(clean_cache(&state).unwrap(), 1);
        assert!(!asset_path(&state, &asset.sha256).unwrap().exists());
    }

    #[test]
    fn cancelled_or_terminal_task_cannot_retain_late_or_cached_audio() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        for status in ["cancelling", "cancelled", "completed", "interrupted"] {
            let id = Uuid::new_v4().to_string();
            let record = serde_json::json!({"taskId":id,"kind":"speech","state":status,"stage":"声音制作","completed":0,"total":1,"results":[],"failures":[],"cancelRequested":status=="cancelling","createdAt":now(),"updatedAt":now()});
            state.connection().unwrap().execute("INSERT INTO tasks(id,kind,input_hash,state,record,updated_at) VALUES(?1,'speech','late',?2,?3,?4)",params![id,status,record.to_string(),now()]).unwrap();
            assert_eq!(
                store_audio(
                    &state,
                    &test_pcm(900),
                    None,
                    Some("late-key"),
                    20_000_000,
                    30_000.0,
                    Some(&id)
                )
                .unwrap_err()
                .code,
                "CANCELLED"
            );
            assert_eq!(
                cached_audio(&state, "late-key", &id).unwrap_err().code,
                "CANCELLED"
            );
        }
        assert!(list_assets(&state).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(state.root.join("assets"))
                .unwrap()
                .count(),
            0
        );
    }
}
