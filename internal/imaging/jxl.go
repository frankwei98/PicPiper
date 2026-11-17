package imaging

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
)

const jxlPrefixBytes = 24
const jxlMaxMetadataBoxes = 4096

var jxlContainerSignature = []byte{0, 0, 0, 12, 'J', 'X', 'L', ' ', 13, 10, 135, 10}

// jxlAnimation reads only the prefix needed for have_animation. In libjxl
// v0.11.2, SizeHeader and ImageMetadata precede all image/ICC/frame data:
// https://github.com/libjxl/libjxl/blob/v0.11.2/lib/jxl/image_metadata.cc#L278
// The largest prefix is 16 signature + 68 size + 8 flags/orientation +
// 68 intrinsic size + 32 preview size = 192 bits. Container traversal has a
// separate box limit and seeks over unrelated payloads without allocating them.
func jxlAnimation(reader io.ReaderAt, fileSize int64) (bool, error) {
	var signature [12]byte
	n, err := reader.ReadAt(signature[:], 0)
	if n < 2 {
		return false, fmt.Errorf("truncated JPEG XL signature: %w", err)
	}
	if signature[0] == 0xff && signature[1] == 0x0a {
		var prefix [jxlPrefixBytes]byte
		n, err := reader.ReadAt(prefix[:], 0)
		if err != nil && err != io.EOF {
			return false, err
		}
		return jxlAnimationFlag(prefix[:n])
	}
	if n != len(signature) || !bytes.Equal(signature[:], jxlContainerSignature) {
		return false, fmt.Errorf("invalid JPEG XL container signature")
	}

	var prefix [jxlPrefixBytes]byte
	used := 0
	position := int64(len(signature))
	var nextIndex uint32
	partial, final := false, false
	for range jxlMaxMetadataBoxes {
		if position == fileSize {
			break
		}
		if position > fileSize || fileSize-position < 8 {
			return false, fmt.Errorf("truncated JPEG XL box header")
		}
		var header [16]byte
		if _, err := reader.ReadAt(header[:8], position); err != nil {
			return false, err
		}
		size := uint64(binary.BigEndian.Uint32(header[:4]))
		headerSize := int64(8)
		if size == 1 {
			if fileSize-position < 16 {
				return false, fmt.Errorf("truncated JPEG XL extended box header")
			}
			if _, err := reader.ReadAt(header[8:], position+8); err != nil {
				return false, err
			}
			size, headerSize = binary.BigEndian.Uint64(header[8:]), 16
		} else if size == 0 {
			size = uint64(fileSize - position)
		}
		if size < uint64(headerSize) || size > uint64(fileSize-position) {
			return false, fmt.Errorf("invalid JPEG XL box size")
		}
		end := position + int64(size)
		start := position + headerSize
		kind := string(header[4:8])
		if kind == "jxlc" || kind == "jxlp" {
			if final || (kind == "jxlc" && partial) {
				return false, fmt.Errorf("inconsistent JPEG XL codestream boxes")
			}
			if kind == "jxlp" {
				if end-start < 4 {
					return false, fmt.Errorf("truncated JPEG XL fragment index")
				}
				var indexBytes [4]byte
				if _, err := reader.ReadAt(indexBytes[:], start); err != nil {
					return false, err
				}
				index := binary.BigEndian.Uint32(indexBytes[:])
				if index&0x7fffffff != nextIndex {
					return false, fmt.Errorf("out-of-order JPEG XL fragment")
				}
				nextIndex++
				partial, final = true, index&0x80000000 != 0
				start += 4
			} else {
				final = true
			}
			count := int(min(end-start, int64(len(prefix)-used)))
			if _, err := reader.ReadAt(prefix[used:used+count], start); err != nil {
				return false, err
			}
			used += count
			animated, err := jxlAnimationFlag(prefix[:used])
			if err == nil {
				return animated, nil
			}
			if err != io.ErrUnexpectedEOF || final || used == len(prefix) {
				return false, err
			}
		}
		position = end
	}
	return false, fmt.Errorf("JPEG XL animation header is missing or exceeds the box limit")
}

// Bits are read least significant first, without alignment between bundles.
// Only the optional size bundles need skipping before have_animation; no
// extension fields, color data, or animation frames are traversed.
func jxlAnimationFlag(prefix []byte) (bool, error) {
	if len(prefix) < 2 {
		return false, io.ErrUnexpectedEOF
	}
	if prefix[0] != 0xff || prefix[1] != 0x0a {
		return false, fmt.Errorf("invalid JPEG XL codestream signature")
	}
	bits := jxlHeaderBits{data: prefix[2:]}
	bits.size(false)
	if bits.read(1) != 0 { // all_default
		return false, bits.err
	}
	if bits.read(1) == 0 { // extra_fields
		return false, bits.err
	}
	bits.read(3) // orientation
	if bits.read(1) != 0 {
		bits.size(false) // intrinsic size
	}
	if bits.read(1) != 0 {
		bits.size(true) // preview size
	}
	animated := bits.read(1) != 0
	return animated, bits.err
}

type jxlHeaderBits struct {
	data []byte
	pos  int
	err  error
}

func (bits *jxlHeaderBits) read(count int) uint32 {
	if bits.err != nil {
		return 0
	}
	if count > len(bits.data)*8-bits.pos {
		bits.err = io.ErrUnexpectedEOF
		return 0
	}
	var value uint32
	for i := range count {
		value |= uint32((bits.data[bits.pos/8]>>uint(bits.pos%8))&1) << uint(i)
		bits.pos++
	}
	return value
}

// https://github.com/libjxl/libjxl/blob/v0.11.2/lib/jxl/headers.cc#L124
// U32 dimensions have a two-bit selector followed by a fixed-width payload.
// Values and offsets do not affect the position of the animation flag.
func (bits *jxlHeaderBits) size(preview bool) {
	small := bits.read(1) != 0
	widths := [4]int{9, 13, 18, 30}
	if preview {
		if small {
			widths = [4]int{0, 0, 5, 9}
		} else {
			widths = [4]int{6, 8, 10, 12}
		}
	}
	dimension := func() {
		if small && !preview {
			bits.read(5)
		} else {
			bits.read(widths[bits.read(2)])
		}
	}
	dimension()
	if bits.read(3) == 0 {
		dimension()
	}
}
