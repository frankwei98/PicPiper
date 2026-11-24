package imaging

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
)

const largeImageBytes = 192 << 20

func needsLargeImageSlot(operation string, req request, probeModern func(string) bool) bool {
	path, edge, outputBytesPerPixel := req.Path, 0, int64(8)
	switch operation {
	case "compress_image":
		path, edge = req.SourcePath, req.Settings.MaxDimension
	case "read_thumbnail":
		edge, outputBytesPerPixel = thumbnailEdge(req.MaxSize), 4
	case "read_original_preview":
		edge = thumbnailEdge(req.MaxSize)
	case "read_comparison_image":
		edge = min(req.MaxSize, 1280)
	case "copy_image_png":
	default:
		return false
	}

	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		// The worker will reject these paths before it decodes pixels.
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()

	// Use only bounded, pure Go header readers in the desktop process.
	// Let an isolated worker inspect formats that may invoke a bundled codec.
	header := bufio.NewReader(io.LimitReader(file, 256<<10))
	magic, _ := header.Peek(30)
	var config image.Config
	var hdr, animatedPNG, webp bool
	switch {
	case len(magic) >= 8 && string(magic[:8]) == "\x89PNG\r\n\x1a\n":
		config, err = png.DecodeConfig(header)
		var complete bool
		hdr, animatedPNG, complete = pngMemoryProperties(file, info.Size())
		if !complete {
			return true
		}
	case len(magic) >= 3 && string(magic[:3]) == "\xff\xd8\xff":
		config, err = jpeg.DecodeConfig(header)
	case len(magic) == 30 && string(magic[:4]) == "RIFF" && string(magic[8:12]) == "WEBP":
		webp = true
		// Preserving an animation retains every decoded frame and the encoder's
		// packed copy. The VP8X canvas size alone cannot bound those buffers.
		const animationFlag = 0x02
		if operation == "compress_image" && req.Settings.TargetFormat == "webp" && req.Settings.AnimationMode != "firstFrame" &&
			string(magic[12:16]) == "VP8X" && magic[20]&animationFlag != 0 {
			return true
		}
		config.Width, config.Height = webpHeaderSize(magic)
		if config.Width == 0 || config.Height == 0 {
			return true
		}
	default:
		if probeModern != nil && (bytes.HasPrefix(magic, []byte{0xff, 0x0a}) || bytes.HasPrefix(magic, jxlContainerSignature) || len(magic) >= 8 && string(magic[4:8]) == "ftyp") {
			return probeModern(path)
		}
		return true
	}
	if err != nil {
		return true
	}
	width, height := int64(config.Width), int64(config.Height)
	if !validDimensions(config.Width, config.Height) {
		return false
	}
	sourcePixels := width * height
	outputPixels := sourcePixels
	if longest := max(width, height); edge > 0 && int64(edge) < longest {
		// Round up to cover both the export and the thumbnail rounding rules.
		outputWidth := (width*int64(edge) + longest - 1) / longest
		outputHeight := (height*int64(edge) + longest - 1) / longest
		outputPixels = outputWidth * outputHeight
	}
	// A decode may normalize colors or orientation to a 16-bit pixel buffer.
	peakBytes := 8*sourcePixels + outputBytesPerPixel*outputPixels
	if hdr || config.ColorModel == color.Gray16Model || config.ColorModel == color.RGBA64Model || config.ColorModel == color.NRGBA64Model {
		// HDR can create 16-bit pixels from an 8-bit source. Color conversion
		// and orientation can overlap full-sized decode and conversion buffers.
		peakBytes = max(peakBytes, 3*8*sourcePixels)
	}
	if animatedPNG {
		// First-frame extraction holds the decoded frame, its canvas, and
		// compressed bytes while rebuilding the frame's PNG stream.
		peakBytes = max(peakBytes, 16*sourcePixels+4*info.Size())
	}
	if webp {
		// The decoder reads the entire file and copies the encoded data into
		// its module, even when the caller only needs the first frame.
		peakBytes += 3 * info.Size()
	}
	return peakBytes >= largeImageBytes
}

// Modern header readers can enter bundled codecs. Probe in an isolated
// worker, then return that worker before waiting for a large-image slot.
func (s *Service) largeModernImage(ctx context.Context, path string) bool {
	if err := s.workers.acquire(ctx); err != nil {
		return true
	}
	defer s.workers.release()
	if ctx.Err() != nil {
		return true
	}
	value, err := s.isolated(ctx, "inspect_image", request{Path: path})
	if err != nil {
		return true
	}
	inspection, ok := value.(map[string]any)
	if !ok {
		return true
	}
	// AVIF inspection can report the primary item's dimensions while the
	// bundled decoder selects the movie track. Keep animated inputs bounded
	// even when both declared sizes are within the per-image limit.
	if inspection["sourceFormat"] == "avif" && inspection["animated"] == true {
		return true
	}
	width, _ := inspection["width"].(float64)
	height, _ := inspection["height"].(float64)
	encodedBytes, _ := inspection["originalBytes"].(float64)
	// Allow two conversion buffers and encoded data copied by the decoder,
	// without reserving a large slot for even the smallest modern inputs.
	return width < 1 || height < 1 || encodedBytes < 1 || 24*width*height+3*encodedBytes >= largeImageBytes
}

// Inspect chunk headers without loading IDAT or decompressing ICC profiles.
// If there are too many chunks to classify cheaply, take a large slot.
func pngMemoryProperties(file io.ReaderAt, size int64) (hdr, animated, complete bool) {
	var header [8]byte
	position := int64(8)
	for range 4096 {
		if size-position < 12 {
			break
		}
		if _, err := file.ReadAt(header[:], position); err != nil {
			break
		}
		length := int64(binary.BigEndian.Uint32(header[:4]))
		if length > size-position-12 {
			break
		}
		switch string(header[4:]) {
		case "cICP":
			var data [4]byte
			if length == 4 {
				if _, err := file.ReadAt(data[:], position+8); err != nil {
					return hdr, animated, false
				}
				hdr = hdr || data[1] == 16 || data[1] == 18
			}
		case "acTL":
			animated = animated || length == 8
		case "IEND":
			return hdr, animated, true
		}
		position += length + 12
	}
	return hdr, animated, false
}

// These are the three first-chunk layouts that carry the WebP canvas size.
// An unrecognized layout takes a large slot and is checked by the worker.
func webpHeaderSize(header []byte) (width, height int) {
	switch string(header[12:16]) {
	case "VP8X":
		width = 1 + int(binary.LittleEndian.Uint32(header[23:27])>>8)
		height = 1 + int(binary.LittleEndian.Uint32(header[26:30])>>8)
	case "VP8L":
		if header[20] == 0x2f {
			size := binary.LittleEndian.Uint32(header[21:25])
			width, height = 1+int(size&0x3fff), 1+int(size>>14&0x3fff)
		}
	case "VP8 ":
		if string(header[23:26]) == "\x9d\x01\x2a" {
			width = int(binary.LittleEndian.Uint16(header[26:28]) & 0x3fff)
			height = int(binary.LittleEndian.Uint16(header[28:30]) & 0x3fff)
		}
	}
	return width, height
}
