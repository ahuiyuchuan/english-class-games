//! Structured IPC failures without leaking full teaching content or native stack traces.
//! Author: ahui.
use serde::Serialize;

/// Stable error contract used by the UI for field focus, retry and persistent messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub field: Option<String>,
    pub retryable: bool,
}

impl AppError {
    /// Create a known business failure. `message` must be suitable for a teacher to read.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            field: None,
            retryable: false,
        }
    }

    /// Mark a stable failure as safe to retry after the user addresses its cause.
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// Associate an error with a specific field rather than clearing the whole form.
    pub fn field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("VALIDATION_ERROR", message)
    }

    /// Convert an operating-system failure while preserving the disk-full contract.
    /// Windows HRESULTs carry a Win32 code in their low 16 bits; native I/O errors
    /// expose the corresponding raw code directly.
    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::io_with_code(error, None)
    }

    /// Convert a filesystem error that exposes its native error code.
    pub fn from_io(error: std::io::Error) -> Self {
        Self::io_with_code(&error, error.raw_os_error())
    }

    /// Convert a Windows API failure whose HRESULT may represent a full volume.
    pub fn windows_io(error: impl std::fmt::Display, hresult: i32) -> Self {
        Self::io_with_code(error, Some(hresult))
    }

    fn io_with_code(error: impl std::fmt::Display, native_code: Option<i32>) -> Self {
        let win32_code = native_code.map(|code| (code as u32 & 0xffff) as i32);
        if matches!(win32_code, Some(28 | 39 | 112)) {
            Self::new(
                "SPACE_INSUFFICIENT",
                "磁盘空间不足，请释放空间或选择其他位置后重试",
            )
            .retryable()
        } else {
            Self::new("FILE_ACCESS_ERROR", format!("文件操作失败：{error}")).retryable()
        }
    }

    /// Convert ZIP failures without presenting corrupt user input as a disk error.
    pub fn zip(error: zip::result::ZipError) -> Self {
        match error {
            zip::result::ZipError::Io(error) => Self::from_io(error),
            zip::result::ZipError::InvalidArchive(_) | zip::result::ZipError::InvalidPassword => {
                Self::new("ASSET_INVALID", "压缩包结构无效、损坏或无法解密")
            }
            zip::result::ZipError::UnsupportedArchive(_) => {
                Self::new("UNSUPPORTED_VERSION", "压缩包使用了当前软件不支持的格式")
            }
            zip::result::ZipError::FileNotFound => Self::new("ASSET_MISSING", "压缩包缺少所需文件"),
            _ => Self::new("ASSET_INVALID", "压缩包无法读取"),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::from_io(value)
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        if matches!(
            &value,
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::DiskFull
        ) {
            Self::new(
                "SPACE_INSUFFICIENT",
                "本地数据库所在磁盘空间不足，请释放空间后重试",
            )
            .retryable()
        } else {
            Self::new("DATABASE_ERROR", format!("本地数据操作失败：{value}")).retryable()
        }
    }
}
impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::validation(format!("数据格式不正确：{value}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_full_filesystem_and_database_errors_use_space_contract() {
        for code in [28, 39, 112, 0x8007_0070_u32 as i32] {
            let error = AppError::from_io(std::io::Error::from_raw_os_error(code));
            assert_eq!(error.code, "SPACE_INSUFFICIENT");
            assert!(error.retryable);
        }
        let error = AppError::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
            None,
        ));
        assert_eq!(error.code, "SPACE_INSUFFICIENT");
        assert!(error.retryable);
    }

    #[test]
    fn corrupt_archives_are_not_reported_as_filesystem_failures() {
        let error = AppError::zip(zip::result::ZipError::InvalidArchive(
            "invalid header".into(),
        ));
        assert_eq!(error.code, "ASSET_INVALID");
        let error = AppError::zip(zip::result::ZipError::Io(
            std::io::Error::from_raw_os_error(112),
        ));
        assert_eq!(error.code, "SPACE_INSUFFICIENT");
    }
}
