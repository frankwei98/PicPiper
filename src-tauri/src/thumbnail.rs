use crate::{
    error::{AppError, AppResult},
    models::{ReadThumbnailRequest, ReadThumbnailResponse},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use image::codecs::jpeg::JpegEncoder;
use std::path::PathBuf;

pub fn read_thumbnail(request: ReadThumbnailRequest) -> AppResult<ReadThumbnailResponse> {
    let max_size = request.max_size.unwrap_or(256).clamp(16, 1024);

    #[cfg(target_os = "macos")]
    {
        if let Ok(resp) = read_thumbnail_macos(&request.path, max_size) {
            return Ok(resp);
        }
        // macOS native path failed (e.g. unsupported format, corrupt file) — fall through to CPU.
    }

    read_thumbnail_cpu(&request.path, max_size)
}

// ---------------------------------------------------------------------------
// macOS: hardware-accelerated decode + resize via ImageIO (CGImageSource)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn read_thumbnail_macos(path: &str, max_size: u32) -> AppResult<ReadThumbnailResponse> {
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_foundation::url::{kCFURLPOSIXPathStyle, CFURL};
    use core_graphics::color_space::CGColorSpace;
    use core_graphics::context::CGContext;
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::image::CGImage;
    use foreign_types_shared::ForeignType;

    // ImageIO C functions — not exposed by the core-graphics crate.
    extern "C" {
        fn CGImageSourceCreateWithURL(
            url: *const core_foundation::base::CFTypeRef,
            options: *const core_foundation::base::CFTypeRef,
        ) -> *mut core_foundation::base::CFTypeRef;

        fn CGImageSourceCreateThumbnailAtIndex(
            isrc: *mut core_foundation::base::CFTypeRef,
            index: usize,
            options: *const core_foundation::base::CFTypeRef,
        ) -> *mut core_foundation::base::CFTypeRef;
    }

    // Option key constants (CFString values defined by ImageIO).
    let key_create_thumb = CFString::new("kCGImageSourceCreateThumbnailFromImageAlways");
    let key_max_size = CFString::new("kCGImageSourceThumbnailMaxPixelSize");
    let key_transform = CFString::new("kCGImageSourceCreateThumbnailWithTransform");

    unsafe {
        // Build file URL.
        let cf_path = CFString::new(path);
        let url = CFURL::from_file_system_path(cf_path, kCFURLPOSIXPathStyle, false);
        let url_ref: *const core_foundation::base::CFTypeRef =
            url.as_concrete_TypeRef() as *const _;

        // Create image source from URL.
        let source = CGImageSourceCreateWithURL(url_ref, std::ptr::null());
        if source.is_null() {
            return Err(AppError::new(
                "thumbnailDecodeFailed",
                "CGImageSourceCreateWithURL returned null",
            ));
        }

        // Build thumbnail options dictionary.
        let options_dict = CFDictionary::from_CFType_pairs(&[
            (
                key_create_thumb.as_CFType(),
                CFNumber::from(1i32).as_CFType(),
            ),
            (
                key_max_size.as_CFType(),
                CFNumber::from(max_size as i64).as_CFType(),
            ),
            (key_transform.as_CFType(), CFNumber::from(1i32).as_CFType()),
        ]);
        let options_ref: *const core_foundation::base::CFTypeRef =
            options_dict.as_concrete_TypeRef() as *const _;

        // Create thumbnail.
        let cg_thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options_ref);
        CFRelease(source as *const _);

        if cg_thumb.is_null() {
            return Err(AppError::new(
                "thumbnailDecodeFailed",
                "CGImageSourceCreateThumbnailAtIndex returned null",
            ));
        }

        // Wrap the raw pointer so we can draw it into a CGContext and read RGBA.
        let thumb_image = CGImage::from_ptr(cg_thumb as *mut core_graphics::sys::CGImage);
        let width = thumb_image.width();
        let height = thumb_image.height();

        // Render into an RGBA bitmap context so we get a predictable pixel layout.
        let mut ctx = CGContext::create_bitmap_context(
            None,
            width,
            height,
            8,
            width * 4,
            &CGColorSpace::create_device_rgb(),
            core_graphics::base::kCGImageAlphaPremultipliedLast,
        );
        ctx.draw_image(
            CGRect::new(
                &CGPoint::new(0.0, 0.0),
                &CGSize::new(width as f64, height as f64),
            ),
            &thumb_image,
        );

        let data = ctx.data();
        let rgba: Vec<u8> = data.to_vec();

        // Convert RGBA → RGB (drop alpha) and encode as JPEG.
        let rgb: Vec<u8> = rgba
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect();

        let mut jpeg_buf = Vec::new();
        let cursor = std::io::Cursor::new(&mut jpeg_buf);
        let mut encoder = JpegEncoder::new_with_quality(cursor, 75);
        encoder
            .encode_image(&image::DynamicImage::ImageRgb8(
                image::ImageBuffer::from_raw(width as u32, height as u32, rgb).ok_or_else(
                    || AppError::new("thumbnailEncodeFailed", "RGBA buffer size mismatch"),
                )?,
            ))
            .map_err(|err| AppError::new("thumbnailEncodeFailed", err.to_string()))?;

        let encoded = BASE64_STANDARD.encode(&jpeg_buf);
        let data_url = format!("data:image/jpeg;base64,{}", encoded);

        Ok(ReadThumbnailResponse { data_url })
    }
}

// ---------------------------------------------------------------------------
// CPU fallback (works on all platforms)
// ---------------------------------------------------------------------------

fn read_thumbnail_cpu(path: &str, max_size: u32) -> AppResult<ReadThumbnailResponse> {
    let path = PathBuf::from(path);

    let reader = image::ImageReader::open(&path)
        .map_err(|err| AppError::new("imageOpenFailed", err.to_string()))?
        .with_guessed_format()
        .map_err(|err| AppError::new("imageFormatFailed", err.to_string()))?;

    let img = reader
        .decode()
        .map_err(|err| AppError::new("imageDecodeFailed", err.to_string()))?;

    // Triangle filter is ~3x faster than Lanczos3; quality is fine at thumbnail size.
    let thumb = img.resize(max_size, max_size, image::imageops::FilterType::Triangle);

    let has_alpha = thumb.color().has_alpha();
    let (bytes, mime) = if has_alpha {
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?;
        (buf.into_inner(), "image/png")
    } else {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut encoder = JpegEncoder::new_with_quality(&mut buf, 75);
        encoder
            .encode_image(&thumb)
            .map_err(|err| AppError::new("imageEncodeFailed", err.to_string()))?;
        (buf.into_inner(), "image/jpeg")
    };

    let encoded = BASE64_STANDARD.encode(&bytes);
    let data_url = format!("data:{};base64,{}", mime, encoded);

    Ok(ReadThumbnailResponse { data_url })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_jpeg(path: &std::path::Path) {
        let img = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(64, 64, |x, y| {
            image::Rgb([x as u8, y as u8, 128])
        }));
        img.save(path).unwrap();
    }

    #[test]
    fn cpu_thumbnail_returns_data_url() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("test.jpg");
        create_test_jpeg(&input);

        let resp = read_thumbnail_cpu(&input.to_string_lossy(), 32).unwrap();
        assert!(resp.data_url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn read_thumbnail_dispatches_to_cpu_on_nonexistent_file() {
        let result = read_thumbnail(ReadThumbnailRequest {
            path: "/nonexistent/file.jpg".to_string(),
            max_size: Some(64),
        });
        // Should fail (not panic) — file doesn't exist.
        assert!(result.is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_thumbnail_returns_data_url_for_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("test.jpg");
        create_test_jpeg(&input);

        let resp = read_thumbnail_macos(&input.to_string_lossy(), 32).unwrap();
        assert!(resp.data_url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires a real HEIC file — run manually with a test asset"]
    fn macos_thumbnail_handles_heic() {
        let resp =
            read_thumbnail_macos("/path/to/test.heic", 256).expect("macOS should decode HEIC");
        assert!(resp.data_url.starts_with("data:image/jpeg;base64,"));
    }
}
