package imaging

import (
	"bytes"
	"encoding/binary"
	"image"
	"testing"
)

func TestMalformedAVIFReturnsErrorWithoutCrashingDecoder(t *testing.T) {
	box := func(kind string, payload []byte) []byte {
		data := binary.BigEndian.AppendUint32(nil, uint32(8+len(payload)))
		data = append(data, kind...)
		return append(data, payload...)
	}
	// The dependency's container metadata parser used to index an empty pitm
	// payload before checking its length. Include ipco so that path is reached.
	data := box("ftyp", []byte("avif\x00\x00\x00\x00avif"))
	children := box("pitm", nil)
	children = append(children, box("iprp", box("ipco", box("ispe", make([]byte, 12))))...)
	data = append(data, box("meta", append(make([]byte, 4), children...))...)
	if _, _, err := decodeConfig(bytes.NewReader(data)); err == nil {
		t.Fatal("malformed AVIF header was accepted")
	}
	if _, err := decodePixels(bytes.NewReader(data), "avif"); err == nil {
		t.Fatal("malformed AVIF pixels were accepted")
	}
	// A rejected file must release the shared codec lock for subsequent reads.
	var valid bytes.Buffer
	if err := encodeModern(&valid, image.NewNRGBA(image.Rect(0, 0, 2, 2)), "avif", 80); err != nil {
		t.Fatal(err)
	}
	if config, _, err := decodeConfig(bytes.NewReader(valid.Bytes())); err != nil || config.Width != 2 || config.Height != 2 {
		t.Fatalf("decoder did not recover for a valid image: %+v %v", config, err)
	}
}
