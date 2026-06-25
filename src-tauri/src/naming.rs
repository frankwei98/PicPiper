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
}

use crate::error::{AppError, AppResult};

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

    Ok(template
        .replace("{yyyy}", &date.format("%Y").to_string())
        .replace("{mm}", &date.format("%m").to_string())
        .replace("{slug}", &slug)
        .replace("{hash}", &short_hash)
        .replace("{ext}", ext.trim_start_matches('.')))
}
