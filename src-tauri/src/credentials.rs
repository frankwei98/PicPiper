use std::{env, fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::{SaveCredentialRequest, SaveCredentialResponse},
};

const SERVICE_NAME: &str = "xyz.frankwei.pic-piper";

/// Returns true when the user has opted out of system keyring via env var.
/// Set `PIC_PIPER_NO_KEYCHAIN=1` to skip Keychain and use local file fallback.
fn keyring_disabled() -> bool {
    env::var("PIC_PIPER_NO_KEYCHAIN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub fn credential_ref(profile_id: &str) -> String {
    format!("s3:{profile_id}")
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
    let key_ref = credential_ref(&request.profile_id);

    if !keyring_disabled() {
        if try_save_keyring(&key_ref, &request.secret_access_key) {
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
    fs::write(
        fallback_dir.join(format!("{}.secret", request.profile_id)),
        request.secret_access_key,
    )
    .map_err(|err| AppError::new("credentialFallbackWriteFailed", err.to_string()))?;

    Ok(SaveCredentialResponse {
        credential_ref: key_ref,
        insecure_fallback_used: true,
    })
}

pub fn load_secret(fallback_dir: &Path, profile_id: &str) -> AppResult<String> {
    let key_ref = credential_ref(profile_id);

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
        assert_eq!(credential_ref("r2-main"), "s3:r2-main");
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
}
