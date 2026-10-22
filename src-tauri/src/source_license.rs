//! Open the packaged source-access receipt, never a renderer URL/path. The full
//! corresponding source is a separate same-version release asset, not duplicated
//! in the installer; offline physical delivery must carry that ZIP alongside it.
//! Copyright (c) 2026 ahui. SPDX-License-Identifier: GPL-3.0-only
use crate::error::{AppError, AppResult};
use tauri::Manager;

/// The receipt must identify the same version and fixed full-source asset. This
/// validates local packaging only; it does not claim a download was performed.
fn validate_receipt(value: &serde_json::Value) -> AppResult<()> {
    let expected_name = format!(
        "English-Class-Games-v{}-Source.zip",
        env!("CARGO_PKG_VERSION")
    );
    let hash_valid = value["sha256"].as_str().is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    });
    if value["version"] != env!("CARGO_PKG_VERSION")
        || value["license"] != "GPL-3.0-only"
        || value["fileName"] != expected_name
        || value["downloadUrl"] != crate::project_links::SOURCE_URL
        || !value["bytes"].as_u64().is_some_and(|bytes| bytes > 0)
        || !hash_valid
    {
        return Err(AppError::validation(
            "源码获取说明与当前软件不匹配，请重新安装完整发行版。",
        ));
    }
    Ok(())
}

/// Open only the local license/receipt directory. A missing or invalid receipt
/// fails visibly; absence of a bundled full ZIP is the intended compact package.
#[tauri::command]
pub fn open_source_directory(app: tauri::AppHandle) -> AppResult<()> {
    let directory = app
        .path()
        .resource_dir()
        .map_err(AppError::io)?
        .join("resources/source");
    let receipt = directory.join("desktop-source.json");
    if !receipt.is_file() || std::fs::metadata(&receipt)?.len() > 16_384 {
        return Err(AppError::validation(
            "安装目录缺少有效的源码获取说明，请从完整发行版重新安装。",
        ));
    }
    validate_receipt(&serde_json::from_slice(&std::fs::read(receipt)?)?)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(directory)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(AppError::from_io)?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err(AppError::validation("此桌面功能仅支持Windows"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_receipt_requires_exact_version_asset_and_digest() {
        let receipt = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "license": "GPL-3.0-only",
            "fileName": format!("English-Class-Games-v{}-Source.zip", env!("CARGO_PKG_VERSION")),
            "downloadUrl": crate::project_links::SOURCE_URL,
            "bytes": 123,
            "sha256": "a".repeat(64)
        });
        assert!(validate_receipt(&receipt).is_ok());
        for (key, invalid) in [
            ("version", serde_json::json!("0.0.0")),
            ("license", serde_json::json!("MIT")),
            ("fileName", serde_json::json!("Source-code.zip")),
            (
                "downloadUrl",
                serde_json::json!("https://example.com/source"),
            ),
            ("sha256", serde_json::json!("a")),
            ("bytes", serde_json::json!(0)),
        ] {
            let mut changed = receipt.clone();
            changed[key] = invalid;
            assert!(validate_receipt(&changed).is_err(), "{key}");
        }
    }
}
