package imaging

import (
	"bufio"
	"encoding/binary"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
)

const largeImageBytes = 192 << 20

func needsLargeImageSlot(operation string, req request) bool {
	path, edge, outputBytesPerPixel := req.Path, 0, int64(8)
	switch operation {
	case "compress_image":
		path, edge = req.SourcePath, req.Settings.MaxDimension
	case "read_thumbnail":
		edge, outputBytesPerPixel = thumbnailEdge(req.MaxSize), 4
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
	switch {
	case len(magic) >= 8 && string(magic[:8]) == "\x89PNG\r\n\x1a\n":
		config, err = png.DecodeConfig(header)
	case len(magic) >= 3 && string(magic[:3]) == "\xff\xd8\xff":
		config, err = jpeg.DecodeConfig(header)
	case len(magic) == 30 && string(magic[:4]) == "RIFF" && string(magic[8:12]) == "WEBP":
		config.Width, config.Height = webpHeaderSize(magic)
		if config.Width == 0 || config.Height == 0 {
			return true
		}
	default:
		return true
	}
	if err != nil {
		return true
	}
	width, height := int64(config.Width), int64(config.Height)
	if min(width, height) < 1 || max(width, height) > maxPixels || width*height > maxPixels {
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
	return 8*sourcePixels+outputBytesPerPixel*outputPixels >= largeImageBytes
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
