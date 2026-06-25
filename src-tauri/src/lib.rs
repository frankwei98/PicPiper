mod credentials;
mod error;
mod history;
mod models;
mod naming;
mod settings;
mod state;

use models::AppSettings;
use tauri::Manager;

#[tauri::command]
fn get_default_settings() -> AppSettings {
    AppSettings::default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = state::AppPaths::from_app_handle(app.handle())?;
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_default_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
