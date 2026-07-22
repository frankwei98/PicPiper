use std::{fs, io::Write, path::Path};

use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{SaveCredentialRequest, SaveCredentialResponse},
};

// A recent temp file may belong to another in-flight save. Keep it long enough
// to avoid racing that write, while eventually removing files left by a crash.
const STALE_CREDENTIAL_TEMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

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

    // Credentials live under the app's private data directory. Tighten the
    // directory mode on Unix as well as the file mode below so newly-created
    // sibling files cannot accidentally become group/world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(credential_dir, fs::Permissions::from_mode(0o700))
            .map_err(|err| AppError::new("credentialDirFailed", err.to_string()))?;
    }

    cleanup_stale_temp_files(credential_dir, &request.profile_id);

    let final_path = credential_dir.join(format!("{}.secret", request.profile_id));
    // Use a unique create_new temp file. A fixed `*.tmp` path lets two saves
    // overwrite each other's secret before either one reaches the rename.
    let temp_path = credential_dir.join(format!(
        "{}.secret.tmp-{}",
        request.profile_id,
        Uuid::new_v4()
    ));
    let write_result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|err| AppError::new("credentialWriteFailed", err.to_string()))?;
        file.write_all(request.secret_access_key.as_bytes())
            .map_err(|err| AppError::new("credentialWriteFailed", err.to_string()))?;
        file.sync_all()
            .map_err(|err| AppError::new("credentialWriteFailed", err.to_string()))?;

        replace_credential_file(&temp_path, &final_path)?;
        Ok::<(), AppError>(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result?;

    Ok(SaveCredentialResponse {
        credential_ref: key_ref,
    })
}

fn replace_credential_file(temp_path: &Path, final_path: &Path) -> AppResult<()> {
    fs::rename(temp_path, final_path)
        .map_err(|err| AppError::new("credentialWriteFailed", err.to_string()))
}

fn cleanup_stale_temp_files(credential_dir: &Path, profile_id: &str) {
    let temp_prefix = format!("{profile_id}.secret.tmp-");
    let now = std::time::SystemTime::now();
    let Ok(entries) = fs::read_dir(credential_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file()
            || !entry
                .file_name()
                .to_string_lossy()
                .starts_with(&temp_prefix)
        {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() > STALE_CREDENTIAL_TEMP_MAX_AGE {
            let _ = fs::remove_file(entry.path());
        }
    }
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
    fn saving_again_replaces_the_previous_credential() {
        let dir = tempfile::tempdir().unwrap();
        let request = |secret: &str| SaveCredentialRequest {
            profile_id: "example".to_string(),
            secret_access_key: secret.to_string(),
        };

        save_secret(dir.path(), request("first-secret")).unwrap();
        save_secret(dir.path(), request("second-secret")).unwrap();

        assert_eq!(load_secret(dir.path(), "example").unwrap(), "second-secret");
        assert!(fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp-")));
    }

    #[test]
    fn replacing_credential_file_replaces_an_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let temporary = dir.path().join("new.secret.tmp");
        let destination = dir.path().join("profile.secret");
        fs::write(&temporary, "new-secret").unwrap();
        fs::write(&destination, "old-secret").unwrap();

        replace_credential_file(&temporary, &destination).unwrap();

        assert_eq!(fs::read_to_string(&destination).unwrap(), "new-secret");
        assert!(!temporary.exists());
    }

    #[test]
    fn saving_a_secret_removes_an_old_temp_file_for_the_same_profile() {
        let dir = tempfile::tempdir().unwrap();
        let stale_temp = dir.path().join("example.secret.tmp-abandoned");
        fs::write(&stale_temp, "abandoned-secret").unwrap();
        filetime::set_file_mtime(
            &stale_temp,
            filetime::FileTime::from_system_time(
                std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60 + 1),
            ),
        )
        .unwrap();

        save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "current-secret".to_string(),
            },
        )
        .unwrap();

        assert!(!stale_temp.exists());
        assert_eq!(
            load_secret(dir.path(), "example").unwrap(),
            "current-secret"
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
    #[cfg(unix)]
    fn credential_directory_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let credential_dir = dir.path().join("credentials");
        save_secret(
            &credential_dir,
            SaveCredentialRequest {
                profile_id: "private".to_string(),
                secret_access_key: "secret".to_string(),
            },
        )
        .unwrap();

        let mode = fs::metadata(&credential_dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
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
