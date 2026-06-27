use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::models::UploadHistoryEntry;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub settings_path: PathBuf,
    pub history_path: PathBuf,
    pub credential_fallback_dir: PathBuf,
}

/// Thread-safe wrapper around history file access. Serializes read-modify-write
/// to prevent lost updates when multiple uploads complete concurrently.
///
/// The `append_async` method runs the entire lock + I/O sequence on a blocking
/// thread pool to avoid blocking the Tokio runtime.
pub struct HistoryStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl HistoryStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// Append a history entry without blocking the async runtime.
    ///
    /// Both the mutex acquisition and file I/O run on `spawn_blocking`,
    /// keeping Tokio worker threads free.
    pub async fn append_async(&self, entry: UploadHistoryEntry) -> AppResult<()> {
        let path = self.path.clone();
        let lock = self.lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = lock.lock().expect("history lock poisoned");
            crate::history::append_history(&path, entry)
        })
        .await
        .map_err(|err| AppError::new("historyJoinFailed", err.to_string()))?
    }
}

impl AppPaths {
    pub fn from_app_handle(app: &tauri::AppHandle) -> AppResult<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| AppError::new("appDataDirFailed", err.to_string()))?;
        Ok(Self {
            settings_path: data_dir.join("settings.json"),
            history_path: data_dir.join("upload-history.json"),
            credential_fallback_dir: data_dir.join("credential-fallback"),
            data_dir,
        })
    }
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

    #[tokio::test]
    async fn history_store_concurrent_appends_all_recorded() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        let store = Arc::new(HistoryStore::new(path.clone()));

        // Simulate concurrent appends from multiple async tasks
        let handles: Vec<_> = (0..10)
            .map(|i| {
                let store = Arc::clone(&store);
                tokio::spawn(async move {
                    store
                        .append_async(sample_entry(&format!("file-{}.webp", i)))
                        .await
                        .unwrap();
                })
            })
            .collect();

        for h in handles {
            h.await.unwrap();
        }

        let entries = crate::history::load_history(&path).unwrap();
        assert_eq!(
            entries.len(),
            10,
            "all 10 concurrent appends should be recorded"
        );
    }
}
