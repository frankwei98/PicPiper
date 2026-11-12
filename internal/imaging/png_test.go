package imaging

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestEncodePNGYCbCrUsesEightBitAndPreservesHighBytes(t *testing.T) {
	base := image.NewYCbCr(image.Rect(2, 3, 12, 11), image.YCbCrSubsampleRatio420)
	src := base.SubImage(image.Rect(4, 7, 9, 10)).(*image.YCbCr)
	for y := 7; y < 10; y++ {
		for x := 4; x < 9; x++ {
			base.Y[base.YOffset(x, y)] = uint8(40 + x*13 + y)
			ci := base.COffset(x, y)
			base.Cb[ci] = uint8(90 + x)
			base.Cr[ci] = uint8(130 + y)
		}
	}
	var encoded bytes.Buffer
	if err := encodePNG(&encoded, src); err != nil {
		t.Fatal(err)
	}
	checkPNGDepthAndPixels(t, encoded.Bytes(), src, 8)
}

func TestEncodePNGPreservesSixteenBitPNG(t *testing.T) {
	src := image.NewNRGBA64(image.Rect(0, 0, 2, 1))
	src.SetNRGBA64(0, 0, color.NRGBA64{R: 0x1234, G: 0xabcd, B: 0x56ef, A: 0x789a})
	src.SetNRGBA64(1, 0, color.NRGBA64{R: 0xfedc, G: 0x9876, B: 0x4321, A: 0xffff})
	var encoded bytes.Buffer
	if err := encodePNG(&encoded, src); err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if got := binary.BigEndian.Uint32(encoded.Bytes()[16:20]); got != 2 {
		t.Fatalf("IHDR width = %d, want 2", got)
	}
	if got := binary.BigEndian.Uint32(encoded.Bytes()[20:24]); got != 1 {
		t.Fatalf("IHDR height = %d, want 1", got)
	}
	if encoded.Bytes()[24] != 16 {
		t.Fatalf("bit depth = %d, want 16", encoded.Bytes()[24])
	}
	for x := 0; x < 2; x++ {
		want := src.NRGBA64At(x, 0)
		got := color.NRGBA64Model.Convert(decoded.At(x, 0)).(color.NRGBA64)
		if got != want {
			t.Fatalf("pixel %d = %#v, want %#v", x, got, want)
		}
	}
}

func TestEncodePNGNYCbCrAPreservesHighBytesIncludingAlpha(t *testing.T) {
	src := image.NewNYCbCrA(image.Rect(3, 5, 7, 7), image.YCbCrSubsampleRatio444)
	alpha := []uint8{0, 1, 127, 255}
	for y := 5; y < 7; y++ {
		for x := 3; x < 7; x++ {
			pixel := color.NYCbCrA{YCbCr: color.YCbCr{Y: uint8(55 + x*9 + y), Cb: uint8(70 + x*3), Cr: uint8(180 - y*4)}, A: alpha[(x-3)%len(alpha)]}
			yi, ci, ai := src.YOffset(x, y), src.COffset(x, y), src.AOffset(x, y)
			src.Y[yi], src.Cb[ci], src.Cr[ci], src.A[ai] = pixel.Y, pixel.Cb, pixel.Cr, pixel.A
		}
	}
	var encoded bytes.Buffer
	if err := encodePNG(&encoded, src); err != nil {
		t.Fatal(err)
	}
	checkPNGDepthAndPixels(t, encoded.Bytes(), src, 8)
}

func TestEncodePNGPreservesTransparentEightBitPixels(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	src.SetNRGBA(0, 0, color.NRGBA{R: 0x81, G: 0x42, B: 0xe7, A: 0})
	src.SetNRGBA(1, 0, color.NRGBA{R: 0x81, G: 0x42, B: 0xe7, A: 0x7f})
	var encoded bytes.Buffer
	if err := encodePNG(&encoded, src); err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	for x := 0; x < 2; x++ {
		if got, want := color.NRGBAModel.Convert(decoded.At(x, 0)), src.NRGBAAt(x, 0); got != want {
			t.Fatalf("pixel %d = %#v, want %#v", x, got, want)
		}
	}
}

func checkPNGDepthAndPixels(t *testing.T, data []byte, src image.Image, depth byte) {
	t.Helper()
	if data[24] != depth {
		t.Fatalf("bit depth = %d, want %d", data[24], depth)
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for y := src.Bounds().Min.Y; y < src.Bounds().Max.Y; y++ {
		for x := src.Bounds().Min.X; x < src.Bounds().Max.X; x++ {
			switch pixels := src.(type) {
			case *image.YCbCr:
				r, g, b, a := pixels.At(x, y).RGBA()
				want := [4]uint8{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
				r, g, b, a = decoded.At(x-src.Bounds().Min.X, y-src.Bounds().Min.Y).RGBA()
				got := [4]uint8{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
				if got != want {
					t.Fatalf("pixel (%d,%d) = %#v, want source At RGBA high bytes %#v", x, y, got, want)
				}
				continue
			case *image.NYCbCrA:
				pixel := pixels.NYCbCrAAt(x, y)
				r, g, b := color.YCbCrToRGB(pixel.Y, pixel.Cb, pixel.Cr)
				want := color.NRGBA{R: r, G: g, B: b, A: pixel.A}
				got := color.NRGBAModel.Convert(decoded.At(x-src.Bounds().Min.X, y-src.Bounds().Min.Y)).(color.NRGBA)
				if got != want {
					t.Fatalf("pixel (%d,%d) = %#v, want straight channels %#v", x, y, got, want)
				}
			}
		}
	}
}

func TestJPEGToPNGCompressionWritesEightBitPixels(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(25 + 31*x), G: uint8(40 + 27*y), B: uint8(180 - 19*x - 7*y), A: 255})
		}
	}
	var source bytes.Buffer
	if err := jpeg.Encode(&source, img, &jpeg.Options{Quality: 91}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "source.jpg")
	if err := os.WriteFile(path, source.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	decodedJPEG, err := jpeg.Decode(bytes.NewReader(source.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", map[string]any{}).(map[string]string)
	result := call(t, service, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "out.png", Settings: settings{TargetFormat: "png"}}).(Result)
	output, err := os.ReadFile(result.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	if output[24] != 8 {
		t.Fatalf("JPEG to PNG bit depth = %d, want 8", output[24])
	}
	decodedPNG, err := png.Decode(bytes.NewReader(output))
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < decodedJPEG.Bounds().Dy(); y++ {
		for x := 0; x < decodedJPEG.Bounds().Dx(); x++ {
			r, g, b, _ := decodedJPEG.At(x, y).RGBA()
			want := color.NRGBA{R: uint8(r >> 8), G: uint8(g >> 8), B: uint8(b >> 8), A: 255}
			got := color.NRGBAModel.Convert(decodedPNG.At(x, y)).(color.NRGBA)
			if got != want {
				t.Fatalf("pixel (%d,%d) = %#v, want JPEG high bytes %#v", x, y, got, want)
			}
		}
	}
}
