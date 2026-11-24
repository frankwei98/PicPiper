package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/draw"
	"image/png"
	"io"
	"os"
)

// APNG can carry a separate default poster image. Extract the first animation
// frame explicitly so a requested first-frame export never returns that poster.
func decodeAPNGFirst(ctx context.Context, file *os.File, canvas image.Config) (image.Image, error) {
	if _, err := file.Seek(8, io.SeekStart); err != nil {
		return nil, err
	}
	var header, palette, transparency []byte
	var frame bytes.Buffer
	var rect image.Rectangle
	found, payload := false, false
	chunk := func(kind string, data []byte) {
		_ = binary.Write(&frame, binary.BigEndian, uint32(len(data)))
		frame.WriteString(kind)
		frame.Write(data)
		checksum := crc32.NewIEEE()
		_, _ = checksum.Write([]byte(kind))
		_, _ = checksum.Write(data)
		_ = binary.Write(&frame, binary.BigEndian, checksum.Sum32())
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var prefix [8]byte
		if _, err := io.ReadFull(file, prefix[:]); err != nil {
			return nil, err
		}
		size := binary.BigEndian.Uint32(prefix[:4])
		if size > 256<<20 {
			return nil, fmt.Errorf("APNG chunk exceeds input limit")
		}
		kind := string(prefix[4:])
		if kind == "IEND" || kind == "fcTL" && found {
			break
		}
		read := kind == "IHDR" || kind == "PLTE" || kind == "tRNS" || kind == "fcTL" || found && (kind == "IDAT" || kind == "fdAT")
		if !read {
			if _, err := file.Seek(int64(size)+4, io.SeekCurrent); err != nil {
				return nil, err
			}
			continue
		}
		data := make([]byte, int(size))
		if _, err := io.ReadFull(file, data); err != nil {
			return nil, err
		}
		if _, err := file.Seek(4, io.SeekCurrent); err != nil {
			return nil, err
		}
		switch kind {
		case "IHDR":
			// A repeated header would replace the frame size checked against the canvas.
			if len(data) != 13 || header != nil {
				return nil, fmt.Errorf("invalid APNG header")
			}
			header = data
		case "PLTE":
			palette = data
		case "tRNS":
			transparency = data
		case "fcTL":
			if len(data) != 26 || len(header) != 13 {
				return nil, fmt.Errorf("invalid APNG frame control")
			}
			width, height := uint64(binary.BigEndian.Uint32(data[4:8])), uint64(binary.BigEndian.Uint32(data[8:12]))
			x, y := uint64(binary.BigEndian.Uint32(data[12:16])), uint64(binary.BigEndian.Uint32(data[16:20]))
			if width == 0 || height == 0 || x+width > uint64(canvas.Width) || y+height > uint64(canvas.Height) {
				return nil, fmt.Errorf("APNG frame exceeds canvas")
			}
			rect = image.Rect(int(x), int(y), int(x+width), int(y+height))
			binary.BigEndian.PutUint32(header[:4], uint32(width))
			binary.BigEndian.PutUint32(header[4:8], uint32(height))
			found = true
		case "IDAT", "fdAT":
			if !payload {
				// PLTE/tRNS may legally follow the first fcTL.
				frame.WriteString("\x89PNG\r\n\x1a\n")
				chunk("IHDR", header)
				if palette != nil {
					chunk("PLTE", palette)
				}
				if transparency != nil {
					chunk("tRNS", transparency)
				}
			}
			if kind == "fdAT" {
				if len(data) < 4 {
					return nil, fmt.Errorf("invalid APNG frame payload")
				}
				data = data[4:]
			}
			chunk("IDAT", data)
			payload = true
		}
	}
	if !found || !payload {
		return nil, fmt.Errorf("APNG first frame is missing")
	}
	chunk("IEND", nil)
	decoded, err := png.Decode(&frame)
	if err != nil {
		return nil, err
	}
	bounds := image.Rect(0, 0, canvas.Width, canvas.Height)
	if rect == bounds {
		return decoded, nil
	}
	var output draw.Image
	if highBitDepth(decoded) {
		output = image.NewNRGBA64(bounds)
	} else {
		output = image.NewNRGBA(bounds)
	}
	draw.Draw(output, rect, decoded, decoded.Bounds().Min, draw.Src)
	return output, nil
}
