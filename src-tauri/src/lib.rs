//! Windows desktop composition root. Platform services do not implement game rules.
//! Author: ahui.
mod assets;
mod backups;
mod builtin_speech;
mod commands;
mod database;
mod error;
mod files;
mod identities;
mod model;
mod music_import;
mod packages;
mod project_links;
mod source_license;
mod speech;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_local_data_dir()?.join("english-class-games");
            let state = database::AppState::open(root)?;
            builtin_speech::configure(app.path().resource_dir()?.join("resources/tts"));
            music_import::seed_builtin(
                &state,
                &app.path()
                    .resource_dir()?
                    .join("resources/music/word-beat-bgm.wav"),
            )?;
            app.manage(Arc::new(state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_links::open_project_link,
            source_license::open_source_directory,
            commands::list_lessons,
            commands::get_lesson,
            commands::save_lesson,
            commands::save_lesson_copy,
            commands::delete_lesson,
            commands::mark_prepared,
            commands::get_app_data,
            commands::set_app_data,
            commands::list_assets,
            commands::read_asset,
            commands::import_audio,
            commands::inspect_music,
            commands::prepare_music,
            commands::cancel_music,
            commands::commit_music,
            commands::list_voices,
            commands::synthesize_speech,
            commands::get_task,
            commands::get_task_input,
            commands::list_tasks,
            commands::cancel_task,
            commands::clear_task,
            commands::select_file,
            commands::read_material,
            commands::inspect_lesson_package,
            commands::import_lesson_package,
            commands::export_lesson_package,
            commands::export_html,
            commands::export_backup,
            commands::restore_backup,
            commands::clean_cache,
            commands::open_export,
            commands::recopy_export,
            commands::get_data_location,
            commands::get_data_epoch,
            commands::retain_assets,
            commands::release_assets,
            commands::delete_resource,
            commands::resource_usage,
            commands::list_export_copies,
            commands::clear_export_copies
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 English Class Games 桌面环境");
}
