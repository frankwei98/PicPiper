package imaging

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"
)

func TestAVIFInspectionMatchesDecodedRotation(t *testing.T) {
	path := filepath.Join("testdata", "rotation.avif")
	info, err := inspect(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Width != 480 || info.Height != 640 {
		t.Fatalf("inspection reported %dx%d, want the rotated 480x640", info.Width, info.Height)
	}
	img, decoded, err := decode(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Width != info.Width || decoded.Height != info.Height {
		t.Fatalf("inspection reported %dx%d, decoded %dx%d", info.Width, info.Height, decoded.Width, decoded.Height)
	}
	if bounds := img.Bounds(); bounds.Dx() != 480 || bounds.Dy() != 640 {
		t.Fatalf("decoded pixels are %dx%d, want 480x640", bounds.Dx(), bounds.Dy())
	}
}

func TestAVIFCompressionSizeAndFidelity(t *testing.T) {
	img := lossyCodecFixture(t)
	var output bytes.Buffer
	if err := encodeModern(&output, img, "avif", 85); err != nil {
		t.Fatal(err)
	}
	// The old speed-8 encode is 67,126 bytes with mean squared RGB error 5.16.
	// Leave headroom for SIMD/thread decisions while guarding both improvements.
	if output.Len() > 45000 {
		t.Errorf("AVIF size = %d, want at most 45000 bytes", output.Len())
	}
	decoded, err := decodePixels(bytes.NewReader(output.Bytes()), "avif")
	if err != nil {
		t.Fatal(err)
	}
	var squaredError float64
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			r, g, b, _ := img.At(x, y).RGBA()
			dr, dg, db, _ := decoded.At(x, y).RGBA()
			for _, d := range []int{int(r>>8) - int(dr>>8), int(g>>8) - int(dg>>8), int(b>>8) - int(db>>8)} {
				squaredError += float64(d * d)
			}
		}
	}
	mse := squaredError / float64(img.Bounds().Dx()*img.Bounds().Dy()*3)
	if mse > 4 {
		t.Errorf("AVIF mean squared RGB error = %.3f, want at most 4", mse)
	}
	t.Logf("AVIF: %d bytes, mean squared RGB error %.3f", output.Len(), mse)
}
