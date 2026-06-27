use std::{env, fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::{SaveCredentialRequest, SaveCredentialResponse},
};

const SERVICE_NAME: &str = "xyz.frankwei.pic-piper";

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

/// Returns true when the user has opted out of system keyring via env var.
/// Set `PIC_PIPER_NO_KEYCHAIN=1` to skip Keychain and use local file fallback.
fn keyring_disabled() -> bool {
    env::var("PIC_PIPER_NO_KEYCHAIN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub fn credential_ref(profile_id: &str) -> AppResult<String> {
    validate_profile_id(profile_id)?;
    Ok(format!("s3:{profile_id}"))
}

pub fn save_secret(
    fallback_dir: &Path,
    request: SaveCredentialRequest,
) -> AppResult<SaveCredentialResponse> {
    save_secret_with_keyring(fallback_dir, request, |key_ref, secret| {
        let entry = keyring::Entry::new(SERVICE_NAME, key_ref);
        if let Ok(entry) = entry {
            return entry.set_password(secret).is_ok();
        }
        false
    })
}

fn save_secret_with_keyring(
    fallback_dir: &Path,
    request: SaveCredentialRequest,
    try_save_keyring: impl FnOnce(&str, &str) -> bool,
) -> AppResult<SaveCredentialResponse> {
    validate_profile_id(&request.profile_id)?;
    let key_ref = credential_ref(&request.profile_id)?;

    if !keyring_disabled() {
        if try_save_keyring(&key_ref, &request.secret_access_key) {
            // Best-effort: remove any stale fallback file so a later keyring
            // outage doesn't surface an old (possibly rotated-away) secret.
            let stale = fallback_dir.join(format!("{}.secret", request.profile_id));
            let _ = fs::remove_file(&stale);
            return Ok(SaveCredentialResponse {
                credential_ref: key_ref,
                insecure_fallback_used: false,
            });
        }
        if !request.allow_insecure_fallback {
            return Err(AppError::new(
                "secureCredentialUnavailable",
                "System credential storage is unavailable. Enable local fallback to save this profile.",
            ));
        }
    }

    fs::create_dir_all(fallback_dir)
        .map_err(|err| AppError::new("credentialFallbackDirFailed", err.to_string()))?;

    let final_path = fallback_dir.join(format!("{}.secret", request.profile_id));
    let temp_path = fallback_dir.join(format!("{}.secret.tmp", request.profile_id));

    // Write to temp file first, then rename for atomicity
    fs::write(&temp_path, &request.secret_access_key)
        .map_err(|err| AppError::new("credentialFallbackWriteFailed", err.to_string()))?;

    // Set file permissions to owner-only read/write on Unix/macOS
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }

    fs::rename(&temp_path, &final_path)
        .map_err(|err| AppError::new("credentialFallbackWriteFailed", err.to_string()))?;

    Ok(SaveCredentialResponse {
        credential_ref: key_ref,
        insecure_fallback_used: true,
    })
}

pub fn load_secret(fallback_dir: &Path, profile_id: &str) -> AppResult<String> {
    validate_profile_id(profile_id)?;
    let key_ref = credential_ref(profile_id)?;

    if !keyring_disabled() {
        if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, &key_ref) {
            if let Ok(secret) = entry.get_password() {
                return Ok(secret);
            }
        }
    }

    let _ = key_ref; // suppress unused variable warning when keyring is disabled
    fs::read_to_string(fallback_dir.join(format!("{profile_id}.secret"))).map_err(|_| {
        AppError::new(
            "credentialMissing",
            "No saved credential found for profile.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize tests that mutate PIC_PIPER_NO_KEYCHAIN so they don't
    // interfere with each other when cargo runs tests in parallel.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

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
    fn no_keychain_env_skips_keyring_and_uses_fallback() {
        let _guard = ENV_MUTEX.lock().unwrap();
        // With PIC_PIPER_NO_KEYCHAIN=1, save_secret always uses file fallback.
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            env::set_var("PIC_PIPER_NO_KEYCHAIN", "1");
        }
        let result = save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "secret".to_string(),
                allow_insecure_fallback: false,
            },
        );
        unsafe {
            env::remove_var("PIC_PIPER_NO_KEYCHAIN");
        }

        let resp = result.expect("save_secret should succeed with keyring disabled via env");
        assert!(resp.insecure_fallback_used);
        assert_eq!(resp.credential_ref, "s3:example");
    }

    #[test]
    fn fallback_requires_explicit_permission_without_env() {
        let _guard = ENV_MUTEX.lock().unwrap();
        // Without the env var, if keyring fails and allow_insecure_fallback is false,
        // save_secret should return an error without touching the real OS keyring.
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            env::remove_var("PIC_PIPER_NO_KEYCHAIN");
        }
        let result = save_secret_with_keyring(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "secret".to_string(),
                allow_insecure_fallback: false,
            },
            |_key_ref, _secret| false,
        );

        let err = result.expect_err("fallback should require explicit permission");
        assert_eq!(err.code, "secureCredentialUnavailable");
    }

    #[test]
    fn no_keychain_env_does_not_attempt_keyring() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            env::set_var("PIC_PIPER_NO_KEYCHAIN", "1");
        }
        let result = save_secret_with_keyring(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "secret".to_string(),
                allow_insecure_fallback: false,
            },
            |_key_ref, _secret| panic!("keyring should be skipped when PIC_PIPER_NO_KEYCHAIN=1"),
        );
        unsafe {
            env::remove_var("PIC_PIPER_NO_KEYCHAIN");
        }

        let resp = result.expect("save_secret should use file fallback");
        assert!(resp.insecure_fallback_used);
    }

    #[test]
    fn fallback_file_is_not_world_readable() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            env::set_var("PIC_PIPER_NO_KEYCHAIN", "1");
        }
        save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "testperm".to_string(),
                secret_access_key: "secret123".to_string(),
                allow_insecure_fallback: false,
            },
        )
        .unwrap();
        unsafe {
            env::remove_var("PIC_PIPER_NO_KEYCHAIN");
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.path().join("testperm.secret");
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            // File should be 0o600 (owner read/write only)
            assert_eq!(
                mode & 0o777,
                0o600,
                "fallback file should have mode 0o600, got {:o}",
                mode & 0o777
            );
        }
    }

    #[test]
    fn save_rejects_malicious_profile_id() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            env::set_var("PIC_PIPER_NO_KEYCHAIN", "1");
        }

        for bad_id in &["../evil", "a/b", "a\\b", "", "a\nb"] {
            let result = save_secret(
                dir.path(),
                SaveCredentialRequest {
                    profile_id: bad_id.to_string(),
                    secret_access_key: "secret".to_string(),
                    allow_insecure_fallback: false,
                },
            );
            assert!(result.is_err(), "should reject profile_id: {:?}", bad_id);
        }

        unsafe {
            env::remove_var("PIC_PIPER_NO_KEYCHAIN");
        }
    }

    #[test]
    fn successful_keychain_save_removes_stale_fallback_file() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();

        // Simulate prior insecure fallback from earlier session.
        std::fs::write(dir.path().join("rotated.secret"), "old-secret").unwrap();

        // Now keychain succeeds for the same profile id — fallback file should be removed.
        let resp = save_secret_with_keyring(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "rotated".to_string(),
                secret_access_key: "new-secret".to_string(),
                allow_insecure_fallback: true,
            },
            |_key_ref, _secret| true,
        )
        .expect("save should succeed when keyring returns true");

        assert!(!resp.insecure_fallback_used);
        assert!(
            !dir.path().join("rotated.secret").exists(),
            "stale fallback file must be removed after keychain save"
        );
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
