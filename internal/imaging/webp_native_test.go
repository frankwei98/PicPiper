//go:build cgo && nativewebp

package imaging

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"io"
	"testing"

	"github.com/gen2brain/webp"
)

func TestNativeWebPHandlesSubimageStrideAndAlpha(t *testing.T) {
	base := image.NewNRGBA(image.Rect(3, 4, 35, 24))
	source := base.SubImage(image.Rect(9, 8, 25, 20)).(*image.NRGBA)
	alpha := []uint8{0, 1, 127, 255}
	for y := source.Rect.Min.Y; y < source.Rect.Max.Y; y++ {
		for x := source.Rect.Min.X; x < source.Rect.Max.X; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 64, G: 128, B: 192, A: alpha[(x-source.Rect.Min.X)%len(alpha)]})
		}
	}
	var encoded bytes.Buffer
	if err := encodeModern(&encoded, source, "webp", 90); err != nil {
		t.Fatal(err)
	}
	decoded, err := webp.Decode(bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := decoded.Bounds().Size(), source.Bounds().Size(); got != want {
		t.Fatalf("encoded subimage size = %v, want %v", got, want)
	}
	for y := 0; y < decoded.Bounds().Dy(); y++ {
		for x := 0; x < decoded.Bounds().Dx(); x++ {
			got := color.NRGBAModel.Convert(decoded.At(x, y)).(color.NRGBA)
			if got.A != alpha[x%len(alpha)] {
				t.Fatalf("alpha at (%d,%d) = %d", x, y, got.A)
			}
			if got.A == 255 && (abs(int(got.R)-64) > 12 || abs(int(got.G)-128) > 12 || abs(int(got.B)-192) > 12) {
				t.Fatalf("native encoder changed the opaque color: %+v", got)
			}
		}
	}
}

func TestNativeWebPPropagatesWriteFailure(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	want := errors.New("output unavailable")
	if err := encodeWebP(failingWebPWriter{err: want}, source, 85); !errors.Is(err, want) {
		t.Fatalf("writer error = %v, want %v", err, want)
	}
	if err := encodeWebP(failingWebPWriter{}, source, 85); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write = %v, want %v", err, io.ErrShortWrite)
	}
}

type failingWebPWriter struct{ err error }

func (w failingWebPWriter) Write([]byte) (int, error) { return 0, w.err }

func TestNativeWebPRejectsInvalidDimensions(t *testing.T) {
	for _, bounds := range []image.Rectangle{image.Rect(0, 0, 0, 8), image.Rect(0, 0, 16384, 1)} {
		var output bytes.Buffer
		if err := encodeWebP(&output, &image.NRGBA{Rect: bounds}, 85); err == nil || output.Len() != 0 {
			t.Fatalf("invalid dimensions %v wrote an image", bounds)
		}
	}
}
