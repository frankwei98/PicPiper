package imaging

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func lossyCodecFixture(tb testing.TB) image.Image {
	tb.Helper()
	// Match the packaged-app smoke fixture, including its JPEG source encoding.
	fixture := image.NewRGBA(image.Rect(0, 0, 1200, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 1200; x++ {
			fixture.SetRGBA(x, y, color.RGBA{R: uint8(30 + x*160/1200), G: uint8(65 + y*120/800), B: uint8(150 + (x+y)%80), A: 255})
		}
	}
	var source bytes.Buffer
	if err := jpeg.Encode(&source, fixture, &jpeg.Options{Quality: 98}); err != nil {
		tb.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(source.Bytes()))
	if err != nil {
		tb.Fatal(err)
	}
	return img
}

func BenchmarkEncodeFormats(b *testing.B) {
	img := lossyCodecFixture(b)
	for _, format := range []string{"jpg", "png", "webp", "avif", "jxl"} {
		b.Run(format, func(b *testing.B) {
			var output bytes.Buffer
			encode := func() error {
				output.Reset()
				switch format {
				case "jpg":
					return jpeg.Encode(&output, img, &jpeg.Options{Quality: 85})
				case "png":
					return encodePNG(&output, img)
				default:
					return encodeModern(&output, img, format, 85)
				}
			}
			// Exclude first-use WASM compilation from warm encode measurements.
			if err := encode(); err != nil {
				b.Fatal(err)
			}
			b.ResetTimer()
			for b.Loop() {
				if err := encode(); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(output.Len()), "bytes/output")
		})
	}
}
