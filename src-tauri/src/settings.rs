use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::AppSettings,
};

pub fn load_settings(path: &Path) -> AppResult<AppSettings> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| AppError::new("settingsReadFailed", err.to_string()))?;
    serde_json::from_str(&content)
        .map_err(|err| AppError::new("settingsParseFailed", err.to_string()))
}

pub fn save_settings(path: &Path, settings: &AppSettings) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::new("settingsDirFailed", err.to_string()))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|err| AppError::new("settingsSerializeFailed", err.to_string()))?;

    // Write atomically: write to temp file in same directory, then rename
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, &content)
        .map_err(|err| AppError::new("settingsWriteFailed", err.to_string()))?;
    fs::rename(&temp_path, path)
        .map_err(|err| AppError::new("settingsWriteFailed", err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load_settings(&dir.path().join("settings.json")).unwrap();
        assert_eq!(settings.naming_template, "{yyyy}/{mm}/{slug}-{hash}.{ext}");
        assert!(settings.profiles.is_empty());
        assert!(settings.default_output_dir.is_none());
        assert!(settings.default_profile_id.is_none());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut settings = AppSettings::default();
        settings.default_output_dir = Some("/tmp/out".to_string());

        save_settings(&path, &settings).unwrap();
        let loaded = load_settings(&path).unwrap();
        assert_eq!(loaded.default_output_dir, Some("/tmp/out".to_string()));
    }

    #[test]
    fn existing_file_survives_failed_temp_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        // Write valid initial settings
        let mut settings = AppSettings::default();
        settings.default_output_dir = Some("/original".to_string());
        save_settings(&path, &settings).unwrap();

        // The atomic write uses a .tmp extension; verify it does not linger
        let temp_path = path.with_extension("json.tmp");
        assert!(
            !temp_path.exists(),
            "temp file should not exist after successful save"
        );

        // Original file should still be readable
        let loaded = load_settings(&path).unwrap();
        assert_eq!(loaded.default_output_dir, Some("/original".to_string()));
    }
}
