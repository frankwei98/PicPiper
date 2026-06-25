use std::path::PathBuf;

use tauri::Manager;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub settings_path: PathBuf,
    pub history_path: PathBuf,
    pub credential_fallback_dir: PathBuf,
}

impl AppPaths {
    pub fn from_app_handle(app: &tauri::AppHandle) -> AppResult<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| AppError::new("appDataDirFailed", err.to_string()))?;
        Ok(Self {
            settings_path: data_dir.join("settings.json"),
            history_path: data_dir.join("upload-history.json"),
            credential_fallback_dir: data_dir.join("credential-fallback"),
            data_dir,
        })
    }
}
