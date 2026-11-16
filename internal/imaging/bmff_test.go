package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"testing"
)

func bmffBox(kind string, data []byte) []byte {
	encoded := binary.BigEndian.AppendUint32(nil, uint32(len(data)+8))
	encoded = append(encoded, kind...)
	return append(encoded, data...)
}

func nclxProperty(primaries, transfer uint16) []byte {
	data := []byte("nclx")
	data = binary.BigEndian.AppendUint16(data, primaries)
	data = binary.BigEndian.AppendUint16(data, transfer)
	data = binary.BigEndian.AppendUint16(data, 9)
	return bmffBox("colr", append(data, 0x80))
}

func TestColorPropertiesFollowPrimaryItemAssociations(t *testing.T) {
	for _, wide := range []bool{false, true} {
		for _, primaryFirst := range []bool{false, true} {
			for _, transfer := range []uint16{16, 18} {
				primary := uint32(7)
				pitm, ipma := make([]byte, 4), make([]byte, 4)
				if wide {
					primary = 70000
					pitm[0], ipma[0], ipma[3] = 1, 1, 1
					pitm = binary.BigEndian.AppendUint32(pitm, primary)
				} else {
					pitm = binary.BigEndian.AppendUint16(pitm, uint16(primary))
				}
				ipco := nclxProperty(9, 16) // A different item's PQ declaration.
				index := uint16(2)
				if wide {
					for index < 130 {
						ipco = append(ipco, bmffBox("free", nil)...)
						index++
					}
				}
				ipco = append(ipco, nclxProperty(12, transfer)...)
				ipco = append(ipco, bmffBox("colr", []byte("profignored ICC"))...)
				ipma = binary.BigEndian.AppendUint32(ipma, 2)
				for _, item := range []struct {
					id       uint32
					property uint16
				}{{1, 1}, {primary, index}} {
					if wide {
						ipma = binary.BigEndian.AppendUint32(ipma, item.id)
					} else {
						ipma = binary.BigEndian.AppendUint16(ipma, uint16(item.id))
					}
					ipma = append(ipma, 1)
					if wide {
						ipma = binary.BigEndian.AppendUint16(ipma, item.property|0x8000)
					} else {
						ipma = append(ipma, byte(item.property)|0x80)
					}
				}
				// Box order does not define association order.
				iprp := bmffBox("iprp", append(bmffBox("ipma", ipma), bmffBox("ipco", ipco)...))
				children := append(iprp, bmffBox("pitm", pitm)...)
				if primaryFirst {
					children = append(bmffBox("pitm", pitm), iprp...)
				}
				data := append(bmffBox("ftyp", []byte("avif\x00\x00\x00\x00avif")), bmffBox("meta", append(make([]byte, 4), children...))...)
				path := filepath.Join(t.TempDir(), "color.avif")
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
				got := imageProperties(path)
				if !got.hdr || got.hdrTransfer != transfer || got.hdrPrimaries != 12 || got.profilePresent {
					t.Fatalf("wide=%v primaryFirst=%v: wrong primary item properties: %+v", wide, primaryFirst, got)
				}
			}
		}
	}
}

func TestAssociatedICCAndP3IgnoreOtherItemsHDR(t *testing.T) {
	for _, tc := range []struct {
		name     string
		property []byte
		profile  []byte
	}{
		{"ICC", bmffBox("colr", []byte("profprimary ICC")), []byte("primary ICC")},
		// P3 is still detected when the platform cannot synthesize its ICC data.
		{"DisplayP3", nclxProperty(12, 13), displayP3Profile()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pitm := bmffBox("pitm", []byte{0, 0, 0, 0, 0, 7})
			ipco := bmffBox("ipco", append(nclxProperty(9, 16), tc.property...))
			ipma := bmffBox("ipma", []byte{0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 1, 0x81, 0, 7, 1, 0x82})
			children := append(pitm, bmffBox("iprp", append(ipco, ipma...))...)
			data := append(bmffBox("ftyp", []byte("heic\x00\x00\x00\x00mif1")), bmffBox("meta", append(make([]byte, 4), children...))...)
			path := filepath.Join(t.TempDir(), "color.heic")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			got := imageProperties(path)
			if got.hdr || !got.profilePresent {
				t.Fatalf("primary profile lost or another item's HDR adopted: %+v", got)
			}
			if !bytes.Equal(got.profile, tc.profile) {
				t.Fatal("primary item's profile does not match the platform's expected ICC data")
			}
		})
	}
}

func TestUnassociatedAVIFColorsDoNotChangePixels(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.SetRGBA(x, y, color.RGBA{R: 130, G: 130, B: 130, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := encodeModern(&encoded, img, "avif", 100); err != nil {
		t.Fatal(err)
	}
	base := encoded.Bytes()
	plain := filepath.Join(t.TempDir(), "plain.avif")
	if err := os.WriteFile(plain, base, 0600); err != nil {
		t.Fatal(err)
	}
	original, info, err := decode(context.Background(), plain)
	if err != nil || info.HDR {
		t.Fatalf("invalid baseline: %+v %v", info, err)
	}
	for _, property := range [][]byte{nclxProperty(9, 16), nclxProperty(9, 18), bmffBox("colr", []byte("profnot an ICC profile"))} {
		data := appendAVIFProperty(t, base, property)
		path := filepath.Join(t.TempDir(), "unassociated.avif")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		decoded, got, err := decode(context.Background(), path)
		if err != nil || got.HDR || got.BitDepth != info.BitDepth {
			t.Fatalf("unassociated property affected decoding: %+v %v", got, err)
		}
		for y := 0; y < 16; y++ {
			for x := 0; x < 16; x++ {
				if decoded.At(x, y) != original.At(x, y) {
					t.Fatalf("unassociated color changed pixel (%d,%d)", x, y)
				}
			}
		}
	}
}

// The pinned encoder emits a single-item AVIF with 32-bit box sizes and
// version-0 iloc using a 32-bit extent offset and length, without a base offset.
func appendAVIFProperty(t *testing.T, base, property []byte) []byte {
	t.Helper()
	positions := make(map[string]int)
	for _, kind := range []string{"ipco", "iprp", "meta", "iloc"} {
		position := bytes.Index(base, []byte(kind)) - 4
		if position < 0 {
			t.Fatalf("missing %s", kind)
		}
		positions[kind] = position
	}
	iloc := positions["iloc"]
	if !bytes.Equal(base[iloc+8:iloc+16], []byte{0, 0, 0, 0, 0x44, 0, 0, 1}) {
		t.Fatal("encoder changed iloc layout; update fixture mutation")
	}
	insert := positions["ipco"] + int(binary.BigEndian.Uint32(base[positions["ipco"]:]))
	data := append([]byte(nil), base[:insert]...)
	data = append(data, property...)
	data = append(data, base[insert:]...)
	for _, kind := range []string{"ipco", "iprp", "meta"} {
		position := positions[kind]
		binary.BigEndian.PutUint32(data[position:], binary.BigEndian.Uint32(data[position:])+uint32(len(property)))
	}
	if iloc >= insert {
		iloc += len(property)
	}
	binary.BigEndian.PutUint32(data[iloc+22:], binary.BigEndian.Uint32(data[iloc+22:])+uint32(len(property)))
	return data
}

func TestMissingOrMalformedItemAssociationsIgnoreColors(t *testing.T) {
	pitm := bmffBox("pitm", []byte{0, 0, 0, 0, 0, 1})
	ipco := bmffBox("ipco", nclxProperty(9, 16))
	for _, association := range [][]byte{nil, {}, {0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff}, {0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1}} {
		iprp := append([]byte(nil), ipco...)
		if association != nil {
			iprp = append(iprp, bmffBox("ipma", association)...)
		}
		for _, primary := range [][]byte{nil, pitm} {
			data := append(bmffBox("ftyp", []byte("avif\x00\x00\x00\x00avif")), bmffBox("meta", append(append(make([]byte, 4), primary...), bmffBox("iprp", iprp)...))...)
			path := filepath.Join(t.TempDir(), "invalid.avif")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if got := imageProperties(path); got.hdr || got.profilePresent {
				t.Fatalf("unresolved association adopted: %+v", got)
			}
		}
	}
}

func TestContainerRotationFollowsPrimaryItem(t *testing.T) {
	pitm := bmffBox("pitm", []byte{0, 0, 0, 0, 0, 7})
	ipco := bmffBox("ipco", append(
		bmffBox("irot", []byte{0}), // A different item's rotation.
		bmffBox("irot", []byte{3})...,
	))
	ipma := []byte{
		0, 0, 0, 0, // Version and flags.
		0, 0, 0, 2, // Entry count.
		0, 1, 1, 0x01, // Item 1 -> irot 0.
		0, 7, 1, 0x02, // Primary item 7 -> irot 270.
	}
	children := append(pitm, bmffBox("iprp", append(ipco, bmffBox("ipma", ipma)...))...)
	data := append(bmffBox("ftyp", []byte("avif\x00\x00\x00\x00avif")), bmffBox("meta", append(make([]byte, 4), children...))...)
	path := filepath.Join(t.TempDir(), "rotation.avif")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if got := imageProperties(path).rotation; got != 3 {
		t.Fatalf("rotation = %d, want the primary item's 3 (270 degrees)", got)
	}
}
