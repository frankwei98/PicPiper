use std::{fs, path::Path};

use crate::{
    error::{AppError, AppResult},
    models::UploadHistoryEntry,
};

pub fn load_history(path: &Path) -> AppResult<Vec<UploadHistoryEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| AppError::new("historyReadFailed", err.to_string()))?;
    match serde_json::from_str(&content) {
        Ok(entries) => Ok(entries),
        Err(_) => {
            let corrupt_path = path.with_file_name(format!(
                "{}.corrupt-{}.json",
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("history"),
                uuid::Uuid::new_v4()
            ));
            fs::rename(path, &corrupt_path)
                .map_err(|err| AppError::new("historyCorruptMoveFailed", err.to_string()))?;
            Ok(Vec::new())
        }
    }
}

pub fn append_history(path: &Path, entry: UploadHistoryEntry) -> AppResult<()> {
    let mut entries = load_history(path)?;
    entries.insert(0, entry);
    if entries.len() > 500 {
        entries.truncate(500);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::new("historyDirFailed", err.to_string()))?;
    }

    let content = serde_json::to_string_pretty(&entries)
        .map_err(|err| AppError::new("historySerializeFailed", err.to_string()))?;

    // Write atomically: write to temp file in same directory, then rename
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, &content)
        .map_err(|err| AppError::new("historyWriteFailed", err.to_string()))?;
    fs::rename(&temp_path, path).map_err(|err| AppError::new("historyWriteFailed", err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ImageFormat;

    fn sample_entry(key: &str) -> UploadHistoryEntry {
        UploadHistoryEntry {
            profile_id: "p1".to_string(),
            bucket: "images".to_string(),
            object_key: key.to_string(),
            public_url: None,
            uploaded_at: "2026-06-26T00:00:00Z".to_string(),
            source_filename: "photo.jpg".to_string(),
            output_filename: "photo.webp".to_string(),
            original_bytes: 1000,
            uploaded_bytes: 500,
            target_format: ImageFormat::Webp,
        }
    }

    #[test]
    fn missing_history_returns_empty_vec() {
        let dir = tempfile::tempdir().unwrap();
        let entries = load_history(&dir.path().join("history.json")).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn append_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");

        append_history(&path, sample_entry("a.webp")).unwrap();
        append_history(&path, sample_entry("b.webp")).unwrap();

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].object_key, "b.webp");
        assert_eq!(entries[1].object_key, "a.webp");
    }

    #[test]
    fn history_cap_at_500() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");

        for i in 0..510 {
            append_history(&path, sample_entry(&format!("{}.webp", i))).unwrap();
        }

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 500);
        assert_eq!(entries[0].object_key, "509.webp");
        assert_eq!(entries[499].object_key, "10.webp");
    }

    #[test]
    fn successful_append_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");

        // Write initial history
        append_history(&path, sample_entry("original.webp")).unwrap();

        // Verify temp file does not linger after successful write
        let temp_path = path.with_extension("json.tmp");
        assert!(
            !temp_path.exists(),
            "temp file should not exist after successful append"
        );

        // Original file should still be readable
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].object_key, "original.webp");
    }

    #[test]
    fn corrupt_history_is_moved_aside_and_append_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        fs::write(&path, b"{not valid json").unwrap();

        append_history(&path, sample_entry("recovered.webp")).unwrap();

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].object_key, "recovered.webp");

        let corrupt_files = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("history.corrupt-")
            })
            .count();
        assert_eq!(corrupt_files, 1);
    }
}
