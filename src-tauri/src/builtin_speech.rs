//! Bundled CPU speech adapter. Owns only temporary input/output and a bounded
//! child process; published audio still belongs to the existing speech task.
//! Author: ahui.
use crate::{
    error::{AppError, AppResult},
    model::{SpeechItem, VoiceInfo},
};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

pub const ENGLISH: &str = "builtin:melo-zh-en-v1:en";
pub const CHINESE: &str = "builtin:melo-zh-en-v1:zh";
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();

/// Only the application composition root provides the resource path. Renderer
/// input can choose a voice ID, never executable paths or model arguments.
pub fn configure(path: PathBuf) {
    let _ = RESOURCES.set(path);
}
fn resources() -> PathBuf {
    RESOURCES.get().cloned().unwrap_or_else(|| {
        // Native tests/development use the same checked-in distribution resources.
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/tts")
    })
}
pub fn is_builtin(id: Option<&str>) -> bool {
    matches!(id, Some(ENGLISH | CHINESE))
}
/// Enumerate bundled voices only when all required runtime files are present.
/// A damaged installation does not become a fake selectable voice.
pub fn voices() -> Vec<VoiceInfo> {
    let root = resources();
    if ![
        "bin/tts-worker.exe",
        "bin/sherpa-onnx-c-api.dll",
        "bin/onnxruntime.dll",
        "model/model.onnx",
        "model/tokens.txt",
        "model/lexicon.txt",
    ]
    .iter()
    .all(|file| root.join(file).is_file())
    {
        return vec![];
    }
    vec![
        VoiceInfo {
            id: ENGLISH.into(),
            name: "内置英语 · Melo 离线神经配音".into(),
            language: "en-US".into(),
        },
        VoiceInfo {
            id: CHINESE.into(),
            name: "内置中文 · Melo 离线神经配音".into(),
            language: "zh-CN".into(),
        },
    ]
}

/// Drop always drains the child before removing its files, including timeout,
/// cancellation, decoder failure and a Rust early return. Task directory startup
/// recovery removes files left by a hard OS shutdown; worker watches parent death.
struct Work {
    child: Option<Child>,
    input: PathBuf,
    output: PathBuf,
}
impl Drop for Work {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_file(&self.input);
        let _ = std::fs::remove_file(&self.output);
    }
}

/// Synthesize one UTF-8 item (<=200 characters) at 0.75..1.25 speed. Processes
/// are serialized by speech_gate in the caller; no network or shell is involved.
pub fn synthesize(
    item: &SpeechItem,
    tasks: &Path,
    cancel: impl Fn() -> bool,
) -> AppResult<Vec<u8>> {
    let id = item.voice_id.as_deref();
    if !is_builtin(id)
        || (id == Some(ENGLISH) && !item.language.starts_with("en-"))
        || (id == Some(CHINESE) && !item.language.starts_with("zh-"))
    {
        return Err(AppError::new(
            "VOICE_UNAVAILABLE",
            "所选内置音色与内容语言不匹配",
        ));
    }
    if item.text.trim().is_empty()
        || item.text.chars().count() > 200
        || item.text.contains('\0')
        || !item.rate.is_finite()
        || !(0.75..=1.25).contains(&item.rate)
    {
        return Err(AppError::validation("配音文本或语速不合法"));
    }
    if cancel() {
        return Err(AppError::new("CANCELLED", "已取消配音"));
    }
    if voices().is_empty() {
        return Err(AppError::new(
            "VOICE_UNAVAILABLE",
            "内置音色文件缺失，请重新安装完整安装包",
        ));
    }
    let identity = uuid::Uuid::new_v4().to_string();
    let mut work = Work {
        child: None,
        input: tasks.join(format!("{identity}.txt")),
        output: tasks.join(format!("{identity}.wav")),
    };
    std::fs::write(&work.input, item.text.as_bytes())?;
    let root = resources().canonicalize()?;
    let mut command = Command::new(root.join("bin/tts-worker.exe"));
    command
        .current_dir(&root)
        .arg(&work.input)
        .arg(&work.output)
        .arg(item.rate.to_string())
        .arg(std::process::id().to_string())
        .env("PATH", "")
        // The upstream library may print input-related diagnostics. Discard both
        // streams, never log teaching content and never block on a full pipe.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    work.child =
        Some(command.spawn().map_err(|_| {
            AppError::new("SYNTHESIS_FAILED", "无法启动内置配音，请检查安装是否完整")
        })?);
    let started = Instant::now();
    loop {
        if cancel() {
            return Err(AppError::new("CANCELLED", "已取消配音"));
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err(AppError::new(
                "SYNTHESIS_FAILED",
                "此项内置配音超过60秒，已停止；可重试或缩短文本",
            ));
        }
        if let Some(status) = work.child.as_mut().unwrap().try_wait()? {
            if !status.success() {
                return Err(AppError::new(
                    "SYNTHESIS_FAILED",
                    "内置配音未完成，请检查文本后重试；单项声音限30秒",
                ));
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if cancel() {
        return Err(AppError::new("CANCELLED", "已取消配音"));
    }
    crate::assets::read_limited(&work.output, 20_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Real engine/model files, no installed Windows voices and no generated mocks.
    #[test]
    #[cfg(windows)]
    fn bundled_english_chinese_and_cancel_are_real_and_clean() {
        let temp = tempfile::Builder::new()
            .prefix("内置配音 & ")
            .tempdir()
            .unwrap();
        for (voice, language, text) in [
            (ENGLISH, "en-US", "responsibility. make a difference."),
            (CHINESE, "zh-CN", "准备好，跟着节奏开口。"),
        ] {
            let item = SpeechItem {
                request_id: "test".into(),
                object_id: "test".into(),
                text: text.into(),
                language: language.into(),
                voice_id: Some(voice.into()),
                rate: 1.0,
            };
            let bytes = synthesize(&item, temp.path(), || false).unwrap();
            let duration = crate::assets::audio_duration(&bytes, "audio/wav", 30_000.0).unwrap();
            assert!(duration > 300.0);
            if let Ok(folder) = std::env::var("ECG_TTS_EVIDENCE") {
                std::fs::write(Path::new(&folder).join(format!("{language}.wav")), &bytes).unwrap();
            }
            let start = Instant::now();
            assert_eq!(
                synthesize(&item, temp.path(), || start.elapsed()
                    > Duration::from_millis(100))
                .unwrap_err()
                .code,
                "CANCELLED"
            );
            assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        }
    }
}
