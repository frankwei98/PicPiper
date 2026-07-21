use crate::{
    error::{AppError, AppResult},
    models::{ReadThumbnailRequest, ReadThumbnailResponse},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use image::codecs::jpeg::JpegEncoder;
use std::path::PathBuf;

/// Convert premultiplied RGBA to straight (non-premultiplied) RGBA.
///
/// CoreGraphics renders with `kCGImageAlphaPremultipliedLast`, meaning each
/// color channel has been multiplied by alpha/255. The PNG encoder expects
/// straight alpha, so we divide each color channel back by alpha.
fn unpremultiply(premultiplied: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(premultiplied.len());
    for chunk in premultiplied.chunks_exact(4) {
        let r = chunk[0] as u16;
        let g = chunk[1] as u16;
        let b = chunk[2] as u16;
        let a = chunk[3];
        if a == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            let a16 = a as u16;
            // Round-trip: premultiplied = floor(straight * alpha / 255)
            // Inverse:  straight ≈ premultiplied * 255 / alpha  (rounded)
            out.push(((r * 255 + a16 / 2) / a16).min(255) as u8);
            out.push(((g * 255 + a16 / 2) / a16).min(255) as u8);
            out.push(((b * 255 + a16 / 2) / a16).min(255) as u8);
            out.push(a);
        }
    }
    out
}

/// Encode RGBA thumbnail bytes as a data URL. If any alpha byte is less than
/// 255, the image is encoded as PNG to preserve transparency. Otherwise it is
/// encoded as JPEG for smaller output.
fn encode_thumbnail_data_url(width: u32, height: u32, rgba: &[u8]) -> AppResult<String> {
    let has_alpha = rgba.chunks_exact(4).any(|px| px[3] < 255);

    if has_alpha {
        let img = image::DynamicImage::ImageRgba8(
            image::ImageBuffer::from_raw(width, height, rgba.to_vec()).ok_or_else(|| {
                AppError::new("thumbnailEncodeFailed", "RGBA buffer size mismatch")
            })?,
        );
        let mut png_buf = Vec::new();
        let cursor = std::io::Cursor::new(&mut png_buf);
        img.write_to(cursor, image::ImageFormat::Png)
            .map_err(|err| AppError::new("thumbnailEncodeFailed", err.to_string()))?;
        let encoded = BASE64_STANDARD.encode(&png_buf);
        Ok(format!("data:image/png;base64,{}", encoded))
    } else {
        let rgb: Vec<u8> = rgba
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect();
        let mut jpeg_buf = Vec::new();
        let cursor = std::io::Cursor::new(&mut jpeg_buf);
        let mut encoder = JpegEncoder::new_with_quality(cursor, 75);
        encoder
            .encode_image(&image::DynamicImage::ImageRgb8(
                image::ImageBuffer::from_raw(width, height, rgb).ok_or_else(|| {
                    AppError::new("thumbnailEncodeFailed", "RGB buffer size mismatch")
                })?,
            ))
            .map_err(|err| AppError::new("thumbnailEncodeFailed", err.to_string()))?;
        let encoded = BASE64_STANDARD.encode(&jpeg_buf);
        Ok(format!("data:image/jpeg;base64,{}", encoded))
    }
}

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
        // CGContext with kCGImageAlphaPremultipliedLast produces premultiplied
        // RGBA. The PNG encoder expects straight (non-premultiplied) alpha, so
        // we must undo the premultiplication before encoding.
        let rgba = unpremultiply(data);

        let data_url = encode_thumbnail_data_url(width as u32, height as u32, &rgba)?;

        Ok(ReadThumbnailResponse { data_url })
    }
}

// ---------------------------------------------------------------------------
// CPU fallback (works on all platforms)
// ---------------------------------------------------------------------------

fn read_thumbnail_cpu(path: &str, max_size: u32) -> AppResult<ReadThumbnailResponse> {
    let path = PathBuf::from(path);

    let img = crate::optimizer::decode_image_with_orientation(&path)?;

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
    use image::GenericImageView;

    fn create_test_jpeg(path: &std::path::Path) {
        let img = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(64, 64, |x, y| {
            image::Rgb([x as u8, y as u8, 128])
        }));
        img.save(path).unwrap();
    }

    fn write_orientation_fixture(path: &std::path::Path) {
        let image = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(2, 3, |x, y| {
            image::Rgb([(x * 100) as u8, (y * 70) as u8, 32])
        }));
        image.save(path).unwrap();
        let exif_payload = [
            b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 0x2A, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0,
            1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
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

    #[test]
    fn encode_thumbnail_data_url_opaque_is_jpeg() {
        // 2x2 fully opaque RGBA pixels
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        ];
        let data_url = encode_thumbnail_data_url(2, 2, &rgba).unwrap();
        assert!(
            data_url.starts_with("data:image/jpeg;base64,"),
            "opaque pixels should produce JPEG, got: {}",
            &data_url[..30]
        );
    }

    #[test]
    fn encode_thumbnail_data_url_alpha_is_png() {
        // 2x2 RGBA pixels with one semi-transparent pixel
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 0, 255,
        ];
        let data_url = encode_thumbnail_data_url(2, 2, &rgba).unwrap();
        assert!(
            data_url.starts_with("data:image/png;base64,"),
            "alpha pixels should produce PNG, got: {}",
            &data_url[..29]
        );
    }

    #[test]
    fn encode_thumbnail_data_url_fully_transparent_is_png() {
        // 1x1 fully transparent pixel
        let rgba = vec![0, 0, 0, 0];
        let data_url = encode_thumbnail_data_url(1, 1, &rgba).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
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
    fn cpu_thumbnail_applies_exif_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("oriented.jpg");
        write_orientation_fixture(&input);

        let resp = read_thumbnail_cpu(&input.to_string_lossy(), 3).unwrap();
        let encoded = resp
            .data_url
            .split_once(",")
            .map(|(_, value)| value)
            .unwrap();
        let bytes = BASE64_STANDARD.decode(encoded).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.dimensions(), (3, 2));
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
