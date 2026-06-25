use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::Region, config::SharedCredentialsProvider, primitives::ByteStream, Client,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        DeleteObjectRequest, GalleryObject, ListObjectsRequest, S3Profile, UploadObjectRequest,
    },
};

async fn client_for(profile: &S3Profile, secret: String) -> Client {
    let credentials = Credentials::new(
        profile.access_key_id.clone(),
        secret,
        None,
        None,
        "pic-piper-profile",
    );
    let base = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(profile.region.clone()))
        .credentials_provider(SharedCredentialsProvider::new(credentials))
        .endpoint_url(profile.endpoint.clone())
        .load()
        .await;
    let mut builder = aws_sdk_s3::config::Builder::from(&base);
    if profile.path_style {
        builder = builder.force_path_style(true);
    }
    Client::from_conf(builder.build())
}

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

pub async fn list_objects(
    request: ListObjectsRequest,
    secret: String,
) -> AppResult<Vec<GalleryObject>> {
    let client = client_for(&request.profile, secret).await;
    let response = client
        .list_objects_v2()
        .bucket(&request.profile.bucket)
        .prefix(&request.prefix)
        .send()
        .await
        .map_err(|err| AppError::new("s3ListFailed", err.to_string()))?;

    Ok(response
        .contents()
        .iter()
        .filter_map(|object| {
            let key = object.key()?.to_string();
            Some(object_from_parts(
                &request.profile,
                key,
                object.size().unwrap_or_default() as u64,
                object.last_modified().map(|dt| dt.to_string()),
            ))
        })
        .collect())
}

pub async fn delete_object(request: DeleteObjectRequest, secret: String) -> AppResult<()> {
    let client = client_for(&request.profile, secret).await;
    client
        .delete_object()
        .bucket(&request.profile.bucket)
        .key(&request.key)
        .send()
        .await
        .map_err(|err| AppError::new("s3DeleteFailed", err.to_string()))?;
    Ok(())
}

pub async fn upload_object(
    request: UploadObjectRequest,
    secret: String,
) -> AppResult<GalleryObject> {
    let client = client_for(&request.profile, secret).await;
    let body = ByteStream::from_path(&request.source_path)
        .await
        .map_err(|err| AppError::new("uploadReadFailed", err.to_string()))?;

    let mut upload = client
        .put_object()
        .bucket(&request.profile.bucket)
        .key(&request.object_key)
        .body(body);
    if let Some(content_type) = &request.content_type {
        upload = upload.content_type(content_type);
    }
    upload
        .send()
        .await
        .map_err(|err| AppError::new("s3UploadFailed", err.to_string()))?;

    let size = std::fs::metadata(&request.source_path)
        .map_err(|err| AppError::new("uploadReadFailed", err.to_string()))?
        .len();
    Ok(object_from_parts(
        &request.profile,
        request.object_key,
        size,
        None,
    ))
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

    #[test]
    fn object_from_parts_sets_is_image() {
        let p = profile(Some("https://cdn.example.com"));
        let obj = object_from_parts(&p, "photos/test.jpg".to_string(), 1024, None);
        assert!(obj.is_image);
        assert_eq!(obj.key, "photos/test.jpg");
        assert_eq!(obj.size, 1024);
        assert_eq!(
            obj.public_url,
            Some("https://cdn.example.com/photos/test.jpg".to_string())
        );
    }

    #[test]
    fn object_from_parts_non_image() {
        let p = profile(Some("https://cdn.example.com"));
        let obj = object_from_parts(&p, "docs/readme.txt".to_string(), 512, None);
        assert!(!obj.is_image);
    }

    #[test]
    fn is_supported_image_key_variants() {
        assert!(is_supported_image_key("photo.jpg"));
        assert!(is_supported_image_key("photo.JPEG"));
        assert!(is_supported_image_key("photo.png"));
        assert!(is_supported_image_key("photo.webp"));
        assert!(is_supported_image_key("photo.avif"));
        assert!(is_supported_image_key("photo.heif"));
        assert!(is_supported_image_key("photo.heic"));
        assert!(!is_supported_image_key("photo.gif"));
        assert!(!is_supported_image_key("photo.bmp"));
        assert!(!is_supported_image_key("readme.txt"));
    }
}
