//! 关于页的固定项目链接。只接受目的标识，不允许渲染进程传入任意 URL 或命令。
//! Author: ahui.
use crate::error::{AppError, AppResult};

/// 与安装器内的源码收据一致；完整附件代替仓库主页或自动生成的源码快照。
pub(crate) const SOURCE_URL: &str = concat!(
    "https://github.com/ahuiyuchuan/english-class-games/releases/download/v",
    env!("CARGO_PKG_VERSION"),
    "/English-Class-Games-v",
    env!("CARGO_PKG_VERSION"),
    "-Source.zip"
);

/// 保留完整 HTTPS 地址；此映射不读写教师资料，也不访问网络检查更新。
fn destination_url(destination: &str) -> AppResult<&'static str> {
    match destination {
        "repository" => Ok("https://github.com/ahuiyuchuan/english-class-games"),
        "issues" => Ok("https://github.com/ahuiyuchuan/english-class-games/issues"),
        "releases" => Ok("https://github.com/ahuiyuchuan/english-class-games/releases"),
        "source" => Ok(SOURCE_URL),
        _ => Err(AppError::validation("不支持的项目链接")),
    }
}

/// 交由 Windows 默认浏览器打开固定链接；启动失败返回可重试错误，不宣称网页已加载。
#[tauri::command]
pub fn open_project_link(destination: String) -> AppResult<()> {
    let url = destination_url(&destination)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(url)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(AppError::from_io)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err(AppError::validation("此桌面功能仅支持 Windows"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_links_reject_arbitrary_urls_and_commands() {
        for input in [
            "https://example.com",
            "file:///C:/",
            "cmd.exe",
            "",
            "repository&calc",
        ] {
            assert!(destination_url(input).is_err());
        }
        for name in ["repository", "issues", "releases", "source"] {
            assert!(destination_url(name)
                .unwrap()
                .starts_with("https://github.com/ahuiyuchuan/english-class-games"));
        }
    }
}
