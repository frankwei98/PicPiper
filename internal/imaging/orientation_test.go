package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestOrientationPreserves16BitPixels(t *testing.T) {
	const width, height = 40, 30
	src := image.NewNRGBA64(image.Rect(5, 7, 5+width, 7+height))
	sample := color.NRGBA64{R: 0x1234, G: 0x5678, B: 0x9abc, A: 0xcdef}
	src.SetNRGBA64(5+10, 7+20, sample)

	oriented := applyOrientation(src, 6)

	if oriented.Bounds() != image.Rect(0, 0, height, width) {
		t.Fatalf("orientation produced bounds %v", oriented.Bounds())
	}
	if got := color.NRGBA64Model.Convert(oriented.At(height-1-20, 10)); got != sample {
		t.Fatalf("rotated pixel = %+v, want %+v", got, sample)
	}
	if _, _, _, alpha := oriented.At(0, 0).RGBA(); alpha != 0 {
		t.Fatalf("transparent pixel has alpha %d", alpha)
	}
}

func TestOrientationFindsEXIFAfterLargePayloads(t *testing.T) {
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	var jpegSource bytes.Buffer
	if err := jpeg.Encode(&jpegSource, image.NewRGBA(image.Rect(0, 0, 4, 2)), nil); err != nil {
		t.Fatal(err)
	}
	jpegData := []byte{0xff, 0xd8}
	for range 34 {
		jpegData = append(jpegData, 0xff, 0xe2, 0xff, 0xff)
		jpegData = append(jpegData, make([]byte, 65533)...)
	}
	exif := append([]byte("Exif\x00\x00"), tiff...)
	jpegData = append(jpegData, 0xff, 0xe1, 0, byte(len(exif)+2))
	jpegData = append(jpegData, exif...)
	jpegData = append(jpegData, jpegSource.Bytes()[2:]...)

	webpChunks := append([]byte("VP8 "), binary.LittleEndian.AppendUint32(nil, 3<<20)...)
	webpChunks = append(webpChunks, make([]byte, 3<<20)...)
	webpChunks = append(webpChunks, []byte("EXIF")...)
	webpChunks = binary.LittleEndian.AppendUint32(webpChunks, uint32(len(tiff)))
	webpChunks = append(webpChunks, tiff...)
	webpData := append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(webpChunks)+4))...)
	webpData = append(webpData, []byte("WEBP")...)
	webpData = append(webpData, webpChunks...)

	var pngSource bytes.Buffer
	if err := png.Encode(&pngSource, image.NewRGBA(image.Rect(0, 0, 4, 2))); err != nil {
		t.Fatal(err)
	}
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(tiff)))
	chunk = append(chunk, []byte("eXIf")...)
	chunk = append(chunk, tiff...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	pngData := append([]byte{}, pngSource.Bytes()[:pngSource.Len()-12]...)
	pngData = append(pngData, chunk...)
	pngData = append(pngData, pngSource.Bytes()[pngSource.Len()-12:]...)

	for format, data := range map[string][]byte{"jpg": jpegData, "webp": webpData, "png": pngData} {
		path := filepath.Join(t.TempDir(), "rotated."+format)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if got := orientation(path); got != 6 {
			t.Fatalf("%s: lost rotation after preceding image/metadata data: %d", format, got)
		}
		if format != "webp" {
			img, info, err := decode(context.Background(), path)
			if err != nil || img.Bounds().Dx() != 2 || img.Bounds().Dy() != 4 || info.Width != 2 || info.Height != 4 {
				t.Fatalf("%s: oriented pixels or dimensions incorrect: %+v %v", format, info, err)
			}
		}
	}
}

func TestWebPOrientationReadsPaddedChunksAndBothEXIFEncodings(t *testing.T) {
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	for _, prefix := range []string{"", "Exif\x00\x00"} {
		exif := append([]byte(prefix), tiff...)
		chunks := []byte{'X', 'M', 'P', ' ', 1, 0, 0, 0, 'x', 0}
		chunks = append(chunks, []byte("EXIF")...)
		chunks = binary.LittleEndian.AppendUint32(chunks, uint32(len(exif)))
		chunks = append(chunks, exif...)
		data := append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(chunks)+4))...)
		data = append(data, []byte("WEBP")...)
		data = append(data, chunks...)
		path := filepath.Join(t.TempDir(), "rotated.webp")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if got := orientation(path); got != 6 {
			t.Fatalf("EXIF prefix %q: orientation %d, want 6", prefix, got)
		}
		if err := os.WriteFile(path, data[:len(data)-10], 0600); err != nil {
			t.Fatal(err)
		}
		if got := orientation(path); got != 1 {
			t.Fatalf("truncated EXIF: orientation %d, want fallback 1", got)
		}
	}
}
