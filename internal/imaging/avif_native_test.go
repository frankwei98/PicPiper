//go:build cgo && nativeavif

package imaging

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"io"
	"testing"
)

func TestNativeAVIFPreservesSubimageAndLosslessAlpha(t *testing.T) {
	base := image.NewNRGBA(image.Rect(3, 4, 61, 45))
	source := base.SubImage(image.Rect(9, 8, 42, 29)).(*image.NRGBA)
	alpha := []uint8{0, 1, 64, 127, 255}
	for y := source.Rect.Min.Y; y < source.Rect.Max.Y; y++ {
		for x := source.Rect.Min.X; x < source.Rect.Max.X; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 76, G: 141, B: 208, A: alpha[(x-source.Rect.Min.X)%len(alpha)]})
		}
	}
	var output bytes.Buffer
	if err := encodeModern(&output, source, "avif", 85); err != nil {
		t.Fatal(err)
	}
	decoded, err := decodePixels(bytes.NewReader(output.Bytes()), "avif")
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds().Size() != source.Bounds().Size() {
		t.Fatalf("subimage dimensions = %v, want %v", decoded.Bounds(), source.Bounds().Size())
	}
	for y := 0; y < decoded.Bounds().Dy(); y++ {
		for x := 0; x < decoded.Bounds().Dx(); x++ {
			got := color.NRGBAModel.Convert(decoded.At(x, y)).(color.NRGBA)
			if got.A != alpha[x%len(alpha)] {
				t.Fatalf("alpha at (%d,%d) = %d, want %d", x, y, got.A, alpha[x%len(alpha)])
			}
			// The bundled decoder premultiplies into 8-bit RGBA. Check visible
			// colors where that rounding can be distinguished from encoder error.
			if got.A >= 127 && (abs(int(got.R)-76) > 6 || abs(int(got.G)-141) > 6 || abs(int(got.B)-208) > 6) {
				t.Fatalf("transparent edge color changed: %+v", got)
			}
		}
	}
}

func TestNativeAVIFPropagatesWriteFailure(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	want := errors.New("output unavailable")
	if err := encodeAVIF(failingAVIFWriter{err: want}, source, 85); !errors.Is(err, want) {
		t.Fatalf("writer error = %v, want %v", err, want)
	}
	if err := encodeAVIF(failingAVIFWriter{}, source, 85); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write = %v, want %v", err, io.ErrShortWrite)
	}
}

type failingAVIFWriter struct{ err error }

func (w failingAVIFWriter) Write([]byte) (int, error) { return 0, w.err }

func TestNativeAVIFRejectsInvalidDimensions(t *testing.T) {
	for _, bounds := range []image.Rectangle{image.Rect(0, 0, 0, 8), image.Rect(0, 0, 65537, 1), image.Rect(0, 0, 8000, 8000)} {
		var output bytes.Buffer
		if err := encodeAVIF(&output, &image.NRGBA{Rect: bounds}, 85); err == nil || output.Len() != 0 {
			t.Fatalf("invalid dimensions %v wrote an image", bounds)
		}
	}
}
