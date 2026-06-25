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
    pub insecure_secret_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompressionPreset {
    pub id: String,
    pub name: String,
    pub target_format: ImageFormat,
    pub quality: u8,
    pub max_width: u32,
    pub max_height: u32,
    pub allow_upscale: bool,
    pub remove_gps: bool,
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
    pub presets: Vec<CompressionPreset>,
    pub naming_template: String,
    pub default_output_dir: Option<String>,
    pub default_profile_id: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            presets: vec![CompressionPreset {
                id: "small-web".to_string(),
                name: "Small web image".to_string(),
                target_format: ImageFormat::Webp,
                quality: 68,
                max_width: 1600,
                max_height: 1600,
                allow_upscale: false,
                remove_gps: true,
            }],
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
    pub allow_insecure_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialResponse {
    pub credential_ref: String,
    pub insecure_fallback_used: bool,
}
