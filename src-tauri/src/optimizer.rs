use std::{
    fs,
    path::{Path, PathBuf},
};

use image::{
    codecs::{avif::AvifEncoder, jpeg::JpegEncoder},
    DynamicImage, ImageEncoder, ImageFormat as CodecFormat,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        CompressImageRequest, CompressImageResult, CopyOutputsRequest, ImageFormat,
        ImageInspection, InspectImageRequest,
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

pub fn copy_outputs_to_dir(request: CopyOutputsRequest) -> AppResult<Vec<String>> {
    let target = Path::new(&request.target_dir);
    fs::create_dir_all(target).map_err(|err| AppError::new("targetDirFailed", err.to_string()))?;

    let mut copied = Vec::new();

    for src_path in &request.output_paths {
        let file_name = Path::new(src_path)
            .file_name()
            .ok_or_else(|| AppError::new("invalidPath", "Could not extract filename from path"))?;
        let dest = unique_destination_path(target, &file_name.to_string_lossy());
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

/// Choose a unique file path in `dir` based on `file_name`.
///
/// If `dir/file_name` does not exist, returns it as-is. Otherwise appends
/// `-2`, `-3`, etc. before the extension until a free path is found.
pub fn unique_destination_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), Some(e.to_string())),
        _ => (file_name.to_string(), None),
    };

    for n in 2.. {
        let name = match &ext {
            Some(e) => format!("{}-{}.{}", stem, n, e),
            None => format!("{}-{}", stem, n),
        };
        let path = dir.join(&name);
        if !path.exists() {
            return path;
        }
    }
    unreachable!()
}

/// Delete optimizer-cache/run-* directories older than `max_age`.
/// Returns the number of directories removed. Best-effort: individual
/// removal failures are silently ignored.
pub fn cleanup_old_runs(cache_dir: &Path, max_age: std::time::Duration) -> usize {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return 0;
    };

    let now = std::time::SystemTime::now();
    let mut removed = 0;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("run-") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() > max_age {
            let _ = fs::remove_dir_all(entry.path());
            removed += 1;
        }
    }

    removed
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
    use crate::models::CompressionSettings;
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
        assert!(
            warning_false.is_some(),
            "gps_warning(false) should also warn since metadata is always stripped"
        );
        assert_eq!(
            warning_true, warning_false,
            "warning should be the same regardless of flag"
        );
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
            result
                .warning
                .as_deref()
                .unwrap_or("")
                .contains("EXIF metadata"),
            "Compressed output should include metadata warning, got: {:?}",
            result.warning
        );
    }

    #[test]
    fn unique_destination_path_returns_original_when_free() {
        let dir = tempfile::tempdir().unwrap();
        let path = unique_destination_path(dir.path(), "photo.webp");
        assert_eq!(path, dir.path().join("photo.webp"));
    }

    #[test]
    fn unique_destination_path_appends_suffix_when_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("photo.webp"), b"existing").unwrap();
        let path = unique_destination_path(dir.path(), "photo.webp");
        assert_eq!(path, dir.path().join("photo-2.webp"));
    }

    #[test]
    fn unique_destination_path_skips_existing_suffixes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("photo.webp"), b"1").unwrap();
        std::fs::write(dir.path().join("photo-2.webp"), b"2").unwrap();
        let path = unique_destination_path(dir.path(), "photo.webp");
        assert_eq!(path, dir.path().join("photo-3.webp"));
    }

    #[test]
    fn copy_outputs_to_dir_does_not_overwrite_existing() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir_all(&target).unwrap();

        // Create source files
        std::fs::write(src.join("photo.webp"), b"new").unwrap();

        // Pre-existing file in target
        std::fs::write(target.join("photo.webp"), b"old").unwrap();

        let copied = copy_outputs_to_dir(CopyOutputsRequest {
            output_paths: vec![src.join("photo.webp").to_string_lossy().to_string()],
            target_dir: target.to_string_lossy().to_string(),
        })
        .unwrap();

        assert_eq!(copied.len(), 1);
        assert_eq!(copied[0], target.join("photo-2.webp").to_string_lossy());
        // Original is untouched
        assert_eq!(std::fs::read(target.join("photo.webp")).unwrap(), b"old");
        // New file written to unique path
        assert_eq!(std::fs::read(&copied[0]).unwrap(), b"new");
    }

    #[test]
    fn cleanup_old_runs_removes_stale_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("optimizer-cache");
        std::fs::create_dir_all(cache.join("run-recent")).unwrap();
        std::fs::create_dir_all(cache.join("run-old")).unwrap();

        // Make "run-old" appear old by backdating its mtime.
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86400);
        let old_file = cache.join("run-old").join("placeholder");
        std::fs::write(&old_file, b"x").unwrap();
        filetime::set_file_mtime(&old_file, filetime::FileTime::from_system_time(old_time))
            .unwrap();
        filetime::set_file_mtime(
            cache.join("run-old"),
            filetime::FileTime::from_system_time(old_time),
        )
        .unwrap();

        let removed = cleanup_old_runs(&cache, std::time::Duration::from_secs(7 * 86400));
        assert_eq!(removed, 1);
        assert!(!cache.join("run-old").exists());
        assert!(cache.join("run-recent").exists());
    }

    #[test]
    fn cleanup_old_runs_ignores_non_run_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("optimizer-cache");
        std::fs::create_dir_all(cache.join("other-stuff")).unwrap();

        let removed = cleanup_old_runs(&cache, std::time::Duration::from_secs(0));
        assert_eq!(removed, 0);
        assert!(cache.join("other-stuff").exists());
    }
}
