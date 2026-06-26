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
    CompressImageResult, CopyOutputsRequest, DeleteObjectRequest, GalleryObject, ImageInspection,
    InspectImageRequest, ListObjectsRequest, SaveCredentialRequest, SaveCredentialResponse,
    SaveSettingsRequest, UploadObjectRequest,
};
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
    gallery::upload_object(request, secret).await
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
            list_gallery_objects,
            delete_gallery_object,
            upload_gallery_object,
            load_app_settings,
            save_app_settings,
            save_s3_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
