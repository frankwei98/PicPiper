package imaging

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"image"
	"io"
	"os"
	"sync"

	"github.com/gen2brain/avif"
	_ "github.com/gen2brain/heic"
	"github.com/gen2brain/jpegxl"
	"github.com/gen2brain/webp"
)

// The bundled WASM codecs share unsynchronized runtime initialization state.
// Serialize their entry points; native encoders and JPEG/PNG/WebP stay parallel.
var codecMu sync.Mutex

func decodeConfig(reader io.Reader) (image.Config, string, error) {
	buffered := bufio.NewReader(reader)
	header, _ := buffered.Peek(12)
	webpHeader := len(header) >= 12 && string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP"
	if !webpHeader && !bytes.HasPrefix(header, []byte{0xff, 0xd8, 0xff}) && !bytes.HasPrefix(header, []byte("\x89PNG\r\n\x1a\n")) {
		codecMu.Lock()
		defer codecMu.Unlock()
	}
	return image.DecodeConfig(buffered)
}

func readableFormat(format string) bool {
	switch format {
	case "jpeg", "png", "webp", "avif", "jxl", "heic":
		return true
	}
	return false
}

func writableFormat(format string) bool {
	switch format {
	case "jpg", "png", "webp", "avif", "jxl":
		return true
	}
	return false
}

func decodePixels(reader io.Reader, format string) (image.Image, error) {
	if format != "jpeg" && format != "png" && format != "webp" {
		codecMu.Lock()
		defer codecMu.Unlock()
	}
	if format == "avif" {
		// AVIF rotation/mirroring lives in container properties rather than EXIF.
		return avif.Decode(reader, avif.Options{AutoRotate: true})
	}
	img, _, err := image.Decode(reader)
	return img, err
}

func decodeWebPAnimation(ctx context.Context, path string, metadata sourceProperties, info Inspection, limit int) (*webp.WEBP, error) {
	if metadata.frames > 120 || int64(metadata.frames)*int64(info.Width)*int64(info.Height) > maxPixels {
		return nil, fmt.Errorf("animation exceeds 120 frames or 40 million total frame pixels")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 256<<20 {
		return nil, fmt.Errorf("animation is not a regular file within the size limit")
	}
	cfg, format, err := decodeConfig(file)
	actual := properties(file)
	if err != nil || format != "webp" || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxPixels || cfg.Height > maxPixels || actual.frames != metadata.frames || int64(actual.frames)*int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return nil, fmt.Errorf("animation changed or exceeds the pixel limit")
	}
	if err := validateColorProperties(actual); err != nil {
		return nil, err
	}
	metadata = actual
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	animation, err := webp.DecodeAll(file)
	if err != nil {
		return nil, err
	}
	if len(animation.Image) != metadata.frames {
		return nil, fmt.Errorf("animation frame count is inconsistent")
	}
	// The bundled decoder does not populate LoopCount; read the ANIM chunk.
	animation.LoopCount = metadata.loopCount
	rotation := orientationFromFile(file)
	for i, frame := range animation.Image {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(metadata.profile) > 0 {
			frame, err = normalizeProfile(frame, metadata.profile)
			if err != nil {
				return nil, err
			}
		}
		frame = applyOrientation(frame, rotation)
		if longest := max(frame.Bounds().Dx(), frame.Bounds().Dy()); limit > 0 && longest > limit {
			width := max(1, int((int64(frame.Bounds().Dx())*int64(limit)+int64(longest)/2)/int64(longest)))
			height := max(1, int((int64(frame.Bounds().Dy())*int64(limit)+int64(longest)/2)/int64(longest)))
			frame = resizePreservingDepth(frame, width, height)
		}
		animation.Image[i] = frame
	}
	return animation, nil
}

func encodeAnimation(writer io.Writer, animation *webp.WEBP, format string, quality int) error {
	if format != "webp" {
		return fmt.Errorf("choose WebP to preserve animation")
	}
	return webp.EncodeAll(writer, animation, webp.Options{Quality: quality, Method: 4, Exact: true, Lossless: quality == 100})
}

func encodeModern(writer io.Writer, img image.Image, format string, quality int) error {
	if format == "webp" {
		return encodeWebP(writer, img, quality)
	}
	if format == "avif" {
		return encodeAVIF(writer, img, quality)
	}
	codecMu.Lock()
	defer codecMu.Unlock()
	switch format {
	case "jxl":
		return jpegxl.Encode(writer, img, jpegxl.Options{Quality: quality, Effort: 3, Lossless: quality == 100})
	default:
		return fmt.Errorf("unsupported output format: %s", format)
	}
}
