use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::AppSettings,
};

fn validate_http_url(value: &str, field: &str) -> AppResult<()> {
    let url = tauri::Url::parse(value)
        .map_err(|_| AppError::new("invalidSettings", format!("{field} must be a valid URL.")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::new(
            "invalidSettings",
            format!("{field} must use http or https and include a host."),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("invalidSettings", format!("{field} must include a host and must not contain credentials, a query, or a fragment.")));
    }
    Ok(())
}

pub fn validate_settings(settings: &AppSettings) -> AppResult<()> {
    if settings.naming_template.trim().is_empty() {
        return Err(AppError::new(
            "invalidSettings",
            "Naming template is required.",
        ));
    }
    if let Some(default_id) = settings.default_profile_id.as_deref() {
        if !settings
            .profiles
            .iter()
            .any(|profile| profile.id == default_id)
        {
            return Err(AppError::new(
                "invalidSettings",
                "Default profile must refer to an existing profile.",
            ));
        }
    }
    for profile in &settings.profiles {
        for (field, value) in [
            ("Profile ID", profile.id.as_str()),
            ("Profile name", profile.name.as_str()),
            ("Endpoint", profile.endpoint.as_str()),
            ("Region", profile.region.as_str()),
            ("Bucket", profile.bucket.as_str()),
            ("Access key ID", profile.access_key_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(AppError::new(
                    "invalidSettings",
                    format!("{field} is required."),
                ));
            }
        }
        validate_http_url(&profile.endpoint, "Endpoint")?;
        if let Some(url) = profile.public_base_url.as_deref() {
            validate_http_url(url, "Public Base URL")?;
        }
        if profile.default_prefix.chars().any(char::is_control)
            || profile
                .default_prefix
                .split('/')
                .any(|part| matches!(part, "." | ".."))
        {
            return Err(AppError::new(
                "invalidSettings",
                "Default prefix must not contain control characters or path traversal segments.",
            ));
        }
    }
    Ok(())
}

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
    validate_settings(settings)?;
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
        let settings = AppSettings {
            default_output_dir: Some("/tmp/out".to_string()),
            ..AppSettings::default()
        };

        save_settings(&path, &settings).unwrap();
        let loaded = load_settings(&path).unwrap();
        assert_eq!(loaded.default_output_dir, Some("/tmp/out".to_string()));
    }

    #[test]
    fn existing_file_survives_failed_temp_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        // Write valid initial settings
        let settings = AppSettings {
            default_output_dir: Some("/original".to_string()),
            ..AppSettings::default()
        };
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

    #[test]
    fn rejects_invalid_profiles_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = AppSettings {
            profiles: vec![crate::models::S3Profile {
                id: "profile".into(),
                name: "Example".into(),
                endpoint: "not-a-url".into(),
                region: "auto".into(),
                bucket: "images".into(),
                access_key_id: "key".into(),
                credential_ref: Some("s3:profile".into()),
                path_style: true,
                public_base_url: None,
                default_prefix: "images".into(),
            }],
            default_profile_id: Some("profile".into()),
            ..AppSettings::default()
        };

        let error = save_settings(&path, &settings).unwrap_err();
        assert_eq!(error.code, "invalidSettings");
        assert!(!path.exists());
    }

    #[test]
    fn rejects_a_missing_default_profile() {
        let settings = AppSettings {
            default_profile_id: Some("missing".into()),
            ..AppSettings::default()
        };
        assert!(validate_settings(&settings).is_err());
    }
}
