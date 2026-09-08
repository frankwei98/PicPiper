mod credentials;
mod error;
mod gallery;
mod history;
mod models;
mod naming;
mod optimizer;
mod settings;
mod state;
mod thumbnail;

use error::AppResult;
use models::{
    AppSettings, CompressImageRequest, CompressImageResult, CopyOutputsRequest,
    CreateOptimizerRunResponse, DeleteObjectRequest, DownloadObjectRequest, GalleryObject,
    GenerateObjectKeyRequest, GenerateObjectKeyResponse, ImageInspection, InspectImageRequest,
    ListObjectsRequest, ListObjectsResponse, ReadComparisonImageRequest,
    ReadComparisonImageResponse, ReadThumbnailRequest, ReadThumbnailResponse,
    SaveCredentialRequest, SaveCredentialResponse, SaveSettingsRequest, UploadHistoryEntry,
    UploadObjectRequest,
};
use state::{AppPaths, CompressionLimiter, HistoryStore};
use tauri::{Manager, State};

#[tauri::command]
fn get_default_settings() -> AppSettings {
    AppSettings::default()
}

#[tauri::command]
async fn inspect_image(request: InspectImageRequest) -> AppResult<ImageInspection> {
    tokio::task::spawn_blocking(move || optimizer::inspect_image(request))
        .await
        .map_err(|err| error::AppError::new("inspectJoinFailed", err.to_string()))?
}

#[tauri::command]
async fn read_thumbnail(request: ReadThumbnailRequest) -> AppResult<ReadThumbnailResponse> {
    tokio::task::spawn_blocking(move || thumbnail::read_thumbnail(request))
        .await
        .map_err(|err| error::AppError::new("thumbnailJoinFailed", err.to_string()))?
}

#[tauri::command]
async fn read_comparison_image(
    request: ReadComparisonImageRequest,
) -> AppResult<ReadComparisonImageResponse> {
    tokio::task::spawn_blocking(move || thumbnail::read_comparison_image(request))
        .await
        .map_err(|err| error::AppError::new("comparisonImageJoinFailed", err.to_string()))?
}

#[tauri::command]
async fn create_optimizer_run(paths: State<'_, AppPaths>) -> AppResult<CreateOptimizerRunResponse> {
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let cache_dir = paths.data_dir.join("optimizer-cache");
    let output_dir = cache_dir.join(&run_id);
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|err| error::AppError::new("outputDirFailed", err.to_string()))?;

    // Opportunistically clean up runs older than 7 days.
    let cache_dir_clone = cache_dir.clone();
    tokio::task::spawn_blocking(move || {
        optimizer::cleanup_old_runs(&cache_dir_clone, std::time::Duration::from_secs(7 * 86400));
    });

    Ok(CreateOptimizerRunResponse {
        run_id,
        output_dir: output_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn compress_image(
    paths: State<'_, AppPaths>,
    limiter: State<'_, CompressionLimiter>,
    request: CompressImageRequest,
) -> AppResult<CompressImageResult> {
    optimizer::validate_optimizer_output_dir(
        &paths.data_dir.join("optimizer-cache"),
        &request.output_dir,
    )?;
    let permit = limiter.acquire().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        optimizer::compress_image(request)
    })
    .await
    .map_err(|err| error::AppError::new("compressJoinFailed", err.to_string()))?
}

#[tauri::command]
async fn list_gallery_objects(
    paths: State<'_, AppPaths>,
    request: ListObjectsRequest,
) -> AppResult<ListObjectsResponse> {
    let secret = credentials::load_secret(&paths.credential_dir, &request.profile.id)?;
    gallery::list_objects(request, secret).await
}

#[tauri::command]
async fn delete_gallery_object(
    paths: State<'_, AppPaths>,
    request: DeleteObjectRequest,
) -> AppResult<()> {
    let secret = credentials::load_secret(&paths.credential_dir, &request.profile.id)?;
    gallery::delete_object(request, secret).await
}

#[tauri::command]
async fn upload_gallery_object(
    paths: State<'_, AppPaths>,
    history: State<'_, HistoryStore>,
    request: UploadObjectRequest,
) -> AppResult<GalleryObject> {
    let secret = credentials::load_secret(&paths.credential_dir, &request.profile.id)?;
    let object_key = request.object_key.clone();
    let profile_id = request.profile.id.clone();
    let bucket = request.profile.bucket.clone();
    let public_base_url = request.profile.public_base_url.clone();
    let source_filename = request.source_filename.clone();
    let output_filename = request.output_filename.clone();
    let original_bytes = request.original_bytes;
    let target_format = request.target_format;

    let result = gallery::upload_object(request, secret).await?;

    // Record history if optional fields are present
    if let (
        Some(source_filename),
        Some(output_filename),
        Some(original_bytes),
        Some(target_format),
    ) = (
        source_filename,
        output_filename,
        original_bytes,
        target_format,
    ) {
        let public_url = public_base_url.as_deref().map(|base| {
            format!(
                "{}/{}",
                base.trim_end_matches('/'),
                gallery::encode_object_key(object_key.trim_start_matches('/'))
            )
        });
        let entry = UploadHistoryEntry {
            profile_id,
            bucket,
            object_key,
            public_url,
            uploaded_at: chrono::Utc::now().to_rfc3339(),
            source_filename,
            output_filename,
            original_bytes,
            uploaded_bytes: result.size,
            target_format,
        };
        if let Err(err) = history.append_async(entry).await {
            eprintln!(
                "[history] warning: failed to append upload history: {}",
                err
            );
        }
    }

    Ok(result)
}

#[tauri::command]
async fn generate_object_key(
    request: GenerateObjectKeyRequest,
) -> AppResult<GenerateObjectKeyResponse> {
    naming::generate_object_key(request).await
}

#[tauri::command]
async fn download_gallery_object(
    paths: State<'_, AppPaths>,
    request: DownloadObjectRequest,
) -> AppResult<String> {
    let secret = credentials::load_secret(&paths.credential_dir, &request.profile.id)?;
    gallery::download_object(request, secret).await
}

#[tauri::command]
fn load_app_settings(paths: State<'_, AppPaths>) -> AppResult<AppSettings> {
    settings::load_settings(&paths.settings_path)
}

#[tauri::command]
fn save_app_settings(paths: State<'_, AppPaths>, request: SaveSettingsRequest) -> AppResult<()> {
    settings::save_settings(&paths.settings_path, &request.settings)
}

#[tauri::command]
fn save_s3_secret(
    paths: State<'_, AppPaths>,
    request: SaveCredentialRequest,
) -> AppResult<SaveCredentialResponse> {
    credentials::save_secret(&paths.credential_dir, request)
}

#[tauri::command]
async fn copy_outputs_to_dir(
    paths: State<'_, AppPaths>,
    request: CopyOutputsRequest,
) -> AppResult<Vec<String>> {
    optimizer::validate_optimizer_output_paths(
        &paths.data_dir.join("optimizer-cache"),
        &request.output_paths,
    )?;
    tokio::task::spawn_blocking(move || optimizer::copy_outputs_to_dir(request))
        .await
        .map_err(|err| error::AppError::new("copyJoinFailed", err.to_string()))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = state::AppPaths::from_app_handle(app.handle())?;
            let history_store = state::HistoryStore::new(paths.history_path.clone());
            app.manage(history_store);
            app.manage(CompressionLimiter::new(CompressionLimiter::DEFAULT_LIMIT));
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_settings,
            inspect_image,
            create_optimizer_run,
            compress_image,
            copy_outputs_to_dir,
            read_thumbnail,
            read_comparison_image,
            list_gallery_objects,
            delete_gallery_object,
            upload_gallery_object,
            download_gallery_object,
            generate_object_key,
            load_app_settings,
            save_app_settings,
            save_s3_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
