use std::{
    fs, io,
    path::{Path, PathBuf},
};

use image::{
    codecs::{avif::AvifEncoder, jpeg::JpegEncoder},
    metadata::Orientation,
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat as CodecFormat, ImageReader,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        CompressImageRequest, CompressImageResult, CopyOutputsRequest, ImageFormat,
        ImageInspection, InspectImageRequest,
    },
};

/// Decode an image using its content format and apply EXIF orientation before
/// any metadata is discarded by a later re-encode.
pub(crate) fn decode_image_with_orientation(path: &Path) -> AppResult<DynamicImage> {
    let reader = ImageReader::open(path)
        .map_err(|err| AppError::new("imageOpenFailed", err.to_string()))?
        .with_guessed_format()
        .map_err(|err| AppError::new("imageFormatFailed", err.to_string()))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|err| AppError::new("imageDecodeFailed", err.to_string()))?;
    // Orientation metadata is optional. Some otherwise-decodable images have
    // a truncated or malformed EXIF/TIFF orientation tag, so retain pixels
    // with their stored orientation instead of rejecting the whole image.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|err| AppError::new("imageDecodeFailed", err.to_string()))?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn oriented_dimensions(width: u32, height: u32, orientation: Orientation) -> (u32, u32) {
    match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        _ => (width, height),
    }
}

pub fn inspect_image(request: InspectImageRequest) -> AppResult<ImageInspection> {
    let path = PathBuf::from(&request.path);
    let metadata =
        fs::metadata(&path).map_err(|err| AppError::new("imageReadFailed", err.to_string()))?;
    let reader = image::ImageReader::open(&path)
        .map_err(|err| AppError::new("imageOpenFailed", err.to_string()))?
        .with_guessed_format()
        .map_err(|err| AppError::new("imageFormatFailed", err.to_string()))?;
    let source_format = reader.format().and_then(map_codec_format);
    let mut decoder = reader
        .into_decoder()
        .map_err(|err| AppError::new("imageDimensionFailed", err.to_string()))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let dimensions = decoder.dimensions();
    let (width, height) = oriented_dimensions(dimensions.0, dimensions.1, orientation);

    Ok(ImageInspection {
        path: request.path,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image")
            .to_string(),
        source_format,
        original_bytes: metadata.len(),
        width,
        height,
        estimated_bytes: Some(estimate_bytes(metadata.len(), request.settings.quality)),
        warning: None,
    })
}

pub fn compress_image(request: CompressImageRequest) -> AppResult<CompressImageResult> {
    let source = PathBuf::from(&request.source_path);
    let original_bytes = fs::metadata(&source)
        .map_err(|err| AppError::new("imageReadFailed", err.to_string()))?
        .len();
    let image = decode_image_with_orientation(&source)?;

    // Defensive: reject output_file_name values that could escape output_dir.
    validate_output_file_name(&request.output_file_name)?;

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

fn copy_to_reserved_file(
    source: &mut fs::File,
    destination: &mut fs::File,
    source_permissions: fs::Permissions,
) -> std::io::Result<()> {
    io::copy(source, destination)
        .and_then(|_| destination.set_permissions(source_permissions))
        .and_then(|_| destination.sync_all())
}

pub fn copy_outputs_to_dir(request: CopyOutputsRequest) -> AppResult<Vec<String>> {
    let target = Path::new(&request.target_dir);
    fs::create_dir_all(target).map_err(|err| AppError::new("targetDirFailed", err.to_string()))?;

    let mut copied = Vec::new();

    for src_path in &request.output_paths {
        let file_name = Path::new(src_path)
            .file_name()
            .ok_or_else(|| AppError::new("invalidPath", "Could not extract filename from path"))?;
        let source_permissions = fs::metadata(src_path)
            .map_err(|err| {
                AppError::new(
                    "copyFailed",
                    format!("Failed to copy {}: {}", src_path, err),
                )
            })?
            .permissions();
        let mut source = fs::File::open(src_path).map_err(|err| {
            AppError::new(
                "copyFailed",
                format!("Failed to copy {}: {}", src_path, err),
            )
        })?;
        let (reservation, mut destination) =
            reserve_unique_destination_file(target, &file_name.to_string_lossy()).map_err(
                |err| {
                    AppError::new(
                        "copyFailed",
                        format!("Failed to copy {}: {}", src_path, err),
                    )
                },
            )?;

        let copy_result = copy_to_reserved_file(&mut source, &mut destination, source_permissions);
        if let Err(err) = copy_result {
            // Conditional deletion by path cannot be made race-free: another
            // process could replace this name between any ownership check and
            // unlink. Retain the empty or partial reservation instead.
            drop(destination);
            return Err(AppError::new(
                "copyFailed",
                format!("Failed to copy {}: {}", src_path, err),
            ));
        }
        drop(destination);
        copied.push(reservation.path().to_string_lossy().to_string());
    }

    Ok(copied)
}

pub fn validate_existing_path_under(
    base_dir: &Path,
    candidate: &Path,
    code: &'static str,
) -> AppResult<PathBuf> {
    let base = base_dir
        .canonicalize()
        .map_err(|err| AppError::new(code, err.to_string()))?;
    let candidate = candidate
        .canonicalize()
        .map_err(|err| AppError::new(code, err.to_string()))?;

    if !candidate.starts_with(&base) {
        return Err(AppError::new(
            code,
            "Path is outside the optimizer cache directory.",
        ));
    }

    Ok(candidate)
}

pub fn validate_optimizer_output_dir(cache_dir: &Path, output_dir: &str) -> AppResult<()> {
    let canonical =
        validate_existing_path_under(cache_dir, Path::new(output_dir), "invalidOutputDir")?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "invalidOutputDir",
            "Output path must be a directory in the optimizer cache.",
        ));
    }
    Ok(())
}

pub fn validate_optimizer_output_paths(cache_dir: &Path, output_paths: &[String]) -> AppResult<()> {
    for output_path in output_paths {
        let canonical =
            validate_existing_path_under(cache_dir, Path::new(output_path), "invalidOutputPath")?;
        if !canonical.is_file() {
            return Err(AppError::new(
                "invalidOutputPath",
                "Output path must be a file in the optimizer cache.",
            ));
        }
    }
    Ok(())
}

fn destination_file_name(file_name: &str, sequence: usize) -> String {
    if sequence == 1 {
        return file_name.to_string();
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), Some(e.to_string())),
        _ => (file_name.to_string(), None),
    };

    match ext {
        Some(ext) => format!("{}-{}.{}", stem, sequence, ext),
        None => format!("{}-{}", stem, sequence),
    }
}

/// A unique destination file created by this process.
pub struct ReservedDestination {
    path: PathBuf,
}

impl ReservedDestination {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Atomically reserve a unique destination file in `dir`.
///
/// The returned file is opened with `create_new`, so no other process can
/// create or overwrite the selected path between choosing its suffix and
/// opening it. On a write error callers must leave the reservation in place,
/// because conditional deletion by path is inherently racy.
pub fn reserve_unique_destination_file(
    dir: &Path,
    file_name: &str,
) -> std::io::Result<(ReservedDestination, fs::File)> {
    for sequence in 1.. {
        let path = dir.join(destination_file_name(file_name, sequence));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((ReservedDestination { path }, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
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
        if now.duration_since(modified).unwrap_or_default() > max_age
            && fs::remove_dir_all(entry.path()).is_ok()
        {
            removed += 1;
        }
    }

    removed
}

/// Reject output file names that could escape the output directory via path
/// traversal (`..`), absolute paths, directory separators, or control characters.
fn validate_output_file_name(name: &str) -> AppResult<()> {
    validate_cross_platform_file_name(name, "invalidOutputFileName")
}

/// Validate a file name before using it as a local destination on any
/// supported platform. Callers provide their domain-specific error code.
pub(crate) fn validate_cross_platform_file_name(name: &str, code: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::new(code, "File name must not be empty."));
    }

    // Treat both separator styles as path separators regardless of the host
    // OS. Otherwise a Windows path such as `sub\\photo.webp` is a harmless
    // filename on Unix but escapes the output directory when interpreted on
    // Windows.
    if name.contains('/') || name.contains('\\') {
        return Err(AppError::new(
            code,
            "File name must be a single file name without path separators.",
        ));
    }

    // Windows treats colons as alternate data streams and normalizes trailing
    // dots/spaces. Reject them everywhere so an output name has the same
    // meaning on every supported platform.
    if name.contains(['<', '>', ':', '"', '|', '?', '*'])
        || name.ends_with('.')
        || name.ends_with(' ')
    {
        return Err(AppError::new(
            code,
            "File name must not contain Windows-reserved syntax.",
        ));
    }

    if is_windows_reserved_file_name(name) {
        return Err(AppError::new(
            code,
            "File name must not use a Windows reserved device name.",
        ));
    }

    let path = Path::new(name);
    let mut components = path.components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(AppError::new(
            code,
            "File name must be a single normal file name.",
        ));
    }

    // Reject control characters
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::new(
            code,
            "File name must not contain control characters.",
        ));
    }

    Ok(())
}

fn is_windows_reserved_file_name(name: &str) -> bool {
    let base_name = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();

    matches!(
        base_name.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CLOCK$"
            | "CONIN$"
            | "CONOUT$"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    ) || (base_name.starts_with("COM")
        && base_name.len() == 4
        && matches!(base_name.as_bytes()[3], b'1'..=b'9'))
        || (base_name.starts_with("LPT")
            && base_name.len() == 4
            && matches!(base_name.as_bytes()[3], b'1'..=b'9'))
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

    fn write_orientation_fixture(path: &Path) {
        let image = DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(2, 3, |x, y| {
            image::Rgb([(x * 100) as u8, (y * 70) as u8, 32])
        }));
        image.save(path).unwrap();

        // Insert a minimal little-endian EXIF APP1 segment declaring
        // Orientation 6 (rotate 90 degrees clockwise).
        let exif_payload = [
            b'E', b'x', b'i', b'f', 0, 0, // Exif header
            b'I', b'I', 0x2A, 0, 8, 0, 0, 0, // TIFF header
            1, 0, // one IFD entry
            0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // Orientation = 6
            0, 0, 0, 0, // next IFD offset
        ];
        let segment_length = (exif_payload.len() + 2) as u16;
        let mut segment = vec![
            0xFF,
            0xE1,
            (segment_length >> 8) as u8,
            segment_length as u8,
        ];
        segment.extend_from_slice(&exif_payload);

        let mut bytes = std::fs::read(path).unwrap();
        bytes.splice(2..2, segment);
        std::fs::write(path, bytes).unwrap();
    }

    fn write_fixture_with_unreadable_orientation(path: &Path) {
        // Valid 1×1 uncompressed grayscale TIFF. Its Orientation value points
        // past EOF, while every tag the pixel decoder needs remains valid.
        let tag_count = 10u16;
        let pixel_offset = 8 + 2 + usize::from(tag_count) * 12 + 4;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"II*\0");
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&tag_count.to_le_bytes());
        let mut entry = |tag: u16, kind: u16, count: u32, value: u32| {
            bytes.extend_from_slice(&tag.to_le_bytes());
            bytes.extend_from_slice(&kind.to_le_bytes());
            bytes.extend_from_slice(&count.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        };
        entry(256, 4, 1, 1); // ImageWidth
        entry(257, 4, 1, 1); // ImageLength
        entry(258, 3, 1, 8); // BitsPerSample
        entry(259, 3, 1, 1); // Compression = none
        entry(262, 3, 1, 1); // PhotometricInterpretation = BlackIsZero
        entry(273, 4, 1, pixel_offset as u32); // StripOffsets
        entry(274, 3, 3, pixel_offset as u32); // unreadable Orientation values
        entry(277, 3, 1, 1); // SamplesPerPixel
        entry(278, 4, 1, 1); // RowsPerStrip
        entry(279, 4, 1, 1); // StripByteCounts
        bytes.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        bytes.push(128);
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn decode_applies_exif_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("oriented.jpg");
        write_orientation_fixture(&input);

        let decoded = decode_image_with_orientation(&input).unwrap();
        assert_eq!(decoded.dimensions(), (3, 2));
    }

    #[test]
    fn inspect_and_compress_report_oriented_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("oriented.jpg");
        write_orientation_fixture(&input);

        let inspection = inspect_image(InspectImageRequest {
            path: input.to_string_lossy().to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Jpg,
                quality: 80,
                remove_gps: true,
            },
        })
        .unwrap();
        assert_eq!((inspection.width, inspection.height), (3, 2));

        let result = compress_image(CompressImageRequest {
            source_path: input.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "oriented-output.jpg".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Jpg,
                quality: 80,
                remove_gps: true,
            },
        })
        .unwrap();
        let output_path = PathBuf::from(&result.output_path);
        let output_bytes = std::fs::read(&output_path).unwrap();
        assert!(!output_bytes.windows(4).any(|window| window == b"Exif"));
        let output = image::open(output_path).unwrap();
        assert_eq!(output.dimensions(), (3, 2));
        let output_rgb = output.to_rgb8();
        let top_left = output_rgb.get_pixel(0, 0);
        assert!(
            top_left[1] > 80 && top_left[0] < 80,
            "EXIF rotation should move the lower source row to the output top-left, got {:?}",
            top_left
        );
    }

    #[test]
    fn unreadable_orientation_metadata_does_not_block_decoding_or_inspection() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("bad-orientation.tiff");
        write_fixture_with_unreadable_orientation(&input);

        let decoded = decode_image_with_orientation(&input).unwrap();
        assert_eq!(decoded.dimensions(), (1, 1));

        let inspection = inspect_image(InspectImageRequest {
            path: input.to_string_lossy().to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Jpg,
                quality: 80,
                remove_gps: true,
            },
        })
        .unwrap();
        assert_eq!((inspection.width, inspection.height), (1, 1));
    }

    #[test]
    fn compression_uses_content_format_when_extension_is_wrong() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.png");
        create_test_image(24, 16)
            .save_with_format(&source, CodecFormat::Jpeg)
            .unwrap();

        let result = compress_image(CompressImageRequest {
            source_path: source.to_string_lossy().to_string(),
            output_dir: dir.path().to_string_lossy().to_string(),
            output_file_name: "photo.webp".to_string(),
            settings: CompressionSettings {
                target_format: ImageFormat::Webp,
                quality: 80,
                remove_gps: true,
            },
        })
        .unwrap();

        assert_eq!(
            image::open(result.output_path).unwrap().dimensions(),
            (24, 16)
        );
    }

    #[test]
    fn output_file_name_must_be_a_single_cross_platform_component() {
        assert!(validate_output_file_name("photo.webp").is_ok());
        for invalid in [
            "sub/photo.webp",
            r"sub\photo.webp",
            "../photo.webp",
            "/tmp/photo.webp",
            "photo:hidden.webp",
            "NUL.webp",
            "COM1.jpg",
            "LPT9.png",
            "photo. ",
        ] {
            assert!(
                validate_output_file_name(invalid).is_err(),
                "should reject output path: {invalid}"
            );
        }
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
    fn reserve_unique_destination_file_gives_concurrent_saves_distinct_paths() {
        use std::sync::{Arc, Barrier};

        let dir = tempfile::tempdir().unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();

        for _ in 0..2 {
            let barrier = Arc::clone(&barrier);
            let output_dir = dir.path().to_path_buf();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                let (reservation, _file) =
                    reserve_unique_destination_file(&output_dir, "photo.webp").unwrap();
                reservation.path().to_path_buf()
            }));
        }

        barrier.wait();
        let mut reserved = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        reserved.sort();

        assert_eq!(
            reserved,
            vec![
                dir.path().join("photo-2.webp"),
                dir.path().join("photo.webp"),
            ]
        );
        assert!(reserved.iter().all(|path| path.is_file()));
    }

    #[cfg(unix)]
    #[test]
    fn copy_failure_keeps_its_partial_reservation_instead_of_removing_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        let target_dir = dir.path().join("target");
        std::fs::create_dir_all(source_dir.join("photo.webp")).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();

        let error = copy_outputs_to_dir(CopyOutputsRequest {
            output_paths: vec![source_dir.join("photo.webp").to_string_lossy().to_string()],
            target_dir: target_dir.to_string_lossy().to_string(),
        })
        .unwrap_err();

        assert_eq!(error.code, "copyFailed");
        assert!(
            target_dir.join("photo.webp").is_file(),
            "the reserved partial output must remain rather than risking deletion of a replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_completion_does_not_change_permissions_of_a_replacement_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let source_path = dir.path().join("source.webp");
        std::fs::write(&source_path, b"compressed output").unwrap();
        std::fs::set_permissions(&source_path, std::fs::Permissions::from_mode(0o400)).unwrap();
        let source_permissions = std::fs::metadata(&source_path).unwrap().permissions();
        let mut source = std::fs::File::open(&source_path).unwrap();

        let (reservation, mut destination) =
            reserve_unique_destination_file(dir.path(), "photo.webp").unwrap();
        std::fs::remove_file(reservation.path()).unwrap();
        std::fs::write(reservation.path(), b"other process").unwrap();
        std::fs::set_permissions(reservation.path(), std::fs::Permissions::from_mode(0o600))
            .unwrap();

        copy_to_reserved_file(&mut source, &mut destination, source_permissions).unwrap();

        assert_eq!(std::fs::read(reservation.path()).unwrap(), b"other process");
        assert_eq!(
            std::fs::metadata(reservation.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
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
    fn validates_optimizer_output_dir_under_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("optimizer-cache");
        let run = cache.join("run-1");
        std::fs::create_dir_all(&run).unwrap();

        validate_optimizer_output_dir(&cache, &run.to_string_lossy()).unwrap();
    }

    #[test]
    fn rejects_optimizer_output_dir_outside_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("optimizer-cache");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let err = validate_optimizer_output_dir(&cache, &outside.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, "invalidOutputDir");
    }

    #[test]
    fn rejects_copy_output_path_outside_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("optimizer-cache");
        let run = cache.join("run-1");
        let outside = dir.path().join("secret.txt");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(&outside, b"secret").unwrap();

        let err = validate_optimizer_output_paths(&cache, &[outside.to_string_lossy().to_string()])
            .unwrap_err();
        assert_eq!(err.code, "invalidOutputPath");
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
