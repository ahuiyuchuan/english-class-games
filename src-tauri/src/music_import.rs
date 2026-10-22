//! Local, bounded MP4 audio extraction. Preparation never owns a library asset;
//! only explicit commit may publish the validated WAV. No shell/network/process.
//! Author: ahui.
use crate::{
    assets,
    database::AppState,
    error::{AppError, AppResult},
    model::AudioAsset,
};
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_AAC},
    formats::{FormatOptions, FormatReader},
    io::{MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    probe::Hint,
};

const MAX_INPUT: u64 = 500_000_000;
const MAX_OUTPUT: usize = 50_000_000;
const MAX_MS: f64 = 600_000.0;

/// Global single-operation slot. Cancellation shares the commit lock, making the
/// winner explicit: cancellation before commit cannot create a library entry.
#[derive(Default)]
pub struct ImportSlot(pub Mutex<Option<ImportJob>>, pub AtomicBool);
pub struct ImportJob {
    id: String,
    cancel: Arc<AtomicBool>,
    path: PathBuf,
    name: String,
    ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub id: u32,
    pub codec: String,
    pub language: String,
    pub default: bool,
    pub supported: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicInspection {
    pub video: bool,
    pub tracks: Vec<MusicTrack>,
    pub selected_track: Option<u32>,
}

fn invalid(message: &str) -> AppError {
    AppError::new("MUSIC_INVALID", message)
}
fn check(cancel: &AtomicBool, start: Instant) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::new("CANCELLED", "已取消导入，未添加素材"));
    }
    if start.elapsed() > Duration::from_secs(120) {
        return Err(invalid("处理超过120秒，已停止；请使用较小的本地文件"));
    }
    Ok(())
}

/// Walk only bounded ISO boxes, never read the video payload into memory. tkhd
/// enabled is the MP4 default disposition; ambiguous enabled tracks require UI choice.
fn boxes(file: &mut File, begin: u64, end: u64) -> AppResult<Vec<([u8; 4], u64, u64)>> {
    let mut cursor = begin;
    let mut result = Vec::new();
    while cursor < end {
        if result.len() >= 4096 || end - cursor < 8 {
            return Err(invalid("MP4结构损坏或过于复杂"));
        }
        file.seek(SeekFrom::Start(cursor))?;
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut skip = 8;
        if size == 1 {
            let mut b = [0; 8];
            file.read_exact(&mut b)?;
            size = u64::from_be_bytes(b);
            skip = 16;
        }
        if size == 0 {
            size = end - cursor;
        }
        if size < skip || size > end - cursor {
            return Err(invalid("MP4数据块不完整"));
        }
        result.push((
            header[4..].try_into().unwrap(),
            cursor + skip,
            cursor + size,
        ));
        cursor += size;
    }
    Ok(result)
}

/// Container metadata is not exposed by Symphonia's public Track. Read the small
/// track headers independently, preserving trak order (the decoder's track IDs).
fn mp4_tracks(path: &Path) -> AppResult<Vec<MusicTrack>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    if length == 0 || length > MAX_INPUT {
        return Err(invalid("视频为空或超过500MB"));
    }
    let top = boxes(&mut file, 0, length)?;
    if !top.iter().any(|b| b.0 == *b"ftyp") || top.iter().any(|b| b.0 == *b"moof") {
        return Err(invalid("仅支持普通MP4文件，不支持碎片化视频"));
    }
    let moov = top
        .iter()
        .find(|b| b.0 == *b"moov")
        .ok_or_else(|| invalid("缺少MP4索引"))?;
    if moov.2 - moov.1 > 8_000_000 {
        return Err(invalid("MP4索引超过8MB限制"));
    }
    let movie = boxes(&mut file, moov.1, moov.2)?;
    if movie.iter().any(|b| b.0 == *b"mvex") {
        return Err(invalid("不支持碎片化MP4"));
    }
    let mut tracks = Vec::new();
    for (index, trak) in movie.iter().filter(|b| b.0 == *b"trak").enumerate() {
        if index >= 32 {
            return Err(invalid("视频轨道超过32条限制"));
        }
        let children = boxes(&mut file, trak.1, trak.2)?;
        let mut enabled = false;
        let mut audio = false;
        let mut language = "und".to_string();
        if let Some(t) = children.iter().find(|b| b.0 == *b"tkhd") {
            if t.2 - t.1 < 4 {
                return Err(invalid("轨道头损坏"));
            }
            file.seek(SeekFrom::Start(t.1))?;
            let mut b = [0; 4];
            file.read_exact(&mut b)?;
            enabled = b[3] & 1 != 0;
        }
        if let Some(mdia) = children.iter().find(|b| b.0 == *b"mdia") {
            for part in boxes(&mut file, mdia.1, mdia.2)? {
                if part.0 == *b"hdlr" && part.2 - part.1 >= 12 {
                    file.seek(SeekFrom::Start(part.1 + 8))?;
                    let mut b = [0; 4];
                    file.read_exact(&mut b)?;
                    audio = b == *b"soun";
                }
                if part.0 == *b"mdhd" && part.2 - part.1 >= 24 {
                    file.seek(SeekFrom::Start(part.1))?;
                    let mut v = [0];
                    file.read_exact(&mut v)?;
                    let offset = if v[0] == 1 { 32 } else { 20 };
                    if part.2 - part.1 >= offset + 2 {
                        file.seek(SeekFrom::Start(part.1 + offset))?;
                        let mut b = [0; 2];
                        file.read_exact(&mut b)?;
                        let code = u16::from_be_bytes(b);
                        language = [10, 5, 0]
                            .iter()
                            .map(|shift| char::from(((code >> shift) & 31) as u8 + 0x60))
                            .collect();
                    }
                }
            }
        }
        if audio {
            tracks.push(MusicTrack {
                id: index as u32,
                codec: "不支持的音轨".into(),
                language,
                default: enabled,
                supported: false,
            });
        }
    }
    if tracks.is_empty() {
        return Err(invalid("视频没有音轨"));
    }
    Ok(tracks)
}

fn reader(path: &Path) -> AppResult<Box<dyn FormatReader>> {
    let source = MediaSourceStream::new(
        Box::new(File::open(path)?),
        MediaSourceStreamOptions::default(),
    );
    let mut hint = Hint::new();
    hint.with_extension("mp4");
    Ok(symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| invalid("视频格式损坏或不受支持"))?
        .format)
}

/// Content detection precedes suffix handling. MP3/WAV retain the existing decoder.
pub fn inspect(path: &Path) -> AppResult<MusicInspection> {
    let mut file = File::open(path)?;
    let mut head = [0; 4096];
    let count = file.read(&mut head)?;
    if (head.starts_with(b"RIFF")
        || head.starts_with(b"ID3")
        || (count >= 2 && head[0] == 0xff && head[1] & 0xe0 == 0xe0))
        && assets::detect_mime(&head[..count]).is_ok()
    {
        if file.metadata()?.len() > MAX_OUTPUT as u64 {
            return Err(invalid("音频超过50MB"));
        }
        return Ok(MusicInspection {
            video: false,
            tracks: Vec::new(),
            selected_track: None,
        });
    }
    let mut tracks = mp4_tracks(path)?;
    let format = reader(path)?;
    for track in &mut tracks {
        if let Some(t) = format.tracks().iter().find(|t| t.id == track.id) {
            track.supported = t.codec_params.codec == CODEC_TYPE_AAC;
            if track.supported {
                track.codec = "AAC（仅LC配置）".into();
            }
        }
    }
    let defaults: Vec<_> = tracks.iter().filter(|t| t.default).collect();
    let selected_track = if tracks.len() == 1 {
        Some(tracks[0].id)
    } else if defaults.len() == 1 {
        Some(defaults[0].id)
    } else {
        None
    };
    Ok(MusicInspection {
        video: true,
        tracks,
        selected_track,
    })
}

/// Decode just the selected track, retaining at most the 50MB output plus one
/// decoder packet. Original rate/channel count and complete samples are preserved.
fn extract(path: &Path, track_id: u32, cancel: &AtomicBool, start: Instant) -> AppResult<Vec<u8>> {
    let inspection = inspect(path)?;
    if !inspection
        .tracks
        .iter()
        .any(|t| t.id == track_id && t.supported)
    {
        return Err(invalid("请选择受支持的AAC-LC音轨"));
    }
    let mut format = reader(path)?;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .ok_or_else(|| invalid("音轨已不存在"))?;
    let params = track.codec_params.clone();
    if let (Some(frames), Some(tb)) = (params.n_frames, params.time_base) {
        let t = tb.calc_time(frames);
        if (t.seconds as f64 + t.frac) * 1000.0 > MAX_MS + 100.0 {
            return Err(invalid("音轨超过10分钟"));
        }
    }
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|_| invalid("音轨编码不受支持，请使用AAC-LC"))?;
    let mut output = vec![0; 44];
    let mut rate = 0;
    let mut channels = 0;
    let mut frames = 0u64;
    let mut audible = false;
    loop {
        check(cancel, start)?;
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(_) => return Err(invalid("视频数据损坏，未保存音频")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|_| invalid("音轨无法完整解码，仅支持AAC-LC"))?;
        let spec = *decoded.spec();
        let count = spec.channels.count() as u32;
        if spec.rate == 0
            || spec.rate > 192_000
            || count == 0
            || count > 2
            || (rate != 0 && (rate != spec.rate || channels != count))
        {
            return Err(invalid("仅支持固定采样率的单声道/双声道音轨"));
        }
        rate = spec.rate;
        channels = count;
        frames += decoded.frames() as u64;
        if frames as f64 * 1000.0 / rate as f64 > MAX_MS + 1.0 {
            return Err(invalid("音轨超过10分钟"));
        }
        if output.len() + decoded.frames() * count as usize * 2 > MAX_OUTPUT {
            return Err(invalid("提取后的WAV超过50MB；未裁剪音轨，请使用较短视频"));
        }
        let mut buffer = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        for sample in buffer.samples() {
            audible |= *sample != 0;
            output.extend_from_slice(&sample.to_le_bytes());
        }
    }
    if !audible || frames == 0 {
        return Err(invalid("所选音轨为静音或没有可播放采样"));
    }
    // A truncated MP4 must not publish its decoded prefix as a complete track.
    if let (Some(expected), Some(tb)) = (params.n_frames, params.time_base) {
        let t = tb.calc_time(expected);
        if (t.seconds as f64 + t.frac) * rate as f64 > frames as f64 + rate as f64 * 0.1 {
            return Err(invalid("音轨未完整读取，可能已损坏"));
        }
    }
    let length = output.len() as u32;
    let mut header = std::io::Cursor::new(&mut output[..44]);
    header.write_all(b"RIFF")?;
    header.write_all(&(length - 8).to_le_bytes())?;
    header.write_all(b"WAVEfmt ")?;
    header.write_all(&16u32.to_le_bytes())?;
    header.write_all(&1u16.to_le_bytes())?;
    header.write_all(&(channels as u16).to_le_bytes())?;
    header.write_all(&rate.to_le_bytes())?;
    header.write_all(&(rate * channels * 2).to_le_bytes())?;
    header.write_all(&((channels * 2) as u16).to_le_bytes())?;
    header.write_all(&16u16.to_le_bytes())?;
    header.write_all(b"data")?;
    header.write_all(&(length - 44).to_le_bytes())?;
    Ok(output)
}

/// Reserve synchronously before spawning a worker so cancel can never overtake registration.
pub fn begin(state: &AppState, id: &str, name: String) -> AppResult<Arc<AtomicBool>> {
    uuid::Uuid::parse_str(id).map_err(|_| invalid("导入标识无效"))?;
    let mut slot = state
        .music_import
        .0
        .lock()
        .map_err(|_| invalid("导入状态异常"))?;
    if slot.is_some() || state.music_import.1.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("MUSIC_BUSY", "已有音乐导入，请先完成或取消"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *slot = Some(ImportJob {
        id: id.into(),
        cancel: cancel.clone(),
        path: state.root.join("tasks").join(format!("{id}.music")),
        name,
        ready: false,
    });
    Ok(cancel)
}

pub fn prepare(
    state: &AppState,
    id: &str,
    path: &Path,
    track: Option<u32>,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let start = Instant::now();
    let result = (|| {
        let inspection = inspect(path)?;
        check(&cancel, start)?;
        let bytes = if inspection.video {
            extract(
                path,
                track
                    .or(inspection.selected_track)
                    .ok_or_else(|| invalid("请选择音轨"))?,
                &cancel,
                start,
            )?
        } else {
            assets::read_limited(path, MAX_OUTPUT as u64)?
        };
        assets::audio_information(&bytes, assets::detect_mime(&bytes)?, MAX_MS)?;
        check(&cancel, start)?;
        let mut slot = state
            .music_import
            .0
            .lock()
            .map_err(|_| invalid("导入状态异常"))?;
        let job = slot
            .as_mut()
            .filter(|j| j.id == id)
            .ok_or_else(|| AppError::new("CANCELLED", "导入已取消"))?;
        std::fs::write(&job.path, bytes)?;
        job.ready = true;
        Ok(())
    })();
    if result.is_err() {
        let _ = cancel_import(state, id);
    }
    state.music_import.1.store(false, Ordering::SeqCst);
    result
}

pub fn cancel_import(state: &AppState, id: &str) -> AppResult<()> {
    let mut slot = state
        .music_import
        .0
        .lock()
        .map_err(|_| invalid("导入状态异常"))?;
    if slot.as_ref().is_some_and(|j| j.id == id) {
        let job = slot.take().unwrap();
        job.cancel.store(true, Ordering::SeqCst);
        if job.path.exists() {
            std::fs::remove_file(job.path)?;
        }
    }
    Ok(())
}

/// Cancellation and publication serialize here. Reuse an existing library music
/// identity for equal bytes; never create a duplicate from repeated confirmation.
pub fn commit(state: &AppState, id: &str) -> AppResult<AudioAsset> {
    let mut slot = state
        .music_import
        .0
        .lock()
        .map_err(|_| invalid("导入状态异常"))?;
    let job = slot
        .as_ref()
        .filter(|j| j.id == id && j.ready)
        .ok_or_else(|| invalid("导入未准备完成或已取消"))?;
    let result = (|| {
        let bytes = assets::read_limited(&job.path, MAX_OUTPUT as u64)?;
        let hash = assets::sha256(&bytes);
        let existing: Option<String> = {
            let db = state.connection()?;
            use rusqlite::OptionalExtension;
            db.query_row("SELECT a.id FROM assets a JOIN resource_assets r ON r.asset_id=a.id WHERE a.sha256=?1 AND r.kind='music' LIMIT 1",[&hash],|r|r.get(0)).optional()?
        };
        let asset = if let Some(id) = existing {
            assets::read_asset(state, &id)?
        } else {
            let asset = assets::store_audio(
                state,
                &bytes,
                Some(job.name.clone()),
                None,
                MAX_OUTPUT,
                MAX_MS,
                None,
            )?;
            assets::read_asset(state, &asset.asset_id)?
        };
        Ok(asset)
    })();
    let path = job.path.clone();
    let _ = std::fs::remove_file(path);
    *slot = None;
    result
}

/// Seed the bundled, reproducibly synthesized CC0 rhythm once. A marker respects later deletion;
/// content lookup makes a restart between asset commit and marker write idempotent.
pub fn seed_builtin(state: &AppState, source: &Path) -> AppResult<()> {
    let marker = state.root.join("builtin-music-v1.seeded");
    if marker.exists() {
        return Ok(());
    }
    let bytes = assets::read_limited(source, MAX_OUTPUT as u64)?;
    let hash = assets::sha256(&bytes);
    let exists: bool = state.connection()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets a JOIN resource_assets r ON r.asset_id=a.id WHERE a.sha256=?1 AND r.kind='music')",
        [&hash], |row| row.get(0))?;
    if !exists {
        assets::store_audio(
            state,
            &bytes,
            Some("课堂律动 · 首发背景音乐".into()),
            None,
            MAX_OUTPUT,
            MAX_MS,
            None,
        )?;
    }
    std::fs::write(marker, hash)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Repeated launch and explicit deletion must not produce duplicate music.
    #[test]
    fn builtin_seed_is_idempotent_and_respects_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("music.wav");
        std::fs::write(&source, assets::test_pcm(100)).unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        seed_builtin(&state, &source).unwrap();
        seed_builtin(&state, &source).unwrap();
        let library = assets::list_assets(&state).unwrap();
        assert_eq!(library.len(), 1);
        assets::delete_resource(&state, &library[0].asset_id).unwrap();
        assets::clean_cache(&state).unwrap();
        seed_builtin(&state, &source).unwrap();
        assert!(assets::list_assets(&state).unwrap().is_empty());
        assert!(check(
            &AtomicBool::new(false),
            Instant::now() - Duration::from_secs(121)
        )
        .is_err());
    }

    /// Real codec/storage integration. Fixtures are reproducibly generated by
    /// validation/make-bgm-fixtures.mjs; this test never shells out to a decoder.
    #[test]
    #[ignore = "requires generated real media fixtures: ECG_MEDIA_FIXTURES"]
    fn real_media_import_lifecycle() {
        let fixtures = PathBuf::from(std::env::var("ECG_MEDIA_FIXTURES").unwrap());
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().to_owned()).unwrap();
        for name in [
            "中文 空格 & 音乐.mp4",
            "audio.mp3",
            "audio.wav",
            "user-source.mp4",
            "user-reference.mp4",
        ] {
            let source = fixtures.join(name);
            let info = inspect(&source).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let token = begin(&state, &id, name.into()).unwrap();
            assert!(begin(
                &state,
                &uuid::Uuid::new_v4().to_string(),
                "duplicate".into()
            )
            .is_err());
            prepare(&state, &id, &source, info.selected_track, token).unwrap();
            let asset = commit(&state, &id).unwrap();
            let (_, bytes) = assets::read_asset_bytes(&state, &asset.asset_id).unwrap();
            println!(
                "PASS {name}: {}ms {} bytes {}",
                asset.duration_ms,
                bytes.len(),
                asset.sha256
            );
            if name == "user-source.mp4" {
                if let Ok(output) = std::env::var("ECG_BGM_OUTPUT") {
                    std::fs::write(output, &bytes).unwrap();
                }
            }
            // A second confirmed import reuses the existing resource identity.
            let token = begin(&state, &id, name.into()).unwrap();
            prepare(&state, &id, &source, info.selected_track, token).unwrap();
            assert_eq!(commit(&state, &id).unwrap().asset_id, asset.asset_id);
        }
        let count = assets::list_assets(&state).unwrap().len();
        for name in [
            "no-audio.mp4",
            "silent.mp4",
            "corrupt.mp4",
            "unsupported.mp4",
            "too-long.mp4",
            "too-large-output.mp4",
        ] {
            let id = uuid::Uuid::new_v4().to_string();
            let token = begin(&state, &id, name.into()).unwrap();
            let error = prepare(&state, &id, &fixtures.join(name), None, token).unwrap_err();
            println!("PASS reject {name}: {error:?}");
            assert_eq!(assets::list_assets(&state).unwrap().len(), count);
            assert!(state.music_import.0.lock().unwrap().is_none());
        }
        let default = inspect(&fixtures.join("multi-default.mp4")).unwrap();
        assert_eq!(default.selected_track, Some(0));
        assert_eq!(default.tracks[0].language, "eng");
        assert_eq!(
            inspect(&fixtures.join("multi-ambiguous.mp4"))
                .unwrap()
                .selected_track,
            None
        );
        let a = extract(
            &fixtures.join("multi-ambiguous.mp4"),
            0,
            &AtomicBool::new(false),
            Instant::now(),
        )
        .unwrap();
        let b = extract(
            &fixtures.join("multi-ambiguous.mp4"),
            1,
            &AtomicBool::new(false),
            Instant::now(),
        )
        .unwrap();
        assert_ne!(assets::sha256(&a), assets::sha256(&b));
        let id = uuid::Uuid::new_v4().to_string();
        let token = begin(&state, &id, "cancel".into()).unwrap();
        cancel_import(&state, &id).unwrap();
        assert!(begin(
            &state,
            &uuid::Uuid::new_v4().to_string(),
            "busy until drained".into()
        )
        .is_err());
        assert!(prepare(&state, &id, &fixtures.join("user-source.mp4"), None, token).is_err());
        let token = begin(&state, &id, "cancel ready".into()).unwrap();
        prepare(&state, &id, &fixtures.join("audio.wav"), None, token).unwrap();
        cancel_import(&state, &id).unwrap();
        assert!(commit(&state, &id).is_err());
        assert_eq!(
            std::fs::read_dir(state.root.join("tasks")).unwrap().count(),
            0
        );
        let local = temp.path().join("可删除的测试原片.mp4");
        std::fs::copy(fixtures.join("中文 空格 & 音乐.mp4"), &local).unwrap();
        let token = begin(&state, &id, "independent".into()).unwrap();
        prepare(&state, &id, &local, None, token).unwrap();
        let asset = commit(&state, &id).unwrap();
        std::fs::remove_file(local).unwrap();
        assert!(assets::read_asset(&state, &asset.asset_id)
            .unwrap()
            .data_url
            .is_some());
        let oversize = temp.path().join("oversize.mp4");
        File::create(&oversize)
            .unwrap()
            .set_len(MAX_INPUT + 1)
            .unwrap();
        assert!(inspect(&oversize).is_err());
        println!("PASS multi-track, cancellation, deduplication, source deletion and size limit");
    }
}
