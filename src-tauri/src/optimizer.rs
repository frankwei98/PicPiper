use std::{
    fs,
    path::{Path, PathBuf},
};

use image::{
    codecs::jpeg::JpegEncoder, DynamicImage, GenericImageView, ImageFormat as CodecFormat,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        CompressBatchItemResult, CompressBatchRequest, CompressBatchResponse, CompressImageRequest,
        CompressImageResult, CopyOutputsRequest, ImageFormat, ImageInspection, InspectImageRequest,
        ItemError,
    },
};

pub fn inspect_image(request: InspectImageRequest) -> AppResult<ImageInspection> {
    let path = PathBuf::from(&request.path);
    let metadata =
        fs::metadata(&path).map_err(|err| AppError::new("imageReadFailed", err.to_string()))?;
    let reader = image::ImageReader::open(&path)
        .map_err(|err| AppError::new("imageOpenFailed", err.to_string()))?
        .with_guessed_format()
        .map_err(|err| AppError::new("imageFormatFailed", err.to_string()))?;
    let source_format = reader.format().and_then(map_codec_format);
    let dimensions = reader
        .into_dimensions()
        .map_err(|err| AppError::new("imageDimensionFailed", err.to_string()))?;

    Ok(ImageInspection {
        path: request.path,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image")
            .to_string(),
        source_format,
        original_bytes: metadata.len(),
        width: dimensions.0,
        height: dimensions.1,
        estimated_bytes: Some(estimate_bytes(metadata.len(), request.settings.quality)),
        warning: None,
    })
}

pub fn compress_image(request: CompressImageRequest) -> AppResult<CompressImageResult> {
    let source = PathBuf::from(&request.source_path);
    let original_bytes = fs::metadata(&source)
        .map_err(|err| AppError::new("imageReadFailed", err.to_string()))?
        .len();
    let image =
        image::open(&source).map_err(|err| AppError::new("imageDecodeFailed", err.to_string()))?;
    let resized = resize_if_needed(
        image,
        request.settings.max_width,
        request.settings.max_height,
        request.settings.allow_upscale,
    );

    fs::create_dir_all(&request.output_dir)
        .map_err(|err| AppError::new("outputDirFailed", err.to_string()))?;
    let output_path = Path::new(&request.output_dir).join(&request.output_file_name);

    match request.settings.target_format {
        ImageFormat::Jpg => write_jpeg(&resized, &output_path, request.settings.quality)?,
        ImageFormat::Png => resized
            .save_with_format(&output_path, CodecFormat::Png)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Webp => resized
            .save_with_format(&output_path, CodecFormat::WebP)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Avif => resized
            .save_with_format(&output_path, CodecFormat::Avif)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Heif => {
            return Err(AppError::new(
                "codecUnavailable",
                "HEIF/HEIC output is not available in the built-in encoder.",
            ));
        }
    }

    let output_bytes = fs::metadata(&output_path)
        .map_err(|err| AppError::new("outputReadFailed", err.to_string()))?
        .len();

    let warning = [
        gps_warning(request.settings.remove_gps),
        quality_format_warning(&request.settings.target_format),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");

    Ok(CompressImageResult {
        source_path: request.source_path,
        output_path: output_path.to_string_lossy().to_string(),
        output_file_name: request.output_file_name,
        original_bytes,
        output_bytes,
        target_format: request.settings.target_format,
        warning: if warning.is_empty() {
            None
        } else {
            Some(warning)
        },
    })
}

pub fn compress_batch(
    paths: &crate::state::AppPaths,
    request: CompressBatchRequest,
) -> AppResult<CompressBatchResponse> {
    let run_id = format!(
        "run-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let output_dir = paths.data_dir.join("optimizer-cache").join(&run_id);
    fs::create_dir_all(&output_dir)
        .map_err(|err| AppError::new("outputDirFailed", err.to_string()))?;

    let mut results = Vec::new();

    for item in request.items {
        let item_result = match compress_image(CompressImageRequest {
            source_path: item.source_path.clone(),
            output_dir: output_dir.to_string_lossy().to_string(),
            output_file_name: item.output_file_name.clone(),
            settings: item.settings,
        }) {
            Ok(result) => CompressBatchItemResult {
                id: item.id,
                result: Some(result),
                error: None,
            },
            Err(err) => CompressBatchItemResult {
                id: item.id,
                result: None,
                error: Some(ItemError {
                    code: err.code,
                    message: err.message,
                    recoverable: err.recoverable,
                }),
            },
        };
        results.push(item_result);
    }

    Ok(CompressBatchResponse {
        run_id,
        output_dir: output_dir.to_string_lossy().to_string(),
        items: results,
    })
}

pub fn copy_outputs_to_dir(request: CopyOutputsRequest) -> AppResult<Vec<String>> {
    let target = Path::new(&request.target_dir);
    fs::create_dir_all(target).map_err(|err| AppError::new("targetDirFailed", err.to_string()))?;

    let mut copied = Vec::new();

    for src_path in &request.output_paths {
        let file_name = Path::new(src_path)
            .file_name()
            .ok_or_else(|| AppError::new("invalidPath", "Could not extract filename from path"))?;
        let dest = target.join(file_name);
        fs::copy(src_path, &dest).map_err(|err| {
            AppError::new(
                "copyFailed",
                format!("Failed to copy {}: {}", src_path, err),
            )
        })?;
        copied.push(dest.to_string_lossy().to_string());
    }

    Ok(copied)
}

fn estimate_bytes(original_bytes: u64, quality: u8) -> u64 {
    let quality_factor = quality.clamp(1, 100) as f64 / 100.0;
    (original_bytes as f64 * quality_factor * 0.35)
        .max(1024.0)
        .round() as u64
}

fn resize_if_needed(
    image: DynamicImage,
    max_width: u32,
    max_height: u32,
    allow_upscale: bool,
) -> DynamicImage {
    let (width, height) = image.dimensions();
    if !allow_upscale && width <= max_width && height <= max_height {
        return image;
    }
    image.thumbnail(max_width, max_height)
}

fn write_jpeg(image: &DynamicImage, output_path: &Path, quality: u8) -> AppResult<()> {
    let file = fs::File::create(output_path)
        .map_err(|err| AppError::new("outputWriteFailed", err.to_string()))?;
    let mut encoder = JpegEncoder::new_with_quality(file, quality.clamp(1, 100));
    encoder
        .encode_image(image)
        .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))
}

fn map_codec_format(format: CodecFormat) -> Option<ImageFormat> {
    match format {
        CodecFormat::Jpeg => Some(ImageFormat::Jpg),
        CodecFormat::Png => Some(ImageFormat::Png),
        CodecFormat::WebP => Some(ImageFormat::Webp),
        CodecFormat::Avif => Some(ImageFormat::Avif),
        _ => None,
    }
}

fn gps_warning(remove_gps: bool) -> Option<String> {
    if remove_gps {
        Some("EXIF metadata was not preserved during re-encoding.".to_string())
    } else {
        None
    }
}

fn quality_format_warning(target_format: &ImageFormat) -> Option<String> {
    match target_format {
        ImageFormat::Png | ImageFormat::Webp | ImageFormat::Avif => Some(
            "Quality setting only applies to JPEG output. This format uses its default quality."
                .to_string(),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CompressionSettings;

    #[test]
    fn estimate_decreases_with_lower_quality() {
        assert!(estimate_bytes(1_000_000, 50) < estimate_bytes(1_000_000, 90));
    }

    #[test]
    fn heif_output_returns_codec_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.png");
        DynamicImage::new_rgb8(20, 20).save(&input).unwrap();

        let result = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "sample.heif".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Heif,
                quality: 70,
                max_width: 20,
                max_height: 20,
                allow_upscale: false,
                remove_gps: true,
            },
        });

        assert_eq!(result.unwrap_err().code, "codecUnavailable");
    }
}
