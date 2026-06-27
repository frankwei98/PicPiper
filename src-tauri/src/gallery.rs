use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::Region, config::SharedCredentialsProvider, primitives::ByteStream, Client,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        DeleteObjectRequest, DownloadObjectRequest, GalleryObject, ListObjectsRequest, S3Profile,
        UploadObjectRequest,
    },
    naming, optimizer,
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
        .endpoint_url(endpoint_url(profile))
        .load()
        .await;
    let mut builder = aws_sdk_s3::config::Builder::from(&base);
    if profile.path_style {
        builder = builder.force_path_style(true);
    }
    Client::from_conf(builder.build())
}

fn endpoint_url(profile: &S3Profile) -> String {
    let endpoint = profile.endpoint.trim_end_matches('/');
    let bucket = profile.bucket.trim_matches('/');
    if bucket.is_empty() {
        return endpoint.to_string();
    }

    endpoint
        .strip_suffix(&format!("/{bucket}"))
        .unwrap_or(endpoint)
        .to_string()
}

/// Percent-encode a single path segment for use in URLs.
/// Encodes everything that is not an unreserved character (RFC 3986),
/// preserving the segment boundary (no '/' encoding).
fn encode_path_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len() * 3);
    for byte in segment.bytes() {
        match byte {
            // Unreserved characters: ALPHA / DIGIT / "-" / "." / "_" / "~"
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push_str(&format!("{:02X}", byte));
            }
        }
    }
    encoded
}

/// Percent-encode an object key for use in URLs, preserving '/' separators.
pub(crate) fn encode_object_key(key: &str) -> String {
    key.split('/')
        .map(encode_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

pub fn public_url(profile: &S3Profile, key: &str) -> AppResult<String> {
    let base = profile.public_base_url.as_deref().ok_or_else(|| {
        AppError::new(
            "publicBaseUrlMissing",
            "Set a Public Base URL before copying object URLs.",
        )
    })?;
    let trimmed_key = key.trim_start_matches('/');
    let encoded_key = encode_object_key(trimmed_key);
    Ok(format!("{}/{}", base.trim_end_matches('/'), encoded_key))
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
    let mut all_objects: Vec<GalleryObject> = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client
            .list_objects_v2()
            .bucket(&request.profile.bucket)
            .prefix(&request.prefix);

        if let Some(token) = &continuation_token {
            req = req.continuation_token(token);
        }

        let response = req
            .send()
            .await
            .map_err(|err| AppError::new("s3ListFailed", err.to_string()))?;

        all_objects.extend(map_s3_objects(&request.profile, response.contents()));

        if response.is_truncated().unwrap_or(false) {
            let next_token = response.next_continuation_token().map(String::from);
            if next_token.is_none() {
                return Err(AppError::new(
                    "s3PaginationFailed",
                    "S3 response indicates more results but returned no continuation token.",
                ));
            }
            continuation_token = next_token;
        } else {
            break;
        }
    }

    Ok(all_objects)
}

/// Map raw S3 object entries to `GalleryObject`s. Extracted for testability.
pub fn map_s3_objects(
    profile: &S3Profile,
    objects: &[aws_sdk_s3::types::Object],
) -> Vec<GalleryObject> {
    objects
        .iter()
        .filter_map(|object| {
            let key = object.key()?.to_string();
            Some(object_from_parts(
                profile,
                key,
                object.size().unwrap_or_default() as u64,
                object.last_modified().map(|dt| dt.to_string()),
            ))
        })
        .collect()
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

pub async fn download_object(request: DownloadObjectRequest, secret: String) -> AppResult<String> {
    let client = client_for(&request.profile, secret).await;
    let response = client
        .get_object()
        .bucket(&request.profile.bucket)
        .key(&request.key)
        .send()
        .await
        .map_err(|err| AppError::new("s3DownloadFailed", err.to_string()))?;

    let file_name = std::path::Path::new(&request.key)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let dest_dir = std::path::Path::new(&request.output_dir);
    tokio::fs::create_dir_all(dest_dir)
        .await
        .map_err(|err| AppError::new("downloadDirFailed", err.to_string()))?;

    // Pick a unique path before starting the download so we don't overwrite.
    let dest = optimizer::unique_destination_path(dest_dir, &file_name);

    // Stream body directly to file instead of buffering the whole object in memory.
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|err| AppError::new("downloadWriteFailed", err.to_string()))?;
    let mut stream = response.body;
    while let Some(chunk) = stream
        .try_next()
        .await
        .map_err(|err| AppError::new("s3DownloadReadFailed", err.to_string()))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| AppError::new("downloadWriteFailed", err.to_string()))?;
    }
    file.flush()
        .await
        .map_err(|err| AppError::new("downloadWriteFailed", err.to_string()))?;

    Ok(dest.to_string_lossy().to_string())
}

pub async fn upload_object(
    request: UploadObjectRequest,
    secret: String,
) -> AppResult<GalleryObject> {
    naming::validate_object_key(&request.object_key)?;
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
    use aws_sdk_s3::types::Object;

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

    #[test]
    fn endpoint_url_strips_bucket_suffix_for_path_style_profiles() {
        let mut p = profile(Some("https://cdn.example.com"));
        p.endpoint = "https://account.r2.cloudflarestorage.com/images/".to_string();
        p.bucket = "images".to_string();
        p.path_style = true;

        assert_eq!(
            endpoint_url(&p),
            "https://account.r2.cloudflarestorage.com".to_string()
        );
    }

    // --- public_url percent-encoding tests ---

    #[test]
    fn public_url_encodes_spaces() {
        let p = profile(Some("https://cdn.example.com"));
        assert_eq!(
            public_url(&p, "photos/my file.jpg").unwrap(),
            "https://cdn.example.com/photos/my%20file.jpg"
        );
    }

    #[test]
    fn public_url_encodes_hash() {
        let p = profile(Some("https://cdn.example.com"));
        assert_eq!(
            public_url(&p, "photos/photo#1.jpg").unwrap(),
            "https://cdn.example.com/photos/photo%231.jpg"
        );
    }

    #[test]
    fn public_url_encodes_unicode() {
        let p = profile(Some("https://cdn.example.com"));
        let url = public_url(&p, "photos/cafe\u{0301}.jpg").unwrap();
        // Should contain percent-encoded bytes for the Unicode characters
        assert!(url.contains("photos/"));
        assert!(url.starts_with("https://cdn.example.com/"));
        // The encoded URL should not contain the raw unicode combining character
        assert!(!url.contains('\u{0301}'));
    }

    #[test]
    fn public_url_preserves_slashes() {
        let p = profile(Some("https://cdn.example.com"));
        assert_eq!(
            public_url(&p, "a/b/c.jpg").unwrap(),
            "https://cdn.example.com/a/b/c.jpg"
        );
    }

    #[test]
    fn public_url_encodes_plus_sign() {
        let p = profile(Some("https://cdn.example.com"));
        assert_eq!(
            public_url(&p, "photos/a+b.jpg").unwrap(),
            "https://cdn.example.com/photos/a%2Bb.jpg"
        );
    }

    fn make_s3_object(key: &str, size: i64, ts_secs: i64) -> Object {
        let dt = aws_sdk_s3::primitives::DateTime::from_secs(ts_secs);
        Object::builder()
            .key(key)
            .size(size)
            .last_modified(dt)
            .build()
    }

    #[test]
    fn map_s3_objects_preserves_size_last_modified_and_is_image() {
        let p = profile(Some("https://cdn.example.com"));
        let raw = vec![
            make_s3_object("photos/a.jpg", 2048, 1_700_000_000),
            make_s3_object("docs/readme.txt", 512, 1_700_000_100),
        ];
        let mapped = map_s3_objects(&p, &raw);

        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].key, "photos/a.jpg");
        assert_eq!(mapped[0].size, 2048);
        assert!(mapped[0].is_image);
        assert!(mapped[0].last_modified.is_some());

        assert_eq!(mapped[1].key, "docs/readme.txt");
        assert_eq!(mapped[1].size, 512);
        assert!(!mapped[1].is_image);
    }

    #[test]
    fn map_s3_objects_merges_two_pages() {
        let p = profile(Some("https://cdn.example.com"));
        let page1 = vec![make_s3_object("img/1.jpg", 100, 1_700_000_000)];
        let page2 = vec![make_s3_object("img/2.png", 200, 1_700_000_100)];

        let mut all: Vec<GalleryObject> = Vec::new();
        all.extend(map_s3_objects(&p, &page1));
        all.extend(map_s3_objects(&p, &page2));

        assert_eq!(all.len(), 2);
        assert_eq!(all[0].key, "img/1.jpg");
        assert_eq!(all[0].size, 100);
        assert!(all[0].last_modified.is_some());
        assert_eq!(all[1].key, "img/2.png");
        assert_eq!(all[1].size, 200);
        assert!(all[1].last_modified.is_some());
    }

    #[test]
    fn map_s3_objects_handles_empty_page() {
        let p = profile(Some("https://cdn.example.com"));
        let mapped = map_s3_objects(&p, &[]);
        assert!(mapped.is_empty());
    }
}
