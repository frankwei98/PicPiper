package imaging

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"io"
	"os"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type sourceProperties struct {
	frames         int
	loopCount      int
	bitDepth       int
	profile        []byte
	profilePresent bool
	hdr            bool
	hdrPrimaries   uint16
	hdrTransfer    uint16
	invalidCICP    bool
	sequence       bool
}

// Scan container metadata by seeking over image payloads. Profile decompression
// is bounded independently of file size; unreadable profiles remain flagged.
func properties(file *os.File) sourceProperties {
	result := sourceProperties{frames: 1, bitDepth: 8}
	_, _ = file.Seek(0, io.SeekStart)
	var magic [12]byte
	if _, err := io.ReadFull(file, magic[:]); err != nil {
		return result
	}
	info, err := file.Stat()
	if err != nil {
		return result
	}
	read := func(size uint32) []byte {
		if size > 4<<20 {
			return nil
		}
		data := make([]byte, size)
		if _, err := io.ReadFull(file, data); err != nil {
			return nil
		}
		return data
	}
	if bytes.Equal(magic[:8], []byte("\x89PNG\r\n\x1a\n")) {
		_, _ = file.Seek(8, io.SeekStart)
		for {
			var header [8]byte
			if _, err := io.ReadFull(file, header[:]); err != nil {
				break
			}
			size := binary.BigEndian.Uint32(header[:4])
			position, _ := file.Seek(0, io.SeekCurrent)
			if position+int64(size)+4 > info.Size() {
				break
			}
			switch string(header[4:]) {
			case "IHDR":
				if data := read(size); len(data) == 13 {
					result.bitDepth = int(data[8])
				}
			case "cICP":
				if data := read(size); len(data) == 4 && (data[1] == 16 || data[1] == 18) {
					result.hdr, result.hdrPrimaries, result.hdrTransfer = true, uint16(data[0]), uint16(data[1])
					result.invalidCICP = data[2] != 0 || data[3] != 1
				}
			case "acTL":
				if data := read(size); len(data) == 8 {
					result.frames = int(binary.BigEndian.Uint32(data[:4]))
					result.sequence = true
				}
			case "iCCP":
				result.profilePresent = true
				data := read(size)
				if split := bytes.IndexByte(data, 0); split >= 0 && split+2 < len(data) && data[split+1] == 0 {
					if reader, err := zlib.NewReader(bytes.NewReader(data[split+2:])); err == nil {
						profile, err := io.ReadAll(io.LimitReader(reader, (4<<20)+1))
						reader.Close()
						if err == nil && len(profile) <= 4<<20 {
							result.profile = profile
						}
					}
				}
			case "IEND":
				return result
			}
			_, _ = file.Seek(position+int64(size)+4, io.SeekStart)
		}
	} else if string(magic[:4]) == "RIFF" && string(magic[8:]) == "WEBP" {
		result.frames = 0
		for {
			var header [8]byte
			if _, err := io.ReadFull(file, header[:]); err != nil {
				break
			}
			size := binary.LittleEndian.Uint32(header[4:])
			position, _ := file.Seek(0, io.SeekCurrent)
			if position+int64(size)+int64(size%2) > info.Size() {
				break
			}
			switch string(header[:4]) {
			case "ANIM":
				if data := read(size); len(data) == 6 {
					result.loopCount = int(binary.LittleEndian.Uint16(data[4:]))
				}
			case "ANMF":
				result.frames++
				result.sequence = true
			case "ICCP":
				result.profilePresent = true
				result.profile = read(size)
			}
			_, _ = file.Seek(position+int64(size)+int64(size%2), io.SeekStart)
		}
		result.frames = max(1, result.frames)
	} else if magic[0] == 0xff && magic[1] == 0xd8 {
		_, _ = file.Seek(2, io.SeekStart)
		parts := make(map[byte][]byte)
		var count byte
		for {
			var marker [2]byte
			if _, err := io.ReadFull(file, marker[:]); err != nil || marker[0] != 0xff {
				break
			}
			for marker[1] == 0xff {
				if _, err := io.ReadFull(file, marker[1:]); err != nil {
					return result
				}
			}
			if marker[1] == 0xda || marker[1] == 0xd9 {
				break
			}
			if marker[1] == 1 || marker[1] >= 0xd0 && marker[1] <= 0xd7 {
				continue
			}
			var length [2]byte
			if _, err := io.ReadFull(file, length[:]); err != nil {
				break
			}
			size := int(binary.BigEndian.Uint16(length[:])) - 2
			if size < 0 {
				break
			}
			position, _ := file.Seek(0, io.SeekCurrent)
			if marker[1] == 0xe2 {
				data := read(uint32(size))
				if len(data) >= 14 && bytes.Equal(data[:12], []byte("ICC_PROFILE\x00")) {
					result.profilePresent = true
					parts[data[12]] = data[14:]
					count = data[13]
				}
			}
			_, _ = file.Seek(position+int64(size), io.SeekStart)
		}
		if count > 0 && len(parts) == int(count) {
			for i := 1; i <= int(count); i++ {
				result.profile = append(result.profile, parts[byte(i)]...)
			}
		}
	} else if string(magic[4:8]) == "ftyp" {
		result.sequence = string(magic[8:]) == "avis"
		scanItemColorProperties(file, info.Size(), &result)
	}
	return result
}

func validateColorProperties(metadata sourceProperties) error {
	if metadata.invalidCICP {
		return apperror.New("invalidColorProperties", "This PNG declares an unsupported color matrix or sample range. Choose an RGB, full-range PNG.")
	}
	if metadata.hdr {
		if _, _, err := hdrBasis(metadata.hdrPrimaries); err != nil {
			return apperror.New("hdrColorUnsupported", "This HDR image has unrecognized color primaries. Choose a BT.2020, Display P3 or BT.709 HDR source.")
		}
		// PNG cICP takes precedence over iCCP, including an unreadable profile.
		return nil
	}
	if metadata.profilePresent && len(metadata.profile) == 0 {
		return apperror.New("colorProfileUnsupported", "This color profile is unreadable or too large to convert safely. Export an sRGB copy from your image editor first.")
	}
	return nil
}

func imageProperties(path string) sourceProperties {
	file, err := os.Open(path)
	if err != nil {
		return sourceProperties{frames: 1, bitDepth: 8}
	}
	defer file.Close()
	return properties(file)
}
