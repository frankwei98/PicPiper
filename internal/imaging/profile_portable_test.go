//go:build !darwin || !cgo

package imaging

import (
	"bytes"
	"compress/zlib"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestPortableEmbeddedSRGBJPEGConvertsAndCompresses(t *testing.T) {
	profile, err := os.ReadFile("testdata/srgb.icc")
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err = jpeg.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 4, 2)), nil); err != nil {
		t.Fatal(err)
	}
	payload := append([]byte("ICC_PROFILE\x00\x01\x01"), profile...)
	segment := append([]byte{0xff, 0xe2, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}, payload...)
	data := append([]byte{}, encoded.Bytes()[:2]...)
	data = append(data, segment...)
	data = append(data, encoded.Bytes()[2:]...)
	path := filepath.Join(t.TempDir(), "srgb.jpg")
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	service := New(t.TempDir())
	defer service.Close()
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	result := call(t, service, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "srgb.png", Settings: settings{TargetFormat: "png", Quality: 90}}).(Result)
	if result.Width != 4 || result.Height != 2 || len(imageProperties(result.OutputPath).profile) != 0 {
		t.Fatalf("incorrect normalized output: %+v", result)
	}
}

func TestPortableDisplayP3ConvertsSixteenBitColorAndAlpha(t *testing.T) {
	profile, err := os.ReadFile("testdata/display-p3.icc")
	if err != nil {
		t.Fatal(err)
	}
	img := image.NewNRGBA64(image.Rect(0, 0, 2, 1))
	img.SetNRGBA64(0, 0, color.NRGBA64{R: 0x4040, G: 0xa123, B: 0x6060, A: 0xffff})
	img.SetNRGBA64(1, 0, color.NRGBA64{R: 0x4040, G: 0xa123, B: 0x6060, A: 0x8123})
	var encoded, compressed bytes.Buffer
	png.Encode(&encoded, img)
	z := zlib.NewWriter(&compressed)
	z.Write(profile)
	z.Close()
	data := append([]byte{}, encoded.Bytes()[:33]...)
	data = append(data, pngChunk("iCCP", append([]byte("Display P3\x00\x00"), compressed.Bytes()...))...)
	data = append(data, encoded.Bytes()[33:]...)
	path := filepath.Join(t.TempDir(), "p3.png")
	os.WriteFile(path, data, 0600)
	converted, _, err := decode(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	a := color.NRGBA64Model.Convert(converted.At(0, 0)).(color.NRGBA64)
	b := color.NRGBA64Model.Convert(converted.At(1, 0)).(color.NRGBA64)
	if !highBitDepth(converted) || a.R > 1000 || abs(int(a.G)-42000) > 1500 || abs(int(a.B)-23000) > 1500 || a.G%257 == 0 {
		t.Fatalf("incorrect P3 conversion: %+v", a)
	}
	if b.A != 0x8123 || a.G != b.G || a.B != b.B {
		t.Fatalf("alpha or straight RGB changed: %+v %+v", a, b)
	}
}
