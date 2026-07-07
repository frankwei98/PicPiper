use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::{SaveCredentialRequest, SaveCredentialResponse},
};

/// Validates that a profile_id contains only conservative ASCII characters:
/// letters, digits, underscores, hyphens, and dots. Rejects empty strings,
/// path separators, control characters, and anything outside the safe set.
fn validate_profile_id(profile_id: &str) -> AppResult<()> {
    if profile_id.is_empty() {
        return Err(AppError::new(
            "invalidProfileId",
            "Profile ID must not be empty.",
        ));
    }

    if !profile_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(AppError::new(
            "invalidProfileId",
            "Profile ID contains invalid characters. Only letters, digits, underscores, hyphens, and dots are allowed.",
        ));
    }

    Ok(())
}

pub fn credential_ref(profile_id: &str) -> AppResult<String> {
    validate_profile_id(profile_id)?;
    Ok(format!("s3:{profile_id}"))
}

pub fn save_secret(
    credential_dir: &Path,
    request: SaveCredentialRequest,
) -> AppResult<SaveCredentialResponse> {
    validate_profile_id(&request.profile_id)?;
    let key_ref = credential_ref(&request.profile_id)?;

    fs::create_dir_all(credential_dir)
        .map_err(|err| AppError::new("credentialDirFailed", err.to_string()))?;

    let final_path = credential_dir.join(format!("{}.secret", request.profile_id));
    let temp_path = credential_dir.join(format!("{}.secret.tmp", request.profile_id));

    // Write to temp file first, then rename for atomicity
    fs::write(&temp_path, &request.secret_access_key)
        .map_err(|err| AppError::new("credentialWriteFailed", err.to_string()))?;

    // Set file permissions to owner-only read/write on Unix/macOS
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&temp_path, &final_path)
        .map_err(|err| AppError::new("credentialWriteFailed", err.to_string()))?;

    Ok(SaveCredentialResponse {
        credential_ref: key_ref,
    })
}

pub fn load_secret(credential_dir: &Path, profile_id: &str) -> AppResult<String> {
    validate_profile_id(profile_id)?;

    fs::read_to_string(credential_dir.join(format!("{profile_id}.secret"))).map_err(|_| {
        AppError::new(
            "credentialMissing",
            "No saved credential found for profile.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_ref_is_stable() {
        assert_eq!(credential_ref("r2-main").unwrap(), "s3:r2-main");
    }

    #[test]
    fn credential_ref_rejects_dot_dot_slash() {
        assert!(credential_ref("../evil").is_err());
    }

    #[test]
    fn credential_ref_rejects_slash() {
        assert!(credential_ref("a/b").is_err());
    }

    #[test]
    fn credential_ref_rejects_backslash() {
        assert!(credential_ref("a\\b").is_err());
    }

    #[test]
    fn credential_ref_rejects_empty() {
        assert!(credential_ref("").is_err());
    }

    #[test]
    fn credential_ref_rejects_control_characters() {
        assert!(credential_ref("a\nb").is_err());
        assert!(credential_ref("a\tb").is_err());
        assert!(credential_ref("a\0b").is_err());
    }

    #[test]
    fn credential_ref_accepts_valid_ids() {
        assert!(credential_ref("r2-main").is_ok());
        assert!(credential_ref("my_profile.test").is_ok());
        assert!(credential_ref("ABC123").is_ok());
    }

    #[test]
    fn save_secret_writes_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let result = save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "secret".to_string(),
            },
        );

        let resp = result.expect("save_secret should succeed with local credential storage");
        assert_eq!(resp.credential_ref, "s3:example");
        assert_eq!(
            fs::read_to_string(dir.path().join("example.secret")).unwrap(),
            "secret"
        );
    }

    #[test]
    fn credential_file_is_not_world_readable() {
        let dir = tempfile::tempdir().unwrap();
        save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "testperm".to_string(),
                secret_access_key: "secret123".to_string(),
            },
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.path().join("testperm.secret");
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            // File should be 0o600 (owner read/write only)
            assert_eq!(
                mode & 0o777,
                0o600,
                "credential file should have mode 0o600, got {:o}",
                mode & 0o777
            );
        }
    }

    #[test]
    fn save_rejects_malicious_profile_id() {
        let dir = tempfile::tempdir().unwrap();

        for bad_id in &["../evil", "a/b", "a\\b", "", "a\nb"] {
            let result = save_secret(
                dir.path(),
                SaveCredentialRequest {
                    profile_id: bad_id.to_string(),
                    secret_access_key: "secret".to_string(),
                },
            );
            assert!(result.is_err(), "should reject profile_id: {:?}", bad_id);
        }
    }

    #[test]
    fn load_rejects_malicious_profile_id() {
        let dir = tempfile::tempdir().unwrap();
        for bad_id in &["../evil", "a/b", "a\\b", "", "a\nb"] {
            let result = load_secret(dir.path(), bad_id);
            assert!(result.is_err(), "should reject profile_id: {:?}", bad_id);
        }
    }
}
