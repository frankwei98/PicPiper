package imaging

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/draw"
	"io"
	"os"
)

// orientation reads only bounded metadata. Broken EXIF must not reject otherwise
// readable pixels, and an image without a usable tag is stored normally.
func orientation(path string) int {
	file, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer file.Close()
	return orientationFromFile(file)
}

func orientationFromFile(file *os.File) int {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return 1
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 1
	}
	skip := func(length int64) bool {
		position, err := file.Seek(length, io.SeekCurrent)
		return err == nil && position <= info.Size()
	}
	var magic [8]byte
	if _, err := io.ReadFull(file, magic[:]); err != nil {
		return 1
	}
	if magic[0] == 0xff && magic[1] == 0xd8 {
		_, _ = file.Seek(2, io.SeekStart)
		reader := file
		for {
			var marker [2]byte
			if _, err := io.ReadFull(reader, marker[:]); err != nil || marker[0] != 0xff {
				return 1
			}
			for marker[1] == 0xff {
				if _, err := io.ReadFull(reader, marker[1:]); err != nil {
					return 1
				}
			}
			if marker[1] == 0xda || marker[1] == 0xd9 {
				return 1
			}
			if marker[1] == 0x01 || marker[1] >= 0xd0 && marker[1] <= 0xd7 {
				continue
			}
			var size [2]byte
			if _, err := io.ReadFull(reader, size[:]); err != nil {
				return 1
			}
			length := int(binary.BigEndian.Uint16(size[:])) - 2
			if length < 0 {
				return 1
			}
			if marker[1] != 0xe1 {
				if !skip(int64(length)) {
					return 1
				}
				continue
			}
			segment := make([]byte, length)
			if _, err := io.ReadFull(reader, segment); err != nil {
				return 1
			}
			if marker[1] == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
				return tiffOrientation(segment[6:])
			}
		}
	}
	if string(magic[:4]) == "RIFF" {
		var kind [4]byte
		if _, err := io.ReadFull(file, kind[:]); err != nil || string(kind[:]) != "WEBP" {
			return 1
		}
		reader := file
		for {
			var header [8]byte
			if _, err := io.ReadFull(reader, header[:]); err != nil {
				return 1
			}
			length := binary.LittleEndian.Uint32(header[4:])
			if string(header[:4]) == "EXIF" {
				if length > 2<<20 {
					return 1
				}
				data := make([]byte, length)
				if _, err := io.ReadFull(reader, data); err != nil {
					return 1
				}
				return tiffOrientation(bytes.TrimPrefix(data, []byte("Exif\x00\x00")))
			}
			if !skip(int64(length) + int64(length%2)) {
				return 1
			}
		}
	}
	if magic != [8]byte{137, 'P', 'N', 'G', 13, 10, 26, 10} {
		return 1
	}
	reader := file
	for {
		var header [8]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return 1
		}
		length := binary.BigEndian.Uint32(header[:4])
		kind := string(header[4:])
		if kind == "IEND" {
			return 1
		}
		if kind == "eXIf" {
			if length > 2<<20 {
				return 1
			}
			data := make([]byte, length)
			if _, err := io.ReadFull(reader, data); err != nil {
				return 1
			}
			return tiffOrientation(data)
		}
		if !skip(int64(length) + 4) {
			return 1
		}
	}
}

func tiffOrientation(data []byte) int {
	if len(data) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(data[2:4]) != 42 {
		return 1
	}
	offset := uint64(order.Uint32(data[4:8]))
	if offset+2 > uint64(len(data)) {
		return 1
	}
	entries := int(order.Uint16(data[offset : offset+2]))
	for i := 0; i < entries; i++ {
		position := offset + 2 + uint64(i)*12
		if position+12 > uint64(len(data)) {
			return 1
		}
		entry := data[position : position+12]
		if order.Uint16(entry[:2]) == 0x0112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			value := int(order.Uint16(entry[8:10]))
			if value >= 1 && value <= 8 {
				return value
			}
		}
	}
	return 1
}

func applyOrientation(src image.Image, orientation int) image.Image {
	if orientation <= 1 || orientation > 8 {
		return src
	}
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	outWidth, outHeight := width, height
	if orientation >= 5 {
		outWidth, outHeight = height, width
	}
	orientedBounds := image.Rect(0, 0, outWidth, outHeight)
	var dst draw.Image
	if highBitDepth(src) {
		dst = image.NewNRGBA64(orientedBounds)
	} else {
		dst = image.NewNRGBA(orientedBounds)
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			dx, dy := x, y
			switch orientation {
			case 2:
				dx = width - 1 - x
			case 3:
				dx, dy = width-1-x, height-1-y
			case 4:
				dy = height - 1 - y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = height-1-y, x
			case 7:
				dx, dy = height-1-y, width-1-x
			case 8:
				dx, dy = y, width-1-x
			}
			dst.Set(dx, dy, src.At(bounds.Min.X+x, bounds.Min.Y+y))
		}
	}
	return dst
}
