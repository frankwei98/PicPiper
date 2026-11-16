package imaging

import (
	"encoding/binary"
	"os"
)

type itemBox struct {
	kind       string
	start, end int64
}

// Item properties are scoped to their meta box. Enumerate siblings before
// resolving pitm/ipma so file order cannot select another item's colors.
func scanItemColorProperties(file *os.File, end int64, result *sourceProperties) {
	budget := 10000
	for _, box := range itemBoxes(file, 0, end, &budget) {
		if box.kind != "meta" || box.end-box.start < 4 {
			continue
		}
		var primary uint32
		found := false
		children := itemBoxes(file, box.start+4, box.end, &budget)
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
			for _, container := range itemBoxes(file, child.start, child.end, &budget) {
				switch container.kind {
				case "ipco":
					properties = itemBoxes(file, container.start, container.end, &budget)
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

func itemBoxes(file *os.File, start, end int64, budget *int) []itemBox {
	var boxes []itemBox
	for position := start; position < end; {
		if end-position < 8 || *budget <= 0 {
			return nil
		}
		*budget--
		var header [16]byte
		if _, err := file.ReadAt(header[:8], position); err != nil {
			return nil
		}
		size := uint64(binary.BigEndian.Uint32(header[:4]))
		headerSize := int64(8)
		if size == 1 {
			if end-position < 16 {
				return nil
			}
			if _, err := file.ReadAt(header[8:], position+8); err != nil {
				return nil
			}
			size, headerSize = binary.BigEndian.Uint64(header[8:]), 16
		} else if size == 0 {
			size = uint64(end - position)
		}
		if size < uint64(headerSize) || size > uint64(end-position) {
			return nil
		}
		boxes = append(boxes, itemBox{kind: string(header[4:8]), start: position + headerSize, end: position + int64(size)})
		position += int64(size)
	}
	return boxes
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
