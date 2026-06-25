use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::{SaveCredentialRequest, SaveCredentialResponse},
};

const SERVICE_NAME: &str = "xyz.frankwei.pic-piper";

pub fn credential_ref(profile_id: &str) -> String {
    format!("s3:{profile_id}")
}

pub fn save_secret(
    fallback_dir: &Path,
    request: SaveCredentialRequest,
) -> AppResult<SaveCredentialResponse> {
    let key_ref = credential_ref(&request.profile_id);
    let entry = keyring::Entry::new(SERVICE_NAME, &key_ref);

    if let Ok(entry) = entry {
        if entry.set_password(&request.secret_access_key).is_ok() {
            return Ok(SaveCredentialResponse {
                credential_ref: key_ref,
                insecure_fallback_used: false,
            });
        }
    }

    if !request.allow_insecure_fallback {
        return Err(AppError::new(
            "secureCredentialUnavailable",
            "System credential storage is unavailable. Enable local fallback to save this profile.",
        ));
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
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, &key_ref) {
        if let Ok(secret) = entry.get_password() {
            return Ok(secret);
        }
    }

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

    #[test]
    fn credential_ref_is_stable() {
        assert_eq!(credential_ref("r2-main"), "s3:r2-main");
    }

    #[test]
    fn fallback_requires_explicit_permission() {
        let dir = tempfile::tempdir().unwrap();
        let result = save_secret(
            dir.path(),
            SaveCredentialRequest {
                profile_id: "example".to_string(),
                secret_access_key: "secret".to_string(),
                allow_insecure_fallback: false,
            },
        );

        if let Err(err) = result {
            assert_eq!(err.code, "secureCredentialUnavailable");
        }
    }
}
