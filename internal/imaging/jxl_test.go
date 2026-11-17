package imaging

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"image"
	"os"
	"path/filepath"
	"testing"
)

type jxlTestBits struct{ bits []byte }

func (w *jxlTestBits) put(value uint32, count int) {
	for i := range count {
		w.bits = append(w.bits, byte(value>>uint(i)&1))
	}
}
func (w *jxlTestBits) bytes() []byte {
	data := []byte{0xff, 0x0a}
	for i, bit := range w.bits {
		if i%8 == 0 {
			data = append(data, 0)
		}
		data[2+i/8] |= bit << uint(i%8)
	}
	return data
}
func jxlTestHeader(animated, maximum bool) []byte {
	w := &jxlTestBits{}
	size := func(preview bool) {
		if maximum {
			w.put(0, 1)
			width := 30
			if preview {
				width = 12
			}
			w.put(3, 2)
			w.put(0, width)
			w.put(0, 3)
			w.put(3, 2)
			w.put(0, width)
		} else {
			w.put(1, 1)
			w.put(0, 5)
			w.put(1, 3)
		}
	}
	size(false)
	w.put(0, 1) // all_default
	w.put(1, 1) // extra_fields
	w.put(0, 3) // orientation
	if maximum {
		w.put(1, 1)
		size(false)
		w.put(1, 1)
		size(true)
	} else {
		w.put(0, 1)
		w.put(0, 1)
	}
	if animated {
		w.put(1, 1)
	} else {
		w.put(0, 1)
	}
	return w.bytes()
}
func jxlTestBox(kind string, payload []byte) []byte {
	data := binary.BigEndian.AppendUint32(nil, uint32(len(payload)+8))
	data = append(data, kind...)
	return append(data, payload...)
}

func TestJXLAnimationBoundedHeadersAndContainers(t *testing.T) {
	for _, maximum := range []bool{false, true} {
		for _, animated := range []bool{false, true} {
			raw := jxlTestHeader(animated, maximum)
			if maximum && len(raw) != jxlPrefixBytes {
				t.Fatalf("maximum header is %d bytes", len(raw))
			}
			container := append(append([]byte{}, jxlContainerSignature...), jxlTestBox("jxlc", raw)...)
			fragmented := append([]byte{}, jxlContainerSignature...)
			for i, b := range raw {
				index := uint32(i)
				if i == len(raw)-1 {
					index |= 1 << 31
				}
				payload := binary.BigEndian.AppendUint32(nil, index)
				fragmented = append(fragmented, jxlTestBox("jxlp", append(payload, b))...)
			}
			for _, data := range [][]byte{raw, container, fragmented} {
				got, err := jxlAnimation(bytes.NewReader(data), int64(len(data)))
				if err != nil || got != animated {
					t.Fatalf("animation=%t maximum=%t: got %t %v", animated, maximum, got, err)
				}
			}
		}
	}
}

func TestJXLSizeHeaderVariants(t *testing.T) {
	for _, preview := range []bool{false, true} {
		for _, small := range []bool{false, true} {
			for selector := range 4 {
				for _, ratio := range []uint32{0, 1, 7} {
					w := &jxlTestBits{}
					if small {
						w.put(1, 1)
					} else {
						w.put(0, 1)
					}
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
							w.put(0, 5)
						} else {
							w.put(uint32(selector), 2)
							w.put(0, widths[selector])
						}
					}
					dimension()
					w.put(ratio, 3)
					if ratio == 0 {
						dimension()
					}
					position := len(w.bits)
					w.put(1, 1)
					bits := jxlHeaderBits{data: w.bytes()[2:]}
					bits.size(preview)
					if bits.pos != position || bits.read(1) != 1 || bits.err != nil {
						t.Fatalf("preview=%t small=%t selector=%d ratio=%d: %+v", preview, small, selector, ratio, bits)
					}
				}
			}
		}
	}
}

func TestJXLContainerBoxSizes(t *testing.T) {
	raw := jxlTestHeader(true, false)
	for _, extended := range []bool{false, true} {
		box := binary.BigEndian.AppendUint32(nil, 0)
		box = append(box, "jxlc"...)
		if extended {
			binary.BigEndian.PutUint32(box[:4], 1)
			box = binary.BigEndian.AppendUint64(box, uint64(len(raw)+16))
		}
		box = append(box, raw...)
		container := append(append([]byte{}, jxlContainerSignature...), box...)
		if animated, err := jxlAnimation(bytes.NewReader(container), int64(len(container))); err != nil || !animated {
			t.Fatalf("extended=%t: %t %v", extended, animated, err)
		}
	}
}

func TestJXLAnimationRejectsUncertainMetadata(t *testing.T) {
	raw := jxlTestHeader(true, true)
	truncatedBox := append(append([]byte{}, jxlContainerSignature...), []byte{0, 0, 0, 40, 'j', 'x', 'l', 'c'}...)
	excessive := append([]byte{}, jxlContainerSignature...)
	for range jxlMaxMetadataBoxes {
		excessive = append(excessive, jxlTestBox("free", nil)...)
	}
	excessive = append(excessive, jxlTestBox("jxlc", raw)...)
	for _, data := range [][]byte{raw[:len(raw)-1], truncatedBox, excessive} {
		if _, err := jxlAnimation(bytes.NewReader(data), int64(len(data))); err == nil {
			t.Fatal("uncertain animation metadata accepted")
		}
		path := filepath.Join(t.TempDir(), "truncated.jxl")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateColorProperties(imageProperties(path)); err == nil {
			t.Fatal("metadata failure defaulted to a still image")
		}
	}
}

func TestJXLKnownAnimationHeader(t *testing.T) {
	// First 24 bytes of gen2brain/jpegxl v0.6.0 testdata/test.jxl, whose
	// bundled decoder returns 48 distinct frames. No frame data is needed here.
	prefix, err := hex.DecodeString("ff0a5f0403d8505c12004c006540005d667b591000800a95")
	if err != nil {
		t.Fatal(err)
	}
	if animated, err := jxlAnimation(bytes.NewReader(prefix), int64(len(prefix))); err != nil || !animated {
		t.Fatalf("known animation header: %t %v", animated, err)
	}
}

func TestJXLGeneratedStillRemainsStatic(t *testing.T) {
	var encoded bytes.Buffer
	if err := encodeModern(&encoded, image.NewNRGBA(image.Rect(0, 0, 8, 8)), "jxl", 80); err != nil {
		t.Fatal(err)
	}
	if animated, err := jxlAnimation(bytes.NewReader(encoded.Bytes()), int64(encoded.Len())); err != nil || animated {
		t.Fatalf("generated still: %t %v", animated, err)
	}
}
