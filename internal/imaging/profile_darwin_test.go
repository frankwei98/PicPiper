//go:build darwin && cgo

package imaging

import (
	"bytes"
	"compress/zlib"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileConversionRetainsSixteenBitPrecision(t *testing.T) {
	img := image.NewNRGBA64(image.Rect(0, 0, 1, 1))
	img.SetNRGBA64(0, 0, color.NRGBA64{R: 0x4123, G: 0xa123, B: 0x6123, A: 0xffff})
	converted, err := normalizeProfile(img, displayP3Profile())
	if err != nil || !highBitDepth(converted) {
		t.Fatalf("profile conversion lost high-bit-depth storage: %T %v", converted, err)
	}
	got := color.NRGBA64Model.Convert(converted.At(0, 0)).(color.NRGBA64)
	if got.G%257 == 0 && got.B%257 == 0 {
		t.Fatalf("profile conversion quantized samples to 8-bit: %+v", got)
	}
}

func TestEmbeddedDisplayP3IsConvertedBeforeProfileRemoval(t *testing.T) {
	profile := displayP3Profile()
	if len(profile) == 0 {
		t.Fatal("could not create the system Display P3 profile")
	}
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.SetNRGBA(0, 0, color.NRGBA{R: 64, G: 160, B: 96, A: 255})
	img.SetNRGBA(1, 0, color.NRGBA{R: 64, G: 160, B: 96, A: 128})
	img.SetNRGBA(0, 1, color.NRGBA{R: 20, G: 40, B: 240, A: 255})
	img.SetNRGBA(1, 1, color.NRGBA{R: 20, G: 40, B: 240, A: 255})
	var encoded, compressed bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	writer := zlib.NewWriter(&compressed)
	_, _ = writer.Write(profile)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	metadata := append([]byte("Display P3\x00\x00"), compressed.Bytes()...)
	data := append([]byte{}, encoded.Bytes()[:33]...)
	data = append(data, pngChunk("iCCP", metadata)...)
	data = append(data, encoded.Bytes()[33:]...)
	source := filepath.Join(t.TempDir(), "display-p3.png")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	decoded, _, err := decode(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	// Display P3 (64,160,96) transformed through the D65 RGB matrices and
	// sRGB transfer curve is approximately sRGB (0,163,89), with red clipped.
	got := color.NRGBAModel.Convert(decoded.At(0, 0)).(color.NRGBA)
	if got.R > 3 || abs(int(got.G)-163) > 3 || abs(int(got.B)-89) > 3 || got.A != 255 {
		t.Fatalf("profile was discarded without a correct conversion: %+v", got)
	}
	alpha := color.NRGBAModel.Convert(decoded.At(1, 0)).(color.NRGBA)
	if abs(int(alpha.A)-128) > 1 || abs(int(alpha.G)-int(got.G)) > 3 {
		t.Fatalf("profile conversion damaged alpha: %+v", alpha)
	}
	bottom := color.NRGBAModel.Convert(decoded.At(0, 1)).(color.NRGBA)
	if bottom.B < 230 || bottom.G > 50 {
		t.Fatalf("color conversion changed image orientation: %+v", bottom)
	}
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "srgb.png", Settings: settings{TargetFormat: "png"}}).(Result)
	if len(imageProperties(result.OutputPath).profile) != 0 {
		t.Fatal("the original profile was retained after normalization")
	}
	output, _, err := decode(context.Background(), result.OutputPath)
	if err != nil || color.NRGBAModel.Convert(output.At(0, 0)).(color.NRGBA) != got {
		t.Fatalf("export did not retain normalized color: %v", err)
	}
}
