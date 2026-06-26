mod credentials;
mod error;
mod gallery;
mod history;
mod models;
mod naming;
mod optimizer;
mod settings;
mod state;

use error::AppResult;
use models::{
    AppSettings, CompressBatchRequest, CompressBatchResponse, CompressImageRequest,
    CompressImageResult, CopyOutputsRequest, DeleteObjectRequest, DownloadObjectRequest,
    GalleryObject, GenerateObjectKeyRequest, GenerateObjectKeyResponse, ImageInspection,
    InspectImageRequest, ListObjectsRequest, ReadThumbnailRequest, ReadThumbnailResponse,
    SaveCredentialRequest, SaveCredentialResponse, SaveSettingsRequest, UploadHistoryEntry,
    UploadObjectRequest,
};
use sha2::{Digest, Sha256};
use state::AppPaths;
use tauri::{Manager, State};

#[tauri::command]
fn get_default_settings() -> AppSettings {
    AppSettings::default()
}

#[tauri::command]
fn inspect_image(request: InspectImageRequest) -> AppResult<ImageInspection> {
    optimizer::inspect_image(request)
}

#[tauri::command]
async fn read_thumbnail(request: ReadThumbnailRequest) -> AppResult<ReadThumbnailResponse> {
    tokio::task::spawn_blocking(move || optimizer::read_thumbnail(request))
        .await
        .map_err(|err| error::AppError::new("thumbnailJoinFailed", err.to_string()))?
}

#[tauri::command]
fn compress_image(request: CompressImageRequest) -> AppResult<CompressImageResult> {
    optimizer::compress_image(request)
}

#[tauri::command]
async fn list_gallery_objects(
    paths: State<'_, AppPaths>,
    request: ListObjectsRequest,
) -> AppResult<Vec<GalleryObject>> {
    let secret = credentials::load_secret(&paths.credential_fallback_dir, &request.profile.id)?;
    gallery::list_objects(request, secret).await
}

#[tauri::command]
async fn delete_gallery_object(
    paths: State<'_, AppPaths>,
    request: DeleteObjectRequest,
) -> AppResult<()> {
    let secret = credentials::load_secret(&paths.credential_fallback_dir, &request.profile.id)?;
    gallery::delete_object(request, secret).await
}

#[tauri::command]
async fn upload_gallery_object(
    paths: State<'_, AppPaths>,
    request: UploadObjectRequest,
) -> AppResult<GalleryObject> {
    let secret = credentials::load_secret(&paths.credential_fallback_dir, &request.profile.id)?;
    let object_key = request.object_key.clone();
    let profile_id = request.profile.id.clone();
    let bucket = request.profile.bucket.clone();
    let public_base_url = request.profile.public_base_url.clone();
    let source_filename = request.source_filename.clone();
    let output_filename = request.output_filename.clone();
    let original_bytes = request.original_bytes;
    let target_format = request.target_format.clone();

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
                object_key.trim_start_matches('/')
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
        let _ = history::append_history(&paths.history_path, entry);
    }

    Ok(result)
}

#[tauri::command]
async fn generate_object_key(
    request: GenerateObjectKeyRequest,
) -> AppResult<GenerateObjectKeyResponse> {
    let bytes = std::fs::read(&request.source_path)
        .map_err(|err| error::AppError::new("readFileFailed", err.to_string()))?;
    let hash = Sha256::digest(&bytes);
    let content_hash = hex::encode(hash);

    let date = chrono::Utc::now().date_naive();
    let rendered = naming::render_object_key(
        &request.naming_template,
        &request.output_file_name,
        &request.ext,
        &content_hash,
        date,
    )?;

    // Prefix the rendered key with the selected prefix if the template doesn't already start with it
    let prefix_normalized = request.prefix.trim_end_matches('/');
    let object_key = if !rendered.starts_with(prefix_normalized) && !prefix_normalized.is_empty() {
        format!("{}/{}", prefix_normalized, rendered)
    } else {
        rendered
    };

    // Normalize slashes
    let object_key = object_key.replace('\\', "/");

    Ok(GenerateObjectKeyResponse { object_key })
}

#[tauri::command]
async fn download_gallery_object(
    paths: State<'_, AppPaths>,
    request: DownloadObjectRequest,
) -> AppResult<String> {
    let secret = credentials::load_secret(&paths.credential_fallback_dir, &request.profile.id)?;
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
    credentials::save_secret(&paths.credential_fallback_dir, request)
}

#[tauri::command]
fn compress_batch(
    paths: State<'_, AppPaths>,
    request: CompressBatchRequest,
) -> AppResult<CompressBatchResponse> {
    optimizer::compress_batch(&paths, request)
}

#[tauri::command]
fn copy_outputs_to_dir(request: CopyOutputsRequest) -> AppResult<Vec<String>> {
    optimizer::copy_outputs_to_dir(request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = state::AppPaths::from_app_handle(app.handle())?;
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_settings,
            inspect_image,
            compress_image,
            compress_batch,
            copy_outputs_to_dir,
            read_thumbnail,
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
