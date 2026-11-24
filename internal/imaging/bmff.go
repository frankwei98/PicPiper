package imaging

import (
	"encoding/binary"
	"os"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

const bmffBoxBudget = 10000

type itemBox struct {
	kind       string
	start, end int64
}

// Inspect only formats registered with image.DecodeConfig. HEIC's config
// reader parses sample tables too, so this check must precede both codec calls.
func inspectBMFF(file *os.File, size int64) (animated bool, err error) {
	var header [12]byte
	if _, err := file.ReadAt(header[:], 0); err != nil || string(header[4:8]) != "ftyp" {
		return false, nil
	}
	major := string(header[8:12])
	heic := major == "heic" || major == "heix" || heicSequenceBrand(major)
	if !heic && major != "avif" && major != "avis" {
		return false, nil
	}
	if heicSequenceBrand(major) {
		return false, unsupportedHEICSequence()
	}

	budget := bmffBoxBudget
	boxes, ok := itemBoxes(file, 0, size, &budget)
	if !ok || len(boxes) == 0 || boxes[0].kind != "ftyp" {
		return false, invalidBMFF()
	}
	const maxCompatibleBrands = 64
	brands := itemBoxData(file, boxes[0], 8+4*maxCompatibleBrands)
	if len(brands) < 8 || len(brands)%4 != 0 {
		return false, invalidBMFF()
	}
	animated = major == "avis"
	for offset := 8; offset < len(brands); offset += 4 {
		brand := string(brands[offset : offset+4])
		if heic && heicSequenceBrand(brand) {
			return false, unsupportedHEICSequence()
		}
		animated = animated || !heic && brand == "avis"
	}
	for _, box := range boxes[1:] {
		if box.kind != "moov" {
			continue
		}
		tracks, ok := itemBoxes(file, box.start, box.end, &budget)
		if !ok {
			return false, invalidBMFF()
		}
		for _, track := range tracks {
			if track.kind != "trak" {
				continue
			}
			visual, err := inspectBMFFTrack(file, track, &budget, heic)
			if err != nil {
				return false, err
			}
			if heic && visual {
				return false, unsupportedHEICSequence()
			}
			animated = animated || visual
		}
	}
	return animated, nil
}

func heicSequenceBrand(brand string) bool {
	return brand == "hevc" || brand == "hevx" || brand == "msf1"
}

func unsupportedHEICSequence() error {
	return apperror.New("heicSequenceUnsupported", "Pic Piper supports still HEIC images. Export a still image from this sequence first.")
}

func invalidBMFF() error {
	return apperror.New("unsupportedImage", "The HEIC or AVIF image has invalid or unsupported container metadata.")
}

func inspectBMFFTrack(file *os.File, track itemBox, budget *int, heic bool) (bool, error) {
	boxes, ok := itemBoxes(file, track.start, track.end, budget)
	if !ok {
		return false, invalidBMFF()
	}
	var visual bool
	for _, box := range boxes {
		switch box.kind {
		case "tkhd":
			if !heic {
				if err := checkAVIFTrackHeader(file, box); err != nil {
					return false, err
				}
			}
		case "mdia":
			media, ok := itemBoxes(file, box.start, box.end, budget)
			if !ok {
				return false, invalidBMFF()
			}
			for _, child := range media {
				switch child.kind {
				case "hdlr":
					var handler [12]byte
					if !readBoxPrefix(file, child, handler[:]) {
						return false, invalidBMFF()
					}
					visual = visual || string(handler[8:]) == "pict"
				case "minf":
					if !heic {
						av1, err := checkAVIFSampleDescriptions(file, child, budget)
						if err != nil {
							return false, err
						}
						visual = visual || av1
					}
				}
			}
		}
	}
	return visual, nil
}

func checkAVIFTrackHeader(file *os.File, box itemBox) error {
	// libavif allocates the track output at the tkhd display dimensions.
	// The version 1 header uses wider creation, modification and duration fields.
	var header [96]byte
	if !readBoxPrefix(file, box, header[:1]) || header[0] > 1 {
		return invalidBMFF()
	}
	offset := 76 + int(header[0])*12
	if !readBoxPrefix(file, box, header[:offset+8]) {
		return invalidBMFF()
	}
	width := int(binary.BigEndian.Uint32(header[offset:]) >> 16)
	height := int(binary.BigEndian.Uint32(header[offset+4:]) >> 16)
	if width != 0 && height != 0 && !validDimensions(width, height) {
		return imagePixelLimitError()
	}
	return nil
}

func checkAVIFSampleDescriptions(file *os.File, minf itemBox, budget *int) (visual bool, err error) {
	children, ok := itemBoxes(file, minf.start, minf.end, budget)
	if !ok {
		return false, invalidBMFF()
	}
	for _, child := range children {
		if child.kind != "stbl" {
			continue
		}
		tables, ok := itemBoxes(file, child.start, child.end, budget)
		if !ok {
			return false, invalidBMFF()
		}
		for _, table := range tables {
			if table.kind != "stsd" {
				continue
			}
			var fullBox [8]byte
			if !readBoxPrefix(file, table, fullBox[:]) || fullBox[0] > 1 {
				return false, invalidBMFF()
			}
			entries, ok := itemBoxes(file, table.start+8, table.end, budget)
			if !ok || uint32(len(entries)) != binary.BigEndian.Uint32(fullBox[4:]) {
				return false, invalidBMFF()
			}
			for _, entry := range entries {
				if entry.kind != "av01" {
					continue
				}
				var dimensions [28]byte
				if !readBoxPrefix(file, entry, dimensions[:]) {
					return false, invalidBMFF()
				}
				width := int(binary.BigEndian.Uint16(dimensions[24:]))
				height := int(binary.BigEndian.Uint16(dimensions[26:]))
				if !validDimensions(width, height) {
					return false, imagePixelLimitError()
				}
				visual = true
			}
		}
	}
	return visual, nil
}

func readBoxPrefix(file *os.File, box itemBox, dest []byte) bool {
	if int64(len(dest)) > box.end-box.start {
		return false
	}
	_, err := file.ReadAt(dest, box.start)
	return err == nil
}

// Item properties are scoped to their meta box. Enumerate siblings before
// resolving pitm/ipma so file order cannot select another item's colors.
func scanItemColorProperties(file *os.File, end int64, result *sourceProperties) {
	budget := bmffBoxBudget
	boxes, _ := itemBoxes(file, 0, end, &budget)
	for _, box := range boxes {
		if box.kind != "meta" || box.end-box.start < 4 {
			continue
		}
		var primary uint32
		found := false
		children, _ := itemBoxes(file, box.start+4, box.end, &budget)
		for _, child := range children {
			if child.kind != "pitm" {
				continue
			}
			data := itemBoxData(file, child, 8)
			if len(data) == 6 && data[0] == 0 {
				primary, found = uint32(binary.BigEndian.Uint16(data[4:])), true
			} else if len(data) == 8 && data[0] == 1 {
				primary, found = binary.BigEndian.Uint32(data[4:]), true
			}
		}
		if !found {
			continue
		}
		for _, child := range children {
			if child.kind != "iprp" {
				continue
			}
			var properties []itemBox
			var associations []uint16
			containers, _ := itemBoxes(file, child.start, child.end, &budget)
			for _, container := range containers {
				switch container.kind {
				case "ipco":
					properties, _ = itemBoxes(file, container.start, container.end, &budget)
				case "ipma":
					associations = append(associations, primaryAssociations(itemBoxData(file, container, 4<<20), primary)...)
				}
			}
			for _, index := range associations {
				if index == 0 || int(index) > len(properties) {
					continue
				}
				property := properties[index-1]
				switch property.kind {
				case "colr":
					readItemColor(file, property, result)
				case "irot":
					readItemRotation(file, property, result)
				}
			}
		}
		return
	}
}

func itemBoxes(file *os.File, start, end int64, budget *int) ([]itemBox, bool) {
	var boxes []itemBox
	for position := start; position < end; {
		if end-position < 8 || *budget <= 0 {
			return nil, false
		}
		*budget--
		var header [16]byte
		if _, err := file.ReadAt(header[:8], position); err != nil {
			return nil, false
		}
		size := uint64(binary.BigEndian.Uint32(header[:4]))
		headerSize := int64(8)
		if size == 1 {
			if end-position < 16 {
				return nil, false
			}
			if _, err := file.ReadAt(header[8:], position+8); err != nil {
				return nil, false
			}
			size, headerSize = binary.BigEndian.Uint64(header[8:]), 16
		} else if size == 0 {
			size = uint64(end - position)
		}
		if size < uint64(headerSize) || size > uint64(end-position) {
			return nil, false
		}
		boxes = append(boxes, itemBox{kind: string(header[4:8]), start: position + headerSize, end: position + int64(size)})
		position += int64(size)
	}
	return boxes, true
}

func itemBoxData(file *os.File, box itemBox, limit int64) []byte {
	length := box.end - box.start
	if length < 0 || length > limit {
		return nil
	}
	data := make([]byte, length)
	if _, err := file.ReadAt(data, box.start); err != nil {
		return nil
	}
	return data
}

func primaryAssociations(data []byte, primary uint32) []uint16 {
	if len(data) < 8 || data[0] > 1 {
		return nil
	}
	version, wide := data[0], data[3]&1 != 0
	entries := binary.BigEndian.Uint32(data[4:8])
	data = data[8:]
	var indices []uint16
	for entry := uint32(0); entry < entries; entry++ {
		idSize := 2
		if version == 1 {
			idSize = 4
		}
		if len(data) < idSize+1 {
			return nil
		}
		id := uint32(binary.BigEndian.Uint16(data))
		if version == 1 {
			id = binary.BigEndian.Uint32(data)
		}
		count := int(data[idSize])
		data = data[idSize+1:]
		for association := 0; association < count; association++ {
			var index uint16
			if wide {
				if len(data) < 2 {
					return nil
				}
				index, data = binary.BigEndian.Uint16(data)&0x7fff, data[2:]
			} else {
				if len(data) < 1 {
					return nil
				}
				index, data = uint16(data[0]&0x7f), data[1:]
			}
			if id == primary {
				indices = append(indices, index)
			}
		}
	}
	return indices
}

// readItemRotation records the primary item's irot angle. The AVIF decoder
// applies 90/270-degree rotations to pixels, so inspection must report the
// same exchanged dimensions.
func readItemRotation(file *os.File, box itemBox, result *sourceProperties) {
	if data := itemBoxData(file, box, 4); len(data) > 0 {
		result.rotation = int(data[0] & 0x03)
	}
}

func readItemColor(file *os.File, box itemBox, result *sourceProperties) {
	var kind [4]byte
	if box.end-box.start < 4 {
		return
	}
	if _, err := file.ReadAt(kind[:], box.start); err != nil {
		return
	}
	data := itemBoxData(file, box, 4<<20)
	switch string(kind[:]) {
	case "prof", "rICC":
		result.profilePresent, result.profile = true, nil
		if len(data) >= 4 {
			result.profile = data[4:]
		}
	case "nclx":
		if len(data) >= 11 {
			primaries := binary.BigEndian.Uint16(data[4:6])
			transfer := binary.BigEndian.Uint16(data[6:8])
			if transfer == 16 || transfer == 18 {
				result.hdr, result.hdrPrimaries, result.hdrTransfer = true, primaries, transfer
			}
			if primaries == 12 && transfer == 13 {
				result.profilePresent, result.profile = true, displayP3Profile()
			}
		}
	}
}
