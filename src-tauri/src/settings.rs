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
    fs::write(path, content).map_err(|err| AppError::new("settingsWriteFailed", err.to_string()))
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
}
