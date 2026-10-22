//! Bundled neural and Windows speech and cancellable, revision-bound background tasks.
//! No fallback sine wave, fake voice or simulated progress can satisfy a request.
//! Author: ahui.
use crate::{
    assets::{cached_audio, sha256, store_audio},
    database::{get_task, now, put_task, AppState},
    error::{AppError, AppResult},
    model::{SpeechItem, TaskRecord, VoiceInfo},
};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Bundled CPU voices remain available even if the optional Windows API fails.
pub fn list_voices() -> AppResult<Vec<VoiceInfo>> {
    let mut result = crate::builtin_speech::voices();
    match system_voices() {
        Ok(voices) => result.extend(voices),
        Err(error) if result.is_empty() => return Err(error),
        Err(_) => {} // System speech is optional when bundled voices are intact.
    }
    Ok(result)
}

fn system_voices() -> AppResult<Vec<VoiceInfo>> {
    #[cfg(windows)]
    {
        let _apartment = WindowsApartment::new()?;
        use windows::Media::SpeechSynthesis::SpeechSynthesizer;
        let voices = SpeechSynthesizer::AllVoices().map_err(voice_error)?;
        let mut result = Vec::new();
        for index in 0..voices.Size().map_err(voice_error)? {
            let voice = voices.GetAt(index).map_err(voice_error)?;
            result.push(VoiceInfo {
                id: voice.Id().map_err(voice_error)?.to_string(),
                name: voice.DisplayName().map_err(voice_error)?.to_string(),
                language: voice.Language().map_err(voice_error)?.to_string(),
            });
        }
        Ok(result)
    }
    #[cfg(not(windows))]
    {
        Err(AppError::new(
            "VOICE_UNAVAILABLE",
            "系统配音仅在 Windows 10 / 11 可用",
        ))
    }
}

#[cfg(windows)]
fn voice_error(error: windows::core::Error) -> AppError {
    AppError::new("SYNTHESIS_FAILED", format!("Windows 配音调用失败：{error}"))
}

#[cfg(windows)]
struct WindowsApartment;
#[cfg(windows)]
impl WindowsApartment {
    fn new() -> AppResult<Self> {
        // Each blocking worker initializes WinRT on its own thread. A balanced
        // uninitialize avoids leaking apartment state into a reused thread-pool thread.
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )
            .map_err(voice_error)?;
        }
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for WindowsApartment {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::WinRT::RoUninitialize();
        }
    }
}

/// Normalize whitespace only; `US` and `us` intentionally have different cache keys.
fn cache_key(item: &SpeechItem) -> AppResult<String> {
    let normalized = item.text.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(sha256(&serde_json::to_vec(
        &json!({"text":normalized,"voiceId":item.voice_id,"language":item.language,"rate":item.rate,"environment":if crate::builtin_speech::is_builtin(item.voice_id.as_deref()) { "sherpa-1.13.8-melo-zh-en-fp32-v1".to_owned() } else { speech_environment() },"generatorVersion":1}),
    )?))
}

/// Registry build/revision values distinguish installed speech environments without
/// changing system settings or relying on compatibility-shimmed OS version APIs.
fn speech_environment() -> String {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        if let Ok(version) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        {
            let build: String = version.get_value("CurrentBuildNumber").unwrap_or_default();
            let revision: u32 = version.get_value("UBR").unwrap_or_default();
            return format!("windows-{build}-{revision}");
        }
    }
    std::env::consts::OS.to_owned()
}

fn cancelled(state: &AppState, task_id: &str) -> bool {
    get_task(state, task_id)
        .map(|task| {
            task.cancel_requested || task.state == "cancelled" || task.state == "interrupted"
        })
        .unwrap_or(true)
}

/// The editor groups actual voices as English or Chinese, rather than requiring
/// one regional accent. Keep that same boundary here: an en-GB voice may read an
/// English en-US-labelled entry, while a Chinese voice may never satisfy it.
fn voice_language_matches_content(voice: &str, content: &str) -> bool {
    let voice = voice.split('-').next().unwrap_or_default();
    let content = content.split('-').next().unwrap_or_default();
    !voice.is_empty() && !content.is_empty() && voice.eq_ignore_ascii_case(content)
}

#[cfg(windows)]
fn synthesize(item: &SpeechItem, cancel: impl Fn() -> bool) -> AppResult<Vec<u8>> {
    use windows::{
        core::HSTRING, Media::SpeechSynthesis::SpeechSynthesizer, Storage::Streams::DataReader,
    };
    let _apartment = WindowsApartment::new()?;
    let voices = SpeechSynthesizer::AllVoices().map_err(voice_error)?;
    let mut selected = None;
    for index in 0..voices.Size().map_err(voice_error)? {
        let voice = voices.GetAt(index).map_err(voice_error)?;
        if item.voice_id.as_deref() == Some(&voice.Id().map_err(voice_error)?.to_string()) {
            selected = Some(voice);
            break;
        }
    }
    let voice = selected.ok_or_else(|| {
        AppError::new(
            "VOICE_UNAVAILABLE",
            "所选系统音色不可用，请刷新音色或导入录音",
        )
    })?;
    let language = voice.Language().map_err(voice_error)?.to_string();
    if !voice_language_matches_content(&language, &item.language) {
        return Err(AppError::new(
            "VOICE_UNAVAILABLE",
            "所选音色语言与配音内容不匹配",
        ));
    }
    let synthesizer = SpeechSynthesizer::new().map_err(voice_error)?;
    synthesizer.SetVoice(&voice).map_err(voice_error)?;
    synthesizer
        .Options()
        .map_err(voice_error)?
        .SetSpeakingRate(item.rate)
        .map_err(voice_error)?;
    let operation = synthesizer
        .SynthesizeTextToStreamAsync(&HSTRING::from(&item.text))
        .map_err(voice_error)?;
    const ASYNC_STARTED: i32 = 0;
    let start = Instant::now();
    while operation.Status().map_err(voice_error)?.0 == ASYNC_STARTED {
        if cancel() || start.elapsed() > Duration::from_secs(30) {
            let _ = operation.Cancel();
            return Err(AppError::new(
                if cancel() {
                    "CANCELLED"
                } else {
                    "SYNTHESIS_FAILED"
                },
                "配音已取消或超过 30 秒，请重试该项",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if cancel() {
        return Err(AppError::new("CANCELLED", "已取消该项配音"));
    }
    let stream = operation.GetResults().map_err(voice_error)?;
    let size = stream.Size().map_err(voice_error)?;
    if size == 0 || size > 20_000_000 {
        return Err(AppError::new(
            "SYNTHESIS_FAILED",
            "系统配音产物为空或超过 20 MB",
        ));
    }
    let reader = DataReader::CreateDataReader(&stream).map_err(voice_error)?;
    let loading = reader.LoadAsync(size as u32).map_err(voice_error)?;
    while loading.Status().map_err(voice_error)?.0 == ASYNC_STARTED {
        if cancel() || start.elapsed() > Duration::from_secs(30) {
            let _ = loading.Cancel();
            return Err(AppError::new(
                if cancel() {
                    "CANCELLED"
                } else {
                    "SYNTHESIS_FAILED"
                },
                "声音读取已取消或超过 30 秒",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    loading.GetResults().map_err(voice_error)?;
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes).map_err(voice_error)?;
    Ok(bytes)
}

#[cfg(not(windows))]
fn synthesize(_item: &SpeechItem, _cancel: impl Fn() -> bool) -> AppResult<Vec<u8>> {
    Err(AppError::new(
        "VOICE_UNAVAILABLE",
        "当前平台不支持 Windows 配音",
    ))
}

/// Duplicate active inputs reuse a task; terminal retries receive a new identity.
/// Generated assets remain task outputs until the UI explicitly saves a matching revision.
pub fn start_task(
    state: Arc<AppState>,
    items: Vec<SpeechItem>,
    lesson_id: Option<String>,
    input_revision: Option<u64>,
    retry_of: Option<String>,
) -> AppResult<TaskRecord> {
    if items.is_empty() || items.len() > 120 {
        return Err(AppError::validation("配音任务需包含 1～120 项"));
    }
    for item in &items {
        if item.text.trim().is_empty()
            || item.text.chars().count() > 200
            || !(0.75..=1.25).contains(&item.rate)
            || item.voice_id.as_deref().unwrap_or_default().is_empty()
        {
            return Err(AppError::validation("配音文本、音色或语速不合法").field(&item.object_id));
        }
    }
    // Request envelope IDs can change on a repeated click. Content/object identities
    // define duplication, while the original request IDs remain on the reused task.
    let stable_input: Vec<_> = items.iter().map(|item|json!({"objectId":item.object_id,"text":item.text,"language":item.language,"voiceId":item.voice_id,"rate":item.rate})).collect();
    let hash = sha256(&serde_json::to_vec(&stable_input)?);
    let mut db = state.connection()?;
    state.ensure_writable()?;
    let transaction = db.transaction()?;
    let existing: Option<String> = transaction.query_row("SELECT id FROM tasks WHERE lesson_id IS ?1 AND input_revision IS ?2 AND input_hash=?3 AND kind='speech' AND state IN ('queued','running','cancelling') LIMIT 1", params![lesson_id, input_revision, hash], |row| row.get(0)).optional()?;
    if let Some(id) = existing {
        drop(transaction);
        drop(db);
        return get_task(&state, &id);
    }
    let retry_of = if let Some(id) = retry_of {
        let previous: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT state,lesson_id FROM tasks WHERE id=?1 AND kind='speech'",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if !previous.is_some_and(|(status, lesson)| {
            crate::database::is_terminal_task(&status) && lesson == lesson_id
        }) {
            return Err(AppError::validation(
                "重试来源必须为同一课件已停止的配音任务",
            ));
        }
        Some(id)
    } else {
        transaction.query_row("SELECT id FROM tasks WHERE lesson_id IS ?1 AND input_revision IS ?2 AND input_hash=?3 AND kind='speech' ORDER BY updated_at DESC LIMIT 1", params![lesson_id,input_revision,hash], |row|row.get(0)).optional()?
    };
    let task = TaskRecord {
        task_id: Uuid::new_v4().to_string(),
        kind: "speech".into(),
        lesson_id,
        input_revision,
        state: "queued".into(),
        stage: "声音制作".into(),
        completed: 0,
        total: items.len(),
        results: Vec::new(),
        failures: Vec::new(),
        cancel_requested: false,
        created_at: now(),
        updated_at: now(),
        retry_of,
    };
    transaction.execute("INSERT INTO tasks(id,lesson_id,input_revision,kind,input_hash,state,record,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![task.task_id, task.lesson_id, task.input_revision, task.kind, hash, task.state, serde_json::to_string(&task)?, task.updated_at])?;
    crate::database::save_task_input(&transaction, &task)?;
    transaction.commit()?;
    drop(db);
    let task_id = task.task_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = execute_task(&state, &task_id, &items) {
            // Early cache/worker errors must end the task instead of leaving its UI
            // permanently running. put_task still protects terminal/cancelled records.
            if let Ok(mut task) = get_task(&state, &task_id) {
                task.state = "failed".into();
                task.stage = "声音制作失败".into();
                task.updated_at = now();
                task.failures
                    .push(json!({"requestId":"task","objectId":task.lesson_id,"error":error}));
                if let Ok(db) = state.connection() {
                    let _ = put_task(&db, &task);
                }
            }
        }
    });
    Ok(task)
}

fn execute_task(state: &AppState, task_id: &str, items: &[SpeechItem]) -> AppResult<()> {
    let _serial = state
        .speech_gate
        .lock()
        .map_err(|_| AppError::new("SYNTHESIS_FAILED", "配音队列异常，请重启软件"))?;
    let _operation = match crate::database::WriteOperation::begin(state) {
        Ok(operation) => operation,
        Err(_) => {
            let mut interrupted = get_task(state, task_id)?;
            interrupted.state = "interrupted".into();
            put_task(&*state.connection()?, &interrupted)?;
            return Ok(());
        }
    };
    let mut task = get_task(state, task_id)?;
    if task.cancel_requested {
        task.state = "cancelled".into();
        put_task(&*state.connection()?, &task)?;
        return Ok(());
    }
    task.state = "running".into();
    put_task(&*state.connection()?, &task)?;
    for item in items {
        if cancelled(state, task_id) {
            break;
        }
        let key = cache_key(item)?;
        let cached = cached_audio(state, &key, task_id)?;
        let was_cached = cached.is_some();
        let result = match cached {
            Some(asset) => Ok(asset),
            None => (if crate::builtin_speech::is_builtin(item.voice_id.as_deref()) {
                crate::builtin_speech::synthesize(item, &state.root.join("tasks"), || {
                    cancelled(state, task_id)
                })
            } else {
                synthesize(item, || cancelled(state, task_id))
            })
            .and_then(|bytes| {
                if cancelled(state, task_id) {
                    return Err(AppError::new("CANCELLED", "配音结果已过期"));
                }
                store_audio(
                    state,
                    &bytes,
                    Some(item.text.clone()),
                    Some(&key),
                    20_000_000,
                    30_000.0,
                    Some(task_id),
                )
            }),
        };
        if cancelled(state, task_id) {
            break;
        }
        match result {
            Ok(asset) => {
                // Both cache reuse and a new audio commit already retain the
                // asset while atomically checking the task. Re-pinning here would
                // race a concurrent terminal-record cleanup and leak an orphan pin.
                task.results.push(json!({"requestId":item.request_id,"objectId":item.object_id,"asset":asset,"cached":was_cached}));
                task.completed += 1;
            }
            Err(error) => task
                .failures
                .push(json!({"requestId":item.request_id,"objectId":item.object_id,"error":error})),
        }
        task.cancel_requested = cancelled(state, task_id);
        task.updated_at = now();
        put_task(&*state.connection()?, &task)?;
    }
    task.cancel_requested = cancelled(state, task_id);
    task.state = if task.cancel_requested {
        "cancelled"
    } else if task.failures.is_empty() {
        "completed"
    } else if task.results.is_empty() {
        "failed"
    } else {
        "partialFailure"
    }
    .into();
    task.updated_at = now();
    put_task(&*state.connection()?, &task)?;
    // Successful task outputs remain pinned until applied or explicitly cleared; a
    // retry can reuse them even if the original draft has moved on.
    Ok(())
}

pub fn cancel_task(state: &AppState, id: &str) -> AppResult<TaskRecord> {
    let mut task = get_task(state, id)?;
    if matches!(task.state.as_str(), "queued" | "running" | "cancelling") {
        task.cancel_requested = true;
        task.state = "cancelling".into();
        task.updated_at = now();
        put_task(&*state.connection()?, &task)?;
    }
    get_task(state, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercise new, fully reused and partially reused tasks with bundled synthesis.
    /// A new word on the third run must not invalidate the first word's cache.
    #[test]
    #[cfg(windows)]
    fn bundled_task_publishes_real_assets_and_reuses_them() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::open(temp.path().join("课堂 & 声音")).unwrap());
        let items = vec![SpeechItem {
            request_id: "builtin-test".into(),
            object_id: "word".into(),
            text: "achievement".into(),
            language: "en-US".into(),
            voice_id: Some(crate::builtin_speech::ENGLISH.into()),
            rate: 1.0,
        }];
        for run in 0..3 {
            let mut requests = items.clone();
            if run == 2 {
                requests.push(SpeechItem {
                    request_id: "builtin-new".into(),
                    object_id: "new-word".into(),
                    text: "responsibility".into(),
                    ..items[0].clone()
                });
            }
            let task = start_task(state.clone(), requests, None, None, None).unwrap();
            let deadline = Instant::now() + Duration::from_secs(70);
            let result = loop {
                let result = get_task(&state, &task.task_id).unwrap();
                if crate::database::is_terminal_task(&result.state) {
                    break result;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(20));
            };
            assert_eq!(result.state, "completed", "{result:?}");
            assert_eq!(result.completed, if run == 2 { 2 } else { 1 });
            assert_eq!(result.results[0]["cached"], run != 0);
            if run == 2 {
                assert_eq!(result.results[1]["cached"], false);
                assert!(result.results[1]["asset"]["durationMs"].as_f64().unwrap() > 100.0);
            }
            println!(
                "bundled production run {run}: {} outputs, {} reused",
                result.completed,
                result
                    .results
                    .iter()
                    .filter(|item| item["cached"] == true)
                    .count()
            );
            assert!(result.results[0]["asset"]["durationMs"].as_f64().unwrap() > 100.0);
            assert_eq!(
                std::fs::read_dir(state.root.join("tasks")).unwrap().count(),
                0
            );
        }
    }

    /// A real task can consume a previously verified cached PCM file without an
    /// installed voice. This checks creation, input ownership and cleanup, and is
    /// deliberately separate from the explicit WinRT synthesis integration test.
    #[test]
    fn task_creation_copies_input_atomically_and_releases_it_only_when_cleared() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::open(temp.path().join("library")).unwrap());
        let item = SpeechItem {
            request_id: Uuid::new_v4().to_string(),
            object_id: Uuid::new_v4().to_string(),
            text: "responsibility".into(),
            language: "en-US".into(),
            voice_id: Some("cached-test-voice".into()),
            rate: 1.0,
        };
        let key = cache_key(&item).unwrap();
        let asset = store_audio(
            &state,
            &crate::assets::test_pcm(900),
            Some(item.text.clone()),
            Some(&key),
            20_000_000,
            30_000.0,
            None,
        )
        .unwrap();
        let document = crate::database::save_lesson(
            &state,
            json!({
                "id":Uuid::new_v4().to_string(), "name":"任务固定输入", "gameId":"word-beat",
                "dataVersion":1, "gameData":{"assetId":asset.asset_id, "text":item.text}
            }),
            0,
        )
        .unwrap();
        let lesson_id = document["id"].as_str().unwrap();
        assert!(start_task(
            state.clone(),
            vec![item.clone()],
            Some(lesson_id.into()),
            None,
            None
        )
        .is_err());
        assert!(start_task(
            state.clone(),
            vec![item.clone()],
            Some(lesson_id.into()),
            Some(999),
            None
        )
        .is_err());
        assert_eq!(
            state
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, u64>(0))
                .unwrap(),
            0
        );
        let task = start_task(
            state.clone(),
            vec![item],
            Some(lesson_id.into()),
            Some(1),
            None,
        )
        .unwrap();
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id).unwrap(),
            document
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let record = get_task(&state, &task.task_id).unwrap();
            if crate::database::is_terminal_task(&record.state) {
                assert_eq!(
                    record.state, "completed",
                    "cached task must finish: {record:?}"
                );
                break;
            }
            assert!(Instant::now() < deadline, "cached task did not terminate");
            std::thread::sleep(Duration::from_millis(10));
        }
        crate::database::delete_lesson(&state, lesson_id).unwrap();
        assert_eq!(
            crate::database::get_task_input(&state, &task.task_id).unwrap(),
            document
        );
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 0);
        crate::database::clear_task(&state, &task.task_id).unwrap();
        assert_eq!(
            state
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM task_inputs", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        assert_eq!(crate::assets::clean_cache(&state).unwrap(), 1);
    }
    #[test]
    fn cache_identity_preserves_case_and_normalizes_only_whitespace() {
        let mut item = SpeechItem {
            request_id: "request".into(),
            object_id: "object".into(),
            text: "US".into(),
            language: "en-US".into(),
            voice_id: Some("real-id".into()),
            rate: 1.0,
        };
        let upper = cache_key(&item).unwrap();
        item.text = "us".into();
        assert_ne!(upper, cache_key(&item).unwrap());
        item.text = "  US  ".into();
        assert_eq!(upper, cache_key(&item).unwrap());
    }

    #[test]
    fn regional_voice_choices_match_the_editor_language_group_without_cross_language_fallback() {
        assert!(voice_language_matches_content("en-GB", "en-US"));
        assert!(voice_language_matches_content("en-US", "EN-us"));
        assert!(voice_language_matches_content("zh-TW", "zh-CN"));
        assert!(!voice_language_matches_content("zh-CN", "en-US"));
        assert!(!voice_language_matches_content("en-US", "zh-CN"));
        assert!(!voice_language_matches_content("", "en-US"));
        assert!(!voice_language_matches_content("en-US", ""));
    }

    /// Integration test uses the real installed WinRT voice. It generates and
    /// decodes bytes without playing sound or installing/changing Windows resources.
    #[test]
    #[cfg(windows)]
    #[ignore = "requires an installed local English WinRT voice; run explicitly on Windows"]
    fn installed_windows_voice_produces_real_decodable_pcm() {
        let voices = system_voices().expect("Windows voice enumeration failed");
        let voice = voices
            .iter()
            .find(|voice| voice.language.starts_with("en-"))
            .expect("No local English voice is installed");
        let item = SpeechItem {
            request_id: "smoke".into(),
            object_id: "smoke".into(),
            text: "responsibility".into(),
            language: voice.language.clone(),
            voice_id: Some(voice.id.clone()),
            rate: 1.0,
        };
        let bytes = synthesize(&item, || false).expect("Real Windows synthesis failed");
        assert_eq!(crate::assets::detect_mime(&bytes).unwrap(), "audio/wav");
        let duration = crate::assets::audio_duration(&bytes, "audio/wav", 30_000.0).unwrap();
        assert!(duration > 100.0);
        eprintln!(
            "Verified local voice {}, {:.0} ms PCM WAV, {} bytes",
            voice.name,
            duration,
            bytes.len()
        );
        assert_eq!(synthesize(&item, || true).unwrap_err().code, "CANCELLED");
    }

    /// Missing prerequisites must produce the documented repairable error, not a
    /// fabricated WAV or a platform-default voice in the wrong language.
    #[test]
    #[cfg(windows)]
    fn unavailable_windows_voice_returns_a_repairable_error() {
        let item = SpeechItem {
            request_id: "missing".into(),
            object_id: "missing".into(),
            text: "responsibility".into(),
            language: "en-US".into(),
            voice_id: Some("a-voice-that-is-not-installed".into()),
            rate: 1.0,
        };
        assert_eq!(
            synthesize(&item, || false).unwrap_err().code,
            "VOICE_UNAVAILABLE"
        );
    }
}
