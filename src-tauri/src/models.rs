use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3Profile {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub credential_ref: Option<String>,
    pub path_style: bool,
    pub public_base_url: Option<String>,
    pub default_prefix: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpg,
    Png,
    Webp,
    Avif,
    Heif,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub profiles: Vec<S3Profile>,
    pub naming_template: String,
    pub default_output_dir: Option<String>,
    pub default_profile_id: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            naming_template: "{yyyy}/{mm}/{slug}-{hash}.{ext}".to_string(),
            default_output_dir: None,
            default_profile_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadHistoryEntry {
    pub profile_id: String,
    pub bucket: String,
    pub object_key: String,
    pub public_url: Option<String>,
    pub uploaded_at: String,
    pub source_filename: String,
    pub output_filename: String,
    pub original_bytes: u64,
    pub uploaded_bytes: u64,
    pub target_format: ImageFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialRequest {
    pub profile_id: String,
    pub secret_access_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialResponse {
    pub credential_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressionSettings {
    pub target_format: ImageFormat,
    pub quality: u8,
    /// Ignored — metadata (including GPS) is always stripped during compression.
    pub remove_gps: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectImageRequest {
    pub path: String,
    pub settings: CompressionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInspection {
    pub path: String,
    pub file_name: String,
    pub source_format: Option<ImageFormat>,
    pub original_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub estimated_bytes: Option<u64>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressImageRequest {
    pub source_path: String,
    pub output_dir: String,
    pub output_file_name: String,
    pub settings: CompressionSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressImageResult {
    pub source_path: String,
    pub output_path: String,
    pub output_file_name: String,
    pub original_bytes: u64,
    pub output_bytes: u64,
    pub target_format: ImageFormat,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GalleryObject {
    pub key: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub public_url: Option<String>,
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsRequest {
    pub profile: S3Profile,
    pub prefix: String,
    #[serde(default)]
    pub continuation_token: Option<String>,
    #[serde(default)]
    pub page_size: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListObjectsResponse {
    pub objects: Vec<GalleryObject>,
    pub next_continuation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteObjectRequest {
    pub profile: S3Profile,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadObjectRequest {
    pub profile: S3Profile,
    pub source_path: String,
    pub object_key: String,
    pub content_type: Option<String>,
    pub source_filename: Option<String>,
    pub output_filename: Option<String>,
    pub original_bytes: Option<u64>,
    pub target_format: Option<ImageFormat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateObjectKeyRequest {
    pub source_path: String,
    pub output_file_name: String,
    pub prefix: String,
    pub naming_template: String,
    pub ext: String,
    #[serde(default)]
    pub collision_suffix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateObjectKeyResponse {
    pub object_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadObjectRequest {
    pub profile: S3Profile,
    pub key: String,
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsRequest {
    pub settings: AppSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateOptimizerRunResponse {
    pub run_id: String,
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutputsRequest {
    pub output_paths: Vec<String>,
    pub target_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadThumbnailRequest {
    pub path: String,
    pub max_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadThumbnailResponse {
    pub data_url: String,
}
