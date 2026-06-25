use crate::{
    error::{AppError, AppResult},
    models::{GalleryObject, S3Profile},
};

pub fn public_url(profile: &S3Profile, key: &str) -> AppResult<String> {
    let base = profile.public_base_url.as_deref().ok_or_else(|| {
        AppError::new(
            "publicBaseUrlMissing",
            "Set a Public Base URL before copying object URLs.",
        )
    })?;
    Ok(format!(
        "{}/{}",
        base.trim_end_matches('/'),
        key.trim_start_matches('/')
    ))
}

pub fn is_supported_image_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".webp", ".avif", ".heif", ".heic"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

pub fn object_from_parts(
    profile: &S3Profile,
    key: String,
    size: u64,
    last_modified: Option<String>,
) -> GalleryObject {
    GalleryObject {
        public_url: public_url(profile, &key).ok(),
        is_image: is_supported_image_key(&key),
        key,
        size,
        last_modified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(base: Option<&str>) -> S3Profile {
        S3Profile {
            id: "p1".to_string(),
            name: "Profile".to_string(),
            endpoint: "http://localhost:9000".to_string(),
            region: "auto".to_string(),
            bucket: "images".to_string(),
            access_key_id: "key".to_string(),
            credential_ref: Some("s3:p1".to_string()),
            path_style: true,
            public_base_url: base.map(str::to_string),
            default_prefix: "images".to_string(),
            insecure_secret_fallback: false,
        }
    }

    #[test]
    fn joins_public_url_with_one_slash() {
        assert_eq!(
            public_url(&profile(Some("https://cdn.example.com/")), "/a/b.jpg").unwrap(),
            "https://cdn.example.com/a/b.jpg"
        );
    }

    #[test]
    fn missing_public_base_url_is_error() {
        assert_eq!(
            public_url(&profile(None), "a.jpg").unwrap_err().code,
            "publicBaseUrlMissing"
        );
    }
}
