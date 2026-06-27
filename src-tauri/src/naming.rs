use crate::error::{AppError, AppResult};

/// Validates that an object key is safe for use with S3-compatible storage.
/// Rejects keys that could cause path traversal, contain control characters,
/// or have empty segments from double slashes.
pub fn validate_object_key(key: &str) -> AppResult<()> {
    if key.is_empty() {
        return Err(AppError::new(
            "invalidObjectKey",
            "Object key must not be empty.",
        ));
    }

    if key.starts_with('/') {
        return Err(AppError::new(
            "invalidObjectKey",
            "Object key must not start with '/'.",
        ));
    }

    // Reject control characters (including newlines, tabs, null bytes)
    if key.chars().any(|c| c.is_control()) {
        return Err(AppError::new(
            "invalidObjectKey",
            "Object key must not contain control characters.",
        ));
    }

    // Reject backslashes (should have been normalized to forward slashes)
    if key.contains('\\') {
        return Err(AppError::new(
            "invalidObjectKey",
            "Object key must not contain backslashes.",
        ));
    }

    // Check each segment for path traversal
    for segment in key.split('/') {
        if segment == ".." || segment == "." {
            return Err(AppError::new(
                "invalidObjectKey",
                "Object key must not contain path traversal segments.",
            ));
        }
        if segment.is_empty() {
            return Err(AppError::new(
                "invalidObjectKey",
                "Object key must not contain empty path segments.",
            ));
        }
    }

    Ok(())
}

/// Checks whether the rendered key starts with the given prefix as a complete
/// path segment boundary. For example, prefix "img" matches "img/photo.webp"
/// but NOT "images/photo.webp".
pub fn has_path_prefix(key: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    key == prefix || (key.starts_with(prefix) && key.as_bytes().get(prefix.len()) == Some(&b'/'))
}

pub fn render_object_key(
    template: &str,
    source_filename: &str,
    ext: &str,
    content_hash: &str,
    date: chrono::NaiveDate,
) -> AppResult<String> {
    if !template.contains("{ext}") {
        return Err(AppError::new(
            "invalidTemplate",
            "Naming template must include {ext}.",
        ));
    }

    let stem = source_filename
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(source_filename);
    let slug = slug::slugify(stem);
    let short_hash = content_hash.chars().take(8).collect::<String>();

    let key = template
        .replace("{yyyy}", &date.format("%Y").to_string())
        .replace("{mm}", &date.format("%m").to_string())
        .replace("{slug}", &slug)
        .replace("{hash}", &short_hash)
        .replace("{ext}", ext.trim_start_matches('.'));

    // Normalize backslashes to forward slashes
    let key = key.replace('\\', "/");

    validate_object_key(&key)?;

    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_default_template_with_slug_and_hash() {
        let key = render_object_key(
            "{yyyy}/{mm}/{slug}-{hash}.{ext}",
            "My Summer Photo.JPG",
            "jpg",
            "abcdef123456",
            chrono::NaiveDate::from_ymd_opt(2026, 6, 26).unwrap(),
        )
        .unwrap();

        assert_eq!(key, "2026/06/my-summer-photo-abcdef12.jpg");
    }

    #[test]
    fn rejects_templates_without_extension() {
        let err = render_object_key(
            "{yyyy}/{mm}/{slug}-{hash}",
            "photo.jpg",
            "jpg",
            "abcdef123456",
            chrono::NaiveDate::from_ymd_opt(2026, 6, 26).unwrap(),
        )
        .unwrap_err();

        assert_eq!(err.code, "invalidTemplate");
    }

    // --- validate_object_key tests ---

    #[test]
    fn validate_rejects_dot_dot_slash() {
        assert!(validate_object_key("../a.webp").is_err());
    }

    #[test]
    fn validate_rejects_leading_slash() {
        assert!(validate_object_key("/a.webp").is_err());
    }

    #[test]
    fn validate_rejects_double_slash() {
        assert!(validate_object_key("a//b.webp").is_err());
    }

    #[test]
    fn validate_rejects_newline() {
        assert!(validate_object_key("a/\nb.webp").is_err());
    }

    #[test]
    fn validate_rejects_dot_dot_in_middle() {
        assert!(validate_object_key("a/../b.webp").is_err());
    }

    #[test]
    fn validate_rejects_bare_dot_dot() {
        assert!(validate_object_key("..").is_err());
    }

    #[test]
    fn validate_rejects_empty() {
        assert!(validate_object_key("").is_err());
    }

    #[test]
    fn validate_accepts_normal_key() {
        assert!(validate_object_key("2026/06/photo-abc123.webp").is_ok());
    }

    #[test]
    fn validate_rejects_backslash_segments() {
        // After normalization, backslashes become slashes, which may create
        // traversal patterns. But raw backslashes in the key are also control-free,
        // so test the normalized form.
        assert!(validate_object_key("a\\..\\b.webp").is_err());
    }

    // --- has_path_prefix tests ---

    #[test]
    fn prefix_img_does_not_match_images() {
        assert!(!has_path_prefix("images/a.webp", "img"));
    }

    #[test]
    fn prefix_images_matches_images_slash() {
        assert!(has_path_prefix("images/a.webp", "images"));
    }

    #[test]
    fn prefix_exact_match() {
        assert!(has_path_prefix("images", "images"));
    }

    #[test]
    fn empty_prefix_matches_everything() {
        assert!(has_path_prefix("anything", ""));
    }

    #[test]
    fn prefix_not_at_boundary() {
        assert!(!has_path_prefix("imgextra/a.webp", "img"));
    }

    // --- render_object_key validation tests ---

    #[test]
    fn rejects_template_producing_traversal() {
        // A template with .. in it would be rejected by validate_object_key
        let err = render_object_key(
            "../{slug}.{ext}",
            "photo.jpg",
            "jpg",
            "abcdef123456",
            chrono::NaiveDate::from_ymd_opt(2026, 6, 26).unwrap(),
        )
        .unwrap_err();
        assert_eq!(err.code, "invalidObjectKey");
    }

    #[test]
    fn normalizes_backslashes_in_template() {
        // Template with backslashes should be normalized to forward slashes
        let key = render_object_key(
            "{yyyy}\\{mm}\\{slug}-{hash}.{ext}",
            "photo.jpg",
            "jpg",
            "abcdef123456",
            chrono::NaiveDate::from_ymd_opt(2026, 6, 26).unwrap(),
        )
        .unwrap();
        assert_eq!(key, "2026/06/photo-abcdef12.jpg");
    }
}
