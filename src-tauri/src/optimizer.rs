use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use image::{
    codecs::{avif::AvifEncoder, jpeg::JpegEncoder},
    DynamicImage, ImageEncoder, ImageFormat as CodecFormat,
};
use rayon::prelude::*;

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

    fs::create_dir_all(&request.output_dir)
        .map_err(|err| AppError::new("outputDirFailed", err.to_string()))?;
    let output_path = Path::new(&request.output_dir).join(&request.output_file_name);

    match request.settings.target_format {
        ImageFormat::Jpg => write_jpeg(&image, &output_path, request.settings.quality)?,
        ImageFormat::Png => image
            .save_with_format(&output_path, CodecFormat::Png)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?,
        ImageFormat::Webp => write_webp(&image, &output_path, request.settings.quality)?,
        ImageFormat::Avif => write_avif(&image, &output_path, request.settings.quality)?,
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
    data_dir: &Path,
    request: CompressBatchRequest,
) -> AppResult<CompressBatchResponse> {
    let run_id = format!(
        "run-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    );
    let output_dir = data_dir.join("optimizer-cache").join(&run_id);
    fs::create_dir_all(&output_dir)
        .map_err(|err| AppError::new("outputDirFailed", err.to_string()))?;

    let output_dir_str = output_dir.to_string_lossy().to_string();

    let output_file_names = unique_output_file_names(
        request
            .items
            .iter()
            .map(|item| item.output_file_name.as_str()),
    );

    let results: Vec<CompressBatchItemResult> = request
        .items
        .into_par_iter()
        .zip(output_file_names)
        .map(|(item, output_file_name)| {
            match compress_image(CompressImageRequest {
                source_path: item.source_path,
                output_dir: output_dir_str.clone(),
                output_file_name,
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
            }
        })
        .collect();

    Ok(CompressBatchResponse {
        run_id,
        output_dir: output_dir_str,
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

fn unique_output_file_names<'a>(file_names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashMap::<String, usize>::new();

    file_names
        .into_iter()
        .map(|file_name| {
            let count = seen.entry(file_name.to_string()).or_insert(0);
            *count += 1;
            if *count == 1 {
                file_name.to_string()
            } else {
                append_file_name_suffix(file_name, *count)
            }
        })
        .collect()
}

fn append_file_name_suffix(file_name: &str, suffix: usize) -> String {
    match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            format!("{}-{}.{}", stem, suffix, ext)
        }
        _ => format!("{}-{}", file_name, suffix),
    }
}

fn estimate_bytes(original_bytes: u64, quality: u8) -> u64 {
    let quality_factor = quality.clamp(1, 100) as f64 / 100.0;
    (original_bytes as f64 * quality_factor * 0.35)
        .max(1024.0)
        .round() as u64
}

fn write_jpeg(image: &DynamicImage, output_path: &Path, quality: u8) -> AppResult<()> {
    let file = fs::File::create(output_path)
        .map_err(|err| AppError::new("outputWriteFailed", err.to_string()))?;
    let mut encoder = JpegEncoder::new_with_quality(file, quality.clamp(1, 100));
    encoder
        .encode_image(image)
        .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))
}

fn write_webp(image: &DynamicImage, output_path: &Path, quality: u8) -> AppResult<()> {
    let rgba = image.to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, image.width(), image.height());
    let encoded = encoder.encode(quality.clamp(1, 100) as f32);
    fs::write(output_path, &*encoded)
        .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))
}

fn write_avif(image: &DynamicImage, output_path: &Path, quality: u8) -> AppResult<()> {
    let file = fs::File::create(output_path)
        .map_err(|err| AppError::new("outputWriteFailed", err.to_string()))?;
    let encoder = AvifEncoder::new_with_speed_quality(file, 6, quality.clamp(1, 100));
    encoder
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
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

fn gps_warning(_remove_gps: bool) -> Option<String> {
    // The built-in encoder always re-encodes pixel data, which strips all
    // EXIF/IPTC/XMP metadata (including GPS) regardless of this flag.
    Some("EXIF metadata (including GPS) was stripped during re-encoding.".to_string())
}

fn quality_format_warning(target_format: &ImageFormat) -> Option<String> {
    match target_format {
        ImageFormat::Png => Some(
            "Quality setting does not apply to PNG output. PNG is always lossless.".to_string(),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompressBatchItem, CompressionSettings};
    use image::GenericImageView;

    /// Create a test image with some visual complexity (gradient pattern)
    /// so lossy encoders actually have something to compress differently.
    fn create_test_image(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(width, height, |x, y| {
            image::Rgb([
                ((x as f64 / width as f64) * 255.0) as u8,
                ((y as f64 / height as f64) * 255.0) as u8,
                (((x + y) as f64 / (width + height) as f64) * 255.0) as u8,
            ])
        }))
    }

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
                remove_gps: true,
            },
        });

        assert_eq!(result.unwrap_err().code, "codecUnavailable");
    }

    #[test]
    fn compression_preserves_source_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.png");
        create_test_image(80, 40).save(&input).unwrap();

        let result = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "output.jpg".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Jpg,
                quality: 75,
                remove_gps: true,
            },
        })
        .unwrap();

        let output = image::open(result.output_path).unwrap();
        assert_eq!(output.dimensions(), (80, 40));
    }

    #[test]
    fn webp_quality_affects_output_size() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.png");
        create_test_image(64, 64).save(&input).unwrap();

        let low = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "low.webp".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Webp,
                quality: 10,
                remove_gps: true,
            },
        })
        .unwrap();

        let high = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "high.webp".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Webp,
                quality: 90,
                remove_gps: true,
            },
        })
        .unwrap();

        assert!(
            low.output_bytes < high.output_bytes,
            "Low-quality WebP ({} bytes) should be smaller than high-quality WebP ({} bytes)",
            low.output_bytes,
            high.output_bytes
        );
    }

    #[test]
    fn avif_quality_affects_output_size() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.png");
        create_test_image(64, 64).save(&input).unwrap();

        let low = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "low.avif".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Avif,
                quality: 10,
                remove_gps: true,
            },
        })
        .unwrap();

        let high = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "high.avif".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Avif,
                quality: 90,
                remove_gps: true,
            },
        })
        .unwrap();

        assert!(
            low.output_bytes < high.output_bytes,
            "Low-quality AVIF ({} bytes) should be smaller than high-quality AVIF ({} bytes)",
            low.output_bytes,
            high.output_bytes
        );
    }

    #[test]
    fn webp_quality_warning_removed() {
        let warning = quality_format_warning(&ImageFormat::Webp);
        assert!(
            warning.is_none(),
            "WebP should not warn that quality is ignored, got: {:?}",
            warning
        );
    }

    #[test]
    fn avif_quality_warning_removed() {
        let warning = quality_format_warning(&ImageFormat::Avif);
        assert!(
            warning.is_none(),
            "AVIF should not warn that quality is ignored, got: {:?}",
            warning
        );
    }

    #[test]
    fn png_still_warns_about_quality() {
        let warning = quality_format_warning(&ImageFormat::Png);
        assert!(warning.is_some(), "PNG should still warn about quality");
    }

    #[test]
    fn gps_warning_always_warns_regardless_of_flag() {
        // Metadata stripping happens during re-encoding regardless of the flag
        let warning_true = gps_warning(true);
        let warning_false = gps_warning(false);

        assert!(warning_true.is_some(), "gps_warning(true) should warn");
        assert!(warning_false.is_some(), "gps_warning(false) should also warn since metadata is always stripped");
        assert_eq!(warning_true, warning_false, "warning should be the same regardless of flag");
    }

    #[test]
    fn compress_image_includes_metadata_warning() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("test.png");
        create_test_image(32, 32).save(&input).unwrap();

        let result = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "output.jpg".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Jpg,
                quality: 75,
                remove_gps: true,
            },
        })
        .unwrap();

        assert!(
            result.warning.as_deref().unwrap_or("").contains("EXIF metadata"),
            "Compressed output should include metadata warning, got: {:?}",
            result.warning
        );
    }

    #[test]
    fn compress_batch_parallel_returns_results_for_all_items() {
        let dir = tempfile::tempdir().unwrap();
        // Create 3 test images.
        let mut items = Vec::new();
        for i in 0..3 {
            let input = dir.path().join(format!("src_{}.png", i));
            create_test_image(48, 48).save(&input).unwrap();
            items.push(CompressBatchItem {
                id: format!("item-{}", i),
                source_path: input.to_string_lossy().to_string(),
                output_file_name: format!("out_{}.jpg", i),
                settings: CompressionSettings {
                    target_format: ImageFormat::Jpg,
                    quality: 75,
                    remove_gps: true,
                },
            });
        }

        let data_dir = dir.path().to_path_buf();
        let response = compress_batch(&data_dir, CompressBatchRequest { items }).unwrap();

        assert_eq!(response.items.len(), 3);
        for item_result in &response.items {
            assert!(
                item_result.result.is_some(),
                "item {} should have succeeded",
                item_result.id
            );
            assert!(
                item_result.error.is_none(),
                "item {} should have no error",
                item_result.id
            );
            let result = item_result.result.as_ref().unwrap();
            assert!(
                std::path::Path::new(&result.output_path).exists(),
                "output file should exist: {}",
                result.output_path
            );
        }
    }

    #[test]
    fn compress_batch_preserves_item_ids() {
        let dir = tempfile::tempdir().unwrap();
        let mut items = Vec::new();
        for i in 0..3 {
            let input = dir.path().join(format!("id_src_{}.png", i));
            create_test_image(32, 32).save(&input).unwrap();
            items.push(CompressBatchItem {
                id: format!("batch-{}", i),
                source_path: input.to_string_lossy().to_string(),
                output_file_name: format!("id_out_{}.jpg", i),
                settings: CompressionSettings {
                    target_format: ImageFormat::Jpg,
                    quality: 75,
                    remove_gps: true,
                },
            });
        }

        let expected_ids: std::collections::HashSet<_> =
            items.iter().map(|i| i.id.clone()).collect();

        let data_dir = dir.path().to_path_buf();
        let response = compress_batch(&data_dir, CompressBatchRequest { items }).unwrap();

        let actual_ids: std::collections::HashSet<_> =
            response.items.iter().map(|i| i.id.clone()).collect();

        assert_eq!(expected_ids, actual_ids, "item IDs must be preserved");
    }

    #[test]
    fn compress_batch_disambiguates_duplicate_output_file_names() {
        let dir = tempfile::tempdir().unwrap();
        let first_input = dir.path().join("first").join("photo.png");
        let second_input = dir.path().join("second").join("photo.png");
        std::fs::create_dir_all(first_input.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second_input.parent().unwrap()).unwrap();
        create_test_image(32, 32).save(&first_input).unwrap();
        create_test_image(48, 48).save(&second_input).unwrap();

        let response = compress_batch(
            dir.path(),
            CompressBatchRequest {
                items: vec![
                    CompressBatchItem {
                        id: "first".to_string(),
                        source_path: first_input.to_string_lossy().to_string(),
                        output_file_name: "photo.jpg".to_string(),
                        settings: CompressionSettings {
                            target_format: ImageFormat::Jpg,
                            quality: 75,
                            remove_gps: true,
                        },
                    },
                    CompressBatchItem {
                        id: "second".to_string(),
                        source_path: second_input.to_string_lossy().to_string(),
                        output_file_name: "photo.jpg".to_string(),
                        settings: CompressionSettings {
                            target_format: ImageFormat::Jpg,
                            quality: 75,
                            remove_gps: true,
                        },
                    },
                ],
            },
        )
        .unwrap();

        let output_paths: std::collections::HashSet<_> = response
            .items
            .iter()
            .map(|item| item.result.as_ref().unwrap().output_path.clone())
            .collect();

        assert_eq!(
            output_paths.len(),
            2,
            "duplicate output names must not write to the same path"
        );
    }
}
