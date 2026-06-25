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
    AppSettings, CompressImageRequest, CompressImageResult, DeleteObjectRequest, GalleryObject,
    ImageInspection, InspectImageRequest, ListObjectsRequest,
};
use tauri::Manager;

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
async fn list_gallery_objects(request: ListObjectsRequest) -> AppResult<Vec<GalleryObject>> {
    let _ = request;
    Ok(Vec::new())
}

#[tauri::command]
async fn delete_gallery_object(request: DeleteObjectRequest) -> AppResult<()> {
    let _ = request;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = state::AppPaths::from_app_handle(app.handle())?;
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_settings,
            inspect_image,
            compress_image,
            list_gallery_objects,
            delete_gallery_object
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
