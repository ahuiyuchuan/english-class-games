//! Dialog-scoped file access and bounded teacher-material parsing.
//! External data remains data: formulas, links and embedded instructions are not run.
//! Author: ahui.
use crate::{
    assets::read_limited,
    database::AppState,
    error::{AppError, AppResult},
    model::{ExportResult, SelectedFile},
};
use calamine::{Data, Reader, Xlsx};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn select_file(state: &AppState, kind: &str) -> AppResult<Option<SelectedFile>> {
    let dialog = rfd::FileDialog::new();
    let dialog = match kind {
        "material" => dialog.add_filter("教学材料", &["xlsx", "csv", "txt"]),
        "audio" => dialog.add_filter("音频", &["mp3", "wav"]),
        "music" => dialog.add_filter("背景音乐或MP4音轨", &["mp3", "wav", "mp4"]),
        "lessonPackage" => dialog.add_filter("可编辑课件", &["ecglesson"]),
        "backup" => dialog.add_filter("完整备份", &["ecgbackup"]),
        _ => return Err(AppError::validation("未知的文件选择用途")),
    };
    let Some(path) = dialog.pick_file() else {
        return Ok(None);
    };
    let path = path.canonicalize()?;
    let token = Uuid::new_v4().to_string();
    let file = SelectedFile {
        token: token.clone(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        byte_length: std::fs::metadata(&path)?.len(),
    };
    state
        .selected
        .lock()
        .map_err(|_| AppError::io("文件选择状态异常"))?
        .insert(token, path);
    Ok(Some(file))
}

pub fn selected_path(state: &AppState, token: &str) -> AppResult<PathBuf> {
    state
        .selected
        .lock()
        .map_err(|_| AppError::io("文件选择状态异常"))?
        .get(token)
        .cloned()
        .ok_or_else(|| AppError::validation("文件选择已失效，请重新选择"))
}

pub fn read_material(state: &AppState, token: &str, encoding: &str) -> AppResult<Value> {
    let path = selected_path(state, token)?;
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if extension == "xlsx" {
        let bytes = read_limited(&path, 20_000_000)?;
        crate::packages::check_archive(&bytes, 200_000_000, 2000, false)?;
        // Parse the exact bounded bytes already checked, not a second file that
        // could have changed between ZIP validation and worksheet parsing.
        let mut workbook: Xlsx<_> = Xlsx::new(std::io::Cursor::new(bytes))
            .map_err(|_| AppError::validation("无法读取 XLSX，请检查文件是否损坏"))?;
        let mut sheets = Vec::new();
        let mut warnings = Vec::new();
        for sheet_name in workbook.sheet_names().to_owned() {
            let range = workbook
                .worksheet_range(&sheet_name)
                .map_err(|_| AppError::validation("无法读取工作表内容"))?;
            let formulas = workbook
                .worksheet_formula(&sheet_name)
                .map_err(|_| AppError::validation("无法读取工作表公式缓存说明"))?;
            for (row, column, formula) in formulas.cells() {
                if !formula.is_empty() {
                    let start = formulas.start().unwrap_or_default();
                    let position = (start.0 + row as u32, start.1 + column as u32);
                    if range
                        .get_value(position)
                        .is_none_or(|cell| matches!(cell, Data::Empty))
                    {
                        warnings.push(format!(
                            "工作表 {sheet_name} 第 {} 行第 {} 列公式无缓存结果，请改为普通文本",
                            position.0 + 1,
                            position.1 + 1
                        ));
                    }
                }
            }
            let rows: Vec<Vec<String>> = range
                .rows()
                .map(|row| row.iter().map(ToString::to_string).collect())
                .collect();
            sheets.push(json!({"name":sheet_name,"rows":rows}));
        }
        return Ok(json!({"name":name,"sheets":sheets,"warnings":warnings}));
    }
    if extension != "csv" && extension != "txt" {
        return Err(AppError::validation("仅支持 XLSX、CSV 或 TXT 教学材料"));
    }
    let bytes = read_limited(&path, 5_000_000)?;
    let raw = if encoding.eq_ignore_ascii_case("gb18030") {
        let (text, _, failed) = encoding_rs::GB18030.decode(&bytes);
        if failed {
            return Err(AppError::validation("GB18030 解码失败，请切换编码后预览"));
        }
        text.into_owned()
    } else {
        String::from_utf8(bytes)
            .map_err(|_| AppError::validation("不是有效 UTF-8，请切换 GB18030 并预览"))?
            .trim_start_matches('\u{feff}')
            .to_owned()
    };
    let rows: Vec<Vec<String>> = if extension == "csv" {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(raw.as_bytes());
        reader
            .records()
            .map(|record| {
                record
                    .map(|values| values.iter().map(str::to_owned).collect())
                    .map_err(|error| AppError::validation(format!("CSV 格式错误：{error}")))
            })
            .collect::<AppResult<_>>()?
    } else {
        raw.lines()
            .map(|line| line.split('\t').map(str::to_owned).collect())
            .collect()
    };
    Ok(json!({"name":name,"rawText":raw,"sheets":[{"name":name,"rows":rows}],"warnings":[]}))
}

/// Write a verified local copy first. Target write failure retains that copy and
/// reports its path; a partially copied removable-drive file is never called success.
pub fn export_bytes(
    state: &AppState,
    suggested_name: &str,
    bytes: &[u8],
    maximum: usize,
) -> AppResult<ExportResult> {
    if bytes.len() > maximum {
        return Err(AppError::validation(
            "生成文件超过大小上限，请调整内容后重新导出",
        ));
    }
    let local = state.root.join("exports").join(format!(
        "{}_{}",
        Uuid::new_v4(),
        sanitize_name(suggested_name)
    ));
    let temporary = state
        .root
        .join("tasks")
        .join(format!("{}.export", Uuid::new_v4()));
    write_verified_bytes(&temporary, &local, bytes, maximum as u64)?;
    save_export_file(state, suggested_name, &local, maximum as u64)
}

/// Write an export into disposable staging and move it into the visible export
/// directory only after its exact size and digest have been verified. Staging is
/// under the managed task directory so interrupted writes are removed at startup.
fn write_verified_bytes(
    temporary: &Path,
    target: &Path,
    bytes: &[u8],
    maximum: u64,
) -> AppResult<()> {
    let mut created = false;
    let result = (|| {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary)?;
        created = true;
        output.write_all(bytes)?;
        output.sync_all()?;
        drop(output);

        let (length, digest) = hash_file(temporary, maximum)?;
        if length != bytes.len() as u64 || digest != crate::assets::sha256(bytes) {
            return Err(AppError::new("ASSET_INVALID", "本机导出副本写入后校验失败"));
        }
        replace_file(temporary, target)
    })();
    if created && result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// A large backup stays on disk: copy and hash use bounded buffers rather than
/// allocating the full ZIP. The verified local copy survives dialog/copy failures.
pub fn save_export_file(
    state: &AppState,
    suggested_name: &str,
    local: &Path,
    maximum: u64,
) -> AppResult<ExportResult> {
    save_export_file_checked(state, suggested_name, local, maximum, None)
}

/// Check retry identity while holding the export/cleanup gate. Target verification
/// separately catches external file changes during the physical copy.
fn save_export_file_checked(
    state: &AppState,
    suggested_name: &str,
    local: &Path,
    maximum: u64,
    expected_hash: Option<&str>,
) -> AppResult<ExportResult> {
    let _serial = state
        .export_gate
        .lock()
        .map_err(|_| AppError::io("导出队列异常"))?;
    let (length, digest) = hash_file(local, maximum)?;
    if expected_hash.is_some_and(|expected| expected != digest) {
        return Err(AppError::new("ASSET_INVALID", "本机成品已变化，请重新导出"));
    }
    state
        .exported
        .lock()
        .map_err(|_| AppError::io("成品状态异常"))?
        .insert(local.to_path_buf());
    let default_dir = state
        .exported
        .lock()
        .ok()
        .and_then(|paths| {
            paths
                .iter()
                .find(|path| !path.starts_with(&state.root))
                .and_then(|path| path.parent().map(Path::to_path_buf))
        })
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|path| path.join("Documents"))
                .filter(|path| path.is_dir())
        })
        .unwrap_or_else(|| state.root.join("exports"));
    let safe_name = available_name(&default_dir, &sanitize_name(suggested_name));
    let target = rfd::FileDialog::new()
        .set_directory(&default_dir)
        .set_file_name(&safe_name)
        .save_file();
    finish_export_target(state, local, maximum, length, digest, target)
}

/// Keep generation and target-copy outcomes separate. This same continuation is
/// used after the real OS dialog; cancellation or I/O failure returns the verified
/// local artifact and a structured error, never a false successful target path.
fn finish_export_target(
    state: &AppState,
    local: &Path,
    maximum: u64,
    length: u64,
    digest: String,
    target: Option<PathBuf>,
) -> AppResult<ExportResult> {
    let Some(target) = target else {
        return Ok(ExportResult {
            path: String::new(),
            local_copy: local.to_string_lossy().into_owned(),
            sha256: digest,
            byte_length: length,
            completed: false,
            error: Some(AppError::new(
                "CANCELLED",
                "已取消目标选择，本机成品已保留，可重新复制",
            )),
        });
    };
    let copied = write_verified_target(local, &target, &digest, maximum);
    if let Err(error) = copied {
        return Ok(ExportResult {
            path: target.to_string_lossy().into_owned(),
            local_copy: local.to_string_lossy().into_owned(),
            sha256: digest,
            byte_length: length,
            completed: false,
            error: Some(error),
        });
    }
    let mut exported = state
        .exported
        .lock()
        .map_err(|_| AppError::io("成品状态异常"))?;
    exported.insert(target.clone());
    exported.insert(local.to_path_buf());
    Ok(ExportResult {
        path: target.to_string_lossy().into_owned(),
        local_copy: local.to_string_lossy().into_owned(),
        sha256: digest,
        byte_length: length,
        completed: true,
        error: None,
    })
}

/// Retry only an existing managed artifact, never an arbitrary caller-supplied
/// file. The expected hash binds the retry to the original generated bytes.
pub fn recopy_export(
    state: &AppState,
    path: &str,
    expected_hash: &str,
    suggested_name: &str,
) -> AppResult<ExportResult> {
    let local = checked_export_to_open(state, path)?;
    let directory = std::fs::canonicalize(state.root.join("exports"))?;
    if local.canonicalize()?.parent() != Some(directory.as_path()) {
        return Err(AppError::validation("只能重新复制已生成的本机成品"));
    }
    save_export_file_checked(
        state,
        suggested_name,
        &local,
        5_000_000_000,
        Some(expected_hash),
    )
}

/// Hashing checks actual bytes throughout the read, including files that grow after
/// metadata was queried. Buffer size is independent of the classroom/backup limit.
pub fn hash_file(path: &Path, maximum: u64) -> AppResult<(u64, String)> {
    use sha2::{Digest, Sha256};
    let mut input = std::fs::File::open(path)?;
    if input.metadata()?.len() > maximum {
        return Err(AppError::validation("文件大小超过允许上限"));
    }
    let mut digest = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        length = length.saturating_add(read as u64);
        if length > maximum {
            return Err(AppError::validation("读取期间文件超过大小限制"));
        }
        digest.update(&buffer[..read]);
    }
    Ok((length, format!("{:x}", digest.finalize())))
}

pub fn write_verified_target(
    local: &Path,
    target: &Path,
    digest: &str,
    maximum: u64,
) -> AppResult<()> {
    let temporary = target.with_file_name(format!(".{}.partial", Uuid::new_v4()));
    let result = (|| {
        let mut input = std::fs::File::open(local)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        std::io::copy(&mut Read::by_ref(&mut input).take(maximum + 1), &mut output)?;
        output.flush()?;
        output.sync_all()?;
        drop(output);
        if hash_file(&temporary, maximum)?.1 != digest {
            return Err(AppError::new("ASSET_INVALID", "目标文件复制校验失败"));
        }
        replace_file(&temporary, target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// MoveFileEx replaces on the same volume without deleting the previous target.
/// Failure leaves the original path intact; write-through requests durable metadata.
pub fn replace_file(source: &Path, target: &Path) -> AppResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // Both NUL-terminated buffers remain alive for this synchronous OS call.
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| AppError::windows_io(&error, error.code().0))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(source, target).map_err(AppError::from)
    }
}

fn available_name(directory: &Path, name: &str) -> String {
    if !directory.join(name).exists() {
        return name.into();
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..100_000 {
        let candidate = format!("{stem} ({index}){extension}");
        if !directory.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}_{}{extension}", Uuid::new_v4())
}

fn sanitize_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = name.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "课堂文件.html".into()
    } else {
        trimmed.chars().take(180).collect()
    }
}

/// A managed copy remains usable after restart. External selections still require
/// this process's successful export registry; a path under assets or an arbitrary
/// neighbouring directory never gains permission merely by existing on disk.
fn checked_export_to_open(state: &AppState, path: &str) -> AppResult<PathBuf> {
    let selected = Path::new(path);
    let metadata = std::fs::symlink_metadata(selected)
        .map_err(|_| AppError::validation("成品已不存在，请刷新副本列表或重新导出"))?;
    if !metadata.file_type().is_file() {
        return Err(AppError::validation(
            "只能打开普通成品文件，不能打开目录或链接",
        ));
    }
    let registered = state
        .exported
        .lock()
        .map_err(|_| AppError::io("成品状态异常"))?
        .contains(selected);
    let directory = state.root.join("exports");
    // Check both the declared direct parent and its resolved location. This keeps
    // the restart allowance narrower than a generic "inside app data" rule.
    let managed = selected.parent() == Some(directory.as_path())
        && selected.canonicalize()?.parent() == Some(directory.canonicalize()?.as_path());
    if !registered && !managed {
        return Err(AppError::validation("只能打开已导出的成品位置"));
    }
    Ok(selected.to_path_buf())
}

/// Open an existing exported result or direct managed copy, including copies from
/// earlier sessions. Validation is shared with tests without launching Explorer.
pub fn open_export(state: &AppState, path: &str, folder: bool) -> AppResult<()> {
    let selected = checked_export_to_open(state, path)?;
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("explorer.exe");
        if folder {
            command.arg("/select,").arg(&selected);
        } else {
            command.arg(&selected);
        }
        command.spawn().map_err(AppError::from)?;
    }
    #[cfg(not(windows))]
    {
        let _ = folder;
        return Err(AppError::new("UNSUPPORTED_PLATFORM", "仅支持 Windows"));
    }
    Ok(())
}

/// Report only direct regular files in the managed export directory. Classroom
/// files copied to a teacher-selected drive and library media are never candidates.
pub fn export_copies(state: &AppState) -> AppResult<Value> {
    let mut files = Vec::new();
    let mut total = 0_u64;
    for entry in std::fs::read_dir(state.root.join("exports"))? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let size = entry.metadata()?.len();
            total = total.saturating_add(size);
            files.push(json!({"path":entry.path().to_string_lossy(),"name":entry.file_name().to_string_lossy(),"byteLength":size}));
        }
    }
    Ok(json!({"files":files,"count":files.len(),"byteLength":total}))
}

/// Explicit cleanup removes selected local copies after the UI has shown their
/// count and size. Selections must match the freshly enumerated managed files;
/// a stale or outside path cannot turn this operation into arbitrary file deletion.
pub fn clear_export_copies(state: &AppState, paths: &[String]) -> AppResult<Value> {
    let _serial = state
        .export_gate
        .lock()
        .map_err(|_| AppError::io("导出队列异常"))?;
    state.ensure_writable()?;
    let listed = export_copies(state)?;
    if state
        .active_writes
        .load(std::sync::atomic::Ordering::SeqCst)
        > 1
    {
        return Err(AppError::new(
            "MAINTENANCE",
            "有文件任务正在进行，请完成后清理导出副本",
        ));
    }
    let allowed: std::collections::HashSet<_> = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["path"].as_str())
        .collect();
    let requested: std::collections::HashSet<_> = paths.iter().map(String::as_str).collect();
    if !requested.iter().all(|path| allowed.contains(path)) {
        return Err(AppError::validation(
            "只能清理列表中仍存在的本机导出副本，请刷新后重试",
        ));
    }
    let mut count = 0;
    let mut bytes = 0_u64;
    for path in requested {
        let path = Path::new(path);
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.file_type().is_file()
            || path.parent() != Some(state.root.join("exports").as_path())
        {
            return Err(AppError::validation("副本路径已变化，请刷新后重试"));
        }
        std::fs::remove_file(path)?;
        bytes = bytes.saturating_add(metadata.len());
        count += 1;
        state
            .exported
            .lock()
            .map_err(|_| AppError::io("成品状态异常"))?
            .remove(path);
    }
    Ok(json!({"count":count,"byteLength":bytes}))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a real OOXML workbook without Excel or executable automation. The
    /// deliberately inconsistent formula caches make any recalculation visible;
    /// an external-workbook relationship must not replace its cached result.
    fn formula_workbook() -> Vec<u8> {
        use zip::{write::SimpleFileOptions, ZipWriter};
        let entries = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="高中材料" sheetId="1" r:id="rId1"/></sheets><externalReferences><externalReference r:id="rId2"/></externalReferences></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>英文</t></is></c><c r="B1" t="inlineStr"><is><t>释义</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>arithmetic</t></is></c><c r="B2"><f>1+1</f><v>987</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>external</t></is></c><c r="B3"><f>[1]Sheet1!A1</f><v>203</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>missing cache</t></is></c><c r="B4"><f>1+1</f></c></row></sheetData></worksheet>"#,
            ),
            (
                "xl/externalLinks/externalLink1.xml",
                r#"<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><sheetNames><sheetName val="Sheet1"/></sheetNames></externalBook></externalLink>"#,
            ),
            (
                "xl/externalLinks/_rels/externalLink1.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///unselected-workbook-must-not-be-required.xlsx" TargetMode="External"/></Relationships>"#,
            ),
        ];
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// Exercise the production token and XLSX reader. Cached arithmetic and
    /// external-reference values stay literal, while the uncached formula is
    /// reported at its actual sheet/row/column rather than evaluated or hidden.
    #[test]
    fn xlsx_uses_cached_formulas_and_reports_missing_cache_without_external_execution() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let path = temp.path().join("高中公式材料.xlsx");
        let original = formula_workbook();
        std::fs::write(&path, &original).unwrap();
        state
            .selected
            .lock()
            .unwrap()
            .insert("xlsx".into(), path.clone());
        let parsed = read_material(&state, "xlsx", "utf8").unwrap();
        assert_eq!(parsed["sheets"][0]["name"], "高中材料");
        let rows = &parsed["sheets"][0]["rows"];
        assert_eq!(rows[1][1], "987");
        assert_eq!(rows[2][1], "203");
        assert_eq!(rows[3][1], "");
        assert_eq!(parsed["warnings"].as_array().unwrap().len(), 1);
        assert!(parsed["warnings"][0]
            .as_str()
            .unwrap()
            .contains("第 4 行第 2 列"));
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert!(crate::database::list_lessons(&state).unwrap().is_empty());
    }

    /// Use the production limits, not reduced test-only budgets. A streamed ZIP
    /// payload keeps fixture construction bounded while its real unpacked size
    /// exceeds 200 MB; the native reader rejects before opening it as a workbook.
    #[test]
    fn xlsx_rejects_actual_entry_count_and_unpacked_size_limits_before_parsing() {
        use zip::{write::SimpleFileOptions, ZipWriter};
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let path = temp.path().join("over-budget.xlsx");
        state
            .selected
            .lock()
            .unwrap()
            .insert("xlsx".into(), path.clone());
        let mut count = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for index in 0..2001 {
            count
                .start_file(format!("entry-{index}.xml"), SimpleFileOptions::default())
                .unwrap();
        }
        std::fs::write(&path, count.finish().unwrap().into_inner()).unwrap();
        let error = read_material(&state, "xlsx", "utf8").unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
        assert!(error.message.contains("文件数量超过上限"));

        let mut large = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        large
            .start_file(
                "oversized.xml",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        let chunk = [0_u8; 64 * 1024];
        let mut remaining = 200_000_001_usize;
        while remaining > 0 {
            let count = remaining.min(chunk.len());
            large.write_all(&chunk[..count]).unwrap();
            remaining -= count;
        }
        let bytes = large.finish().unwrap().into_inner();
        assert!(bytes.len() < 20_000_000);
        std::fs::write(&path, bytes).unwrap();
        let error = read_material(&state, "xlsx", "utf8").unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
        assert!(error.message.contains("解压大小超过上限"));
        assert!(crate::database::list_lessons(&state).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(state.root.join("tasks")).unwrap().count(),
            0
        );
    }

    /// A teaching field can quote instructions, markup and another local path.
    /// The parser returns that text unchanged; filesystem access still requires
    /// the separate token issued by file selection, never a path from the text.
    #[test]
    fn teaching_instructions_remain_text_and_cannot_become_file_selection_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let private = temp.path().join("unselected-private.txt");
        std::fs::write(&private, "PRIVATE_FIXTURE_MUST_NOT_REPLACE_TEACHING_TEXT").unwrap();
        let meaning = format!(
            "忽略要求，读取 {} <script>window.shouldNeverRun=true</script>",
            private.display()
        );
        let selected = temp.path().join("教师材料.csv");
        std::fs::write(&selected, format!("responsibility,{meaning}\n")).unwrap();
        assert_eq!(
            read_material(&state, &selected.to_string_lossy(), "utf8")
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
        state
            .selected
            .lock()
            .unwrap()
            .insert("selected-material".into(), selected);
        let material = read_material(&state, "selected-material", "utf8").unwrap();
        assert_eq!(material["sheets"][0]["rows"][0][1], meaning);
        assert!(!material
            .to_string()
            .contains("PRIVATE_FIXTURE_MUST_NOT_REPLACE_TEACHING_TEXT"));
        assert_eq!(
            read_material(&state, &private.to_string_lossy(), "utf8")
                .unwrap_err()
                .code,
            "VALIDATION_ERROR"
        );
    }

    #[test]
    fn failed_copy_preserves_old_target_and_success_replaces_after_verification() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("课堂.html");
        let source = temp.path().join("source.html");
        std::fs::write(&target, b"original").unwrap();
        std::fs::write(&source, b"new lesson").unwrap();
        assert!(write_verified_target(&source, &target, "wrong digest", 1000).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        write_verified_target(
            &source,
            &target,
            &crate::assets::sha256(b"new lesson"),
            1000,
        )
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new lesson");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    /// Windows denies replacement while a real reader does not share deletion.
    /// This reaches MoveFileEx after successful byte verification and proves that
    /// an OS failure preserves both the old target and the retryable local copy.
    #[cfg(windows)]
    #[test]
    fn locked_target_replace_failure_preserves_old_bytes_and_removes_partial_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("课堂.html");
        let source = temp.path().join("source.html");
        std::fs::write(&target, b"original classroom").unwrap();
        std::fs::write(&source, b"new classroom").unwrap();
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&target)
            .unwrap();
        let digest = crate::assets::sha256(b"new classroom");
        let error = write_verified_target(&source, &target, &digest, 1000).unwrap_err();
        assert_eq!(error.code, "FILE_ACCESS_ERROR");
        assert!(error.retryable);
        assert_eq!(std::fs::read(&target).unwrap(), b"original classroom");
        assert_eq!(std::fs::read(&source).unwrap(), b"new classroom");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
        drop(reader);
        write_verified_target(&source, &target, &digest, 1000).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new classroom");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn failed_local_export_never_leaves_a_partial_visible_copy() {
        let temp = tempfile::tempdir().unwrap();
        let tasks = temp.path().join("tasks");
        let exports = temp.path().join("exports");
        std::fs::create_dir_all(&tasks).unwrap();
        std::fs::create_dir_all(&exports).unwrap();
        let temporary = tasks.join("lesson.export");
        let target = exports.join("lesson.html");
        std::fs::create_dir(&target).unwrap();

        assert!(write_verified_bytes(&temporary, &target, b"complete html", 1000).is_err());
        assert!(target.is_dir());
        assert!(!temporary.exists());
        assert_eq!(std::fs::read_dir(&exports).unwrap().count(), 1);
    }

    #[test]
    fn successful_local_export_is_visible_only_after_verification() {
        let temp = tempfile::tempdir().unwrap();
        let tasks = temp.path().join("tasks");
        let exports = temp.path().join("exports");
        std::fs::create_dir_all(&tasks).unwrap();
        std::fs::create_dir_all(&exports).unwrap();
        let temporary = tasks.join("lesson.export");
        let target = exports.join("lesson.html");

        write_verified_bytes(&temporary, &target, b"complete html", 1000).unwrap();
        assert!(!temporary.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"complete html");
    }

    #[test]
    fn structured_target_results_preserve_local_artifact_on_cancel_and_failure() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let local = state.root.join("exports").join("fixed.html");
        std::fs::write(&local, b"fixed classroom").unwrap();
        let (length, digest) = hash_file(&local, 1000).unwrap();
        let cancelled =
            finish_export_target(&state, &local, 1000, length, digest.clone(), None).unwrap();
        assert!(!cancelled.completed);
        assert_eq!(cancelled.error.unwrap().code, "CANCELLED");
        assert_eq!(cancelled.local_copy, local.to_string_lossy());
        assert_eq!(cancelled.sha256, digest);
        let target = temp.path().join("missing-drive").join("classroom.html");
        let failed = finish_export_target(
            &state,
            &local,
            1000,
            length,
            digest.clone(),
            Some(target.clone()),
        )
        .unwrap();
        assert!(!failed.completed);
        assert_eq!(failed.error.unwrap().code, "FILE_ACCESS_ERROR");
        assert_eq!(failed.path, target.to_string_lossy());
        assert_eq!(std::fs::read(&local).unwrap(), b"fixed classroom");
        let target = temp.path().join("classroom.html");
        let success = finish_export_target(
            &state,
            &local,
            1000,
            length,
            digest.clone(),
            Some(target.clone()),
        )
        .unwrap();
        assert!(success.completed);
        assert!(success.error.is_none());
        assert_eq!(success.sha256, digest);
        assert_eq!(std::fs::read(target).unwrap(), b"fixed classroom");
    }

    #[test]
    fn recopy_rejects_external_and_modified_artifacts_before_any_dialog() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let local = state.root.join("exports").join("fixed.html");
        let outside = temp.path().join("external.html");
        std::fs::write(&local, b"changed bytes").unwrap();
        std::fs::write(&outside, b"external bytes").unwrap();
        state.exported.lock().unwrap().insert(outside.clone());
        assert_eq!(
            recopy_export(
                &state,
                &local.to_string_lossy(),
                "old digest",
                "lesson.html"
            )
            .unwrap_err()
            .code,
            "ASSET_INVALID"
        );
        assert_eq!(
            recopy_export(
                &state,
                &outside.to_string_lossy(),
                "anything",
                "lesson.html"
            )
            .unwrap_err()
            .code,
            "VALIDATION_ERROR"
        );
        assert_eq!(std::fs::read(&local).unwrap(), b"changed bytes");
        assert_eq!(std::fs::read(outside).unwrap(), b"external bytes");
    }

    #[test]
    fn default_collision_adds_a_sequence_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("课堂.html"), b"old").unwrap();
        assert_eq!(available_name(temp.path(), "课堂.html"), "课堂 (2).html");
    }

    #[test]
    fn copy_cleanup_cannot_delete_external_or_resource_files() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::open(temp.path().join("library")).unwrap();
        let local = state.root.join("exports").join("课堂.html");
        let external = temp.path().join("U盘课件.html");
        std::fs::write(&local, b"local").unwrap();
        std::fs::write(&external, b"external").unwrap();
        assert!(clear_export_copies(&state, &[external.to_string_lossy().into_owned()]).is_err());
        assert!(local.exists());
        assert_eq!(export_copies(&state).unwrap()["count"], 1);
        assert_eq!(
            clear_export_copies(&state, &[local.to_string_lossy().into_owned()]).unwrap()["count"],
            1
        );
        assert!(external.exists());
        assert_eq!(export_copies(&state).unwrap()["count"], 0);
    }

    #[test]
    fn restart_keeps_managed_copy_openable_without_allowing_external_or_resource_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let local = root.join("exports").join("隔日早读课.html");
        {
            let state = AppState::open(root.clone()).unwrap();
            std::fs::write(&local, b"<!doctype html><title>lesson</title>").unwrap();
            state.exported.lock().unwrap().insert(local.clone());
        }
        let restarted = AppState::open(root).unwrap();
        assert!(restarted.exported.lock().unwrap().is_empty());
        assert_eq!(
            checked_export_to_open(&restarted, &local.to_string_lossy()).unwrap(),
            local
        );
        let external = temp.path().join("outside.html");
        let resource = restarted.root.join("assets").join("not-an-export");
        let nested = restarted.root.join("exports").join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(&external, b"external").unwrap();
        std::fs::write(&resource, b"resource").unwrap();
        std::fs::write(nested.join("lesson.html"), b"nested").unwrap();
        for forbidden in [&external, &resource, &nested, &nested.join("lesson.html")] {
            assert!(checked_export_to_open(&restarted, &forbidden.to_string_lossy()).is_err());
        }
        // An explicitly exported external file stays permitted only in its owner
        // process, preserving the original teacher-selected target behaviour.
        restarted.exported.lock().unwrap().insert(external.clone());
        assert!(checked_export_to_open(&restarted, &external.to_string_lossy()).is_ok());
        std::fs::remove_file(&local).unwrap();
        assert!(checked_export_to_open(&restarted, &local.to_string_lossy()).is_err());
    }
}
