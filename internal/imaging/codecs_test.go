package imaging

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestModernFormatsRoundTripThroughInspectionPreviewComparisonAndExport(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 3), G: uint8(y * 4), B: 100, A: uint8(x * 4)})
		}
	}
	source := fixture(t, img)
	service := New(t.TempDir())
	t.Cleanup(service.Close)
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	for _, format := range []string{"webp", "avif", "jxl"} {
		t.Run(format, func(t *testing.T) {
			started := time.Now()
			quality := 85
			if format == "jxl" {
				quality = 100
			}
			result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "sample." + format, Settings: settings{TargetFormat: format, Quality: quality}}).(Result)
			data, err := os.ReadFile(result.OutputPath)
			if err != nil {
				t.Fatal(err)
			}
			// Check the actual container, independently of the extension/UI DTO.
			if format == "webp" && (len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP") {
				t.Fatal("output is not WebP")
			}
			if format == "avif" && (len(data) < 12 || string(data[4:12]) != "ftypavif") {
				t.Fatal("output is not AVIF")
			}
			if format == "jxl" && !bytes.HasPrefix(data, []byte{0xff, 0x0a}) && !bytes.HasPrefix(data, []byte{0, 0, 0, 12, 'J', 'X', 'L', ' '}) {
				t.Fatal("output is not JPEG XL")
			}
			// Sniff by content even when a file has no recognized extension.
			unknown := filepath.Join(t.TempDir(), "image.data")
			if err := os.WriteFile(unknown, data, 0600); err != nil {
				t.Fatal(err)
			}
			info := call(t, service, "inspect_image", request{Path: unknown}).(Inspection)
			if info.SourceFormat != format || info.Width != 64 || info.Height != 48 {
				t.Fatalf("incorrect inspection: %+v", info)
			}
			decoded, _, err := decode(context.Background(), unknown)
			if err != nil {
				t.Fatal(err)
			}
			for _, x := range []int{0, 20, 63} {
				want := img.NRGBAAt(x, 20)
				got := color.NRGBAModel.Convert(decoded.At(x, 20)).(color.NRGBA)
				if abs(int(got.A)-int(want.A)) > 1 {
					t.Fatalf("alpha changed at %d: got %+v want %+v", x, got, want)
				}
				if x > 0 && format != "jxl" && (abs(int(got.R)-int(want.R)) > 25 || abs(int(got.G)-int(want.G)) > 25 || abs(int(got.B)-int(want.B)) > 25) {
					t.Fatalf("colors changed excessively at %d: got %+v want %+v", x, got, want)
				}
				if format == "jxl" && got != want {
					t.Fatalf("lossless JPEG XL changed pixels: got %+v want %+v", got, want)
				}
			}
			thumb := call(t, service, "read_thumbnail", request{Path: unknown, MaxSize: 32}).(map[string]string)
			if !strings.HasPrefix(thumb["dataUrl"], "data:image/png;base64,") {
				t.Fatal("transparent preview must remain PNG")
			}
			comparison := call(t, service, "read_comparison_image", request{Path: unknown}).(ComparisonImage)
			if preview := decodeComparison(t, service, comparison); preview.Bounds() != img.Bounds() {
				t.Fatalf("comparison did not retain dimensions: %v", preview.Bounds())
			}
			// New formats must work as sources for another encode, not just previews.
			converted := call(t, service, "compress_image", request{SourcePath: unknown, OutputDir: run["outputDir"], OutputFileName: "roundtrip-" + format + ".png", Settings: settings{TargetFormat: "png"}}).(Result)
			if converted.OutputBytes == 0 {
				t.Fatal("empty PNG conversion")
			}
			saved := call(t, service, "copy_outputs_to_dir", request{OutputPaths: []string{result.OutputPath}, TargetDir: t.TempDir()}).([]string)
			exported, err := os.ReadFile(saved[0])
			if err != nil || !bytes.Equal(data, exported) {
				t.Fatalf("export changed the encoded bytes: %v", err)
			}
			t.Logf("%s: %d bytes, roundtrip %s", format, len(data), time.Since(started))
		})
	}
}

func TestModernCodecsRejectCorruptionAndUnsupportedOutput(t *testing.T) {
	service := New(t.TempDir())
	for _, data := range [][]byte{[]byte("RIFF\x20\x00\x00\x00WEBPVP8 garbage"), []byte("\x00\x00\x00\x20ftypavifgarbage"), {0xff, 0x0a, 0, 0}, []byte("\x00\x00\x00\x20ftypheicgarbage")} {
		path := filepath.Join(t.TempDir(), "bad-image")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(request{Path: path})
		if _, err := service.Call(context.Background(), "inspect_image", payload); err == nil {
			t.Fatal("corrupt image was accepted")
		}
	}
	payload, _ := json.Marshal(request{Settings: settings{TargetFormat: "heif"}})
	if _, err := service.Call(context.Background(), "compress_image", payload); err == nil {
		t.Fatal("HEIF encoding must not be advertised without an encoder")
	}
	for _, format := range []string{"heif", "heic", "jpge", ""} {
		var output bytes.Buffer
		if err := encodeModern(&output, image.NewNRGBA(image.Rect(0, 0, 8, 8)), format, 85); err == nil || output.Len() != 0 {
			t.Fatalf("unsupported target %q must not produce another format", format)
		}
	}
}

func TestHEICImportsAndConvertsWithoutNativeTools(t *testing.T) {
	// Generated with macOS ImageIO from our synthetic image, not a personal photo.
	path := filepath.Join("testdata", "sample.heic")
	service := New(t.TempDir())
	info := call(t, service, "inspect_image", request{Path: path}).(Inspection)
	if info.SourceFormat != "heif" || info.Width != 64 || info.Height != 48 {
		t.Fatalf("incorrect HEIC inspection: %+v", info)
	}
	t.Cleanup(service.Close)
	comparison := call(t, service, "read_comparison_image", request{Path: path}).(ComparisonImage)
	if comparison.Width != 64 || comparison.Height != 48 {
		t.Fatalf("incorrect HEIC comparison: %+v", comparison)
	}
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	for _, format := range []string{"png", "webp", "avif", "jxl"} {
		result := call(t, service, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "heic." + format, Settings: settings{TargetFormat: format, Quality: 85}}).(Result)
		output := call(t, service, "inspect_image", request{Path: result.OutputPath}).(Inspection)
		if output.SourceFormat != format || output.Width != 64 || output.Height != 48 {
			t.Fatalf("incorrect HEIC conversion: %+v", output)
		}
	}
}

func TestModernQualityAffectsTheEncodedImage(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 128, 96))
	for y := 0; y < 96; y++ {
		for x := 0; x < 128; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 2), G: uint8(y * 2), B: uint8((x*13 + y*29) % 256), A: 255})
		}
	}
	for _, format := range []string{"webp", "avif", "jxl"} {
		var low, high bytes.Buffer
		if err := encodeModern(&low, img, format, 20); err != nil {
			t.Fatal(err)
		}
		if err := encodeModern(&high, img, format, 90); err != nil {
			t.Fatal(err)
		}
		if high.Len() <= low.Len() || bytes.Equal(low.Bytes(), high.Bytes()) {
			t.Fatalf("%s quality had no expected effect: low=%d high=%d", format, low.Len(), high.Len())
		}
	}
}

func TestModernCodecsConcurrentFirstUse(t *testing.T) {
	// Run this test alone with -race to exercise independent runtime initialization.
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := 0; i < 10; i++ {
		workers.Go(func() {
			<-start
			switch i % 5 {
			case 0, 1:
				format := []string{"avif", "jxl"}[i%5]
				var output bytes.Buffer
				if err := encodeModern(&output, image.NewNRGBA(image.Rect(0, 0, 8, 8)), format, 85); err != nil {
					t.Error(err)
					return
				}
				if format == "avif" {
					decoded, err := decodePixels(bytes.NewReader(output.Bytes()), format)
					if err != nil || decoded.Bounds() != image.Rect(0, 0, 8, 8) {
						t.Errorf("concurrent AVIF roundtrip: %v", err)
					}
				}
			case 2:
				// Even corrupt inputs initialize the registered JPEG XL decoder.
				_, _, _ = decodeConfig(bytes.NewReader([]byte{0xff, 0x0a, 0, 0}))
			case 3:
				file, err := os.Open(filepath.Join("testdata", "sample.heic"))
				if err != nil {
					t.Error(err)
					return
				}
				defer file.Close()
				if _, err := decodePixels(file, "heic"); err != nil {
					t.Error(err)
				}
			case 4:
				img := image.NewNRGBA(image.Rect(0, 0, 16, 8))
				img.SetNRGBA(4, 4, color.NRGBA{R: 170, G: 80, B: 30, A: 200})
				var output bytes.Buffer
				if err := encodeModern(&output, img, "webp", 85); err != nil {
					t.Error(err)
					return
				}
				cfg, format, err := decodeConfig(bytes.NewReader(output.Bytes()))
				if err != nil || format != "webp" || cfg.Width != 16 || cfg.Height != 8 {
					t.Errorf("concurrent WebP inspection: %+v %s %v", cfg, format, err)
				}
				decoded, err := decodePixels(bytes.NewReader(output.Bytes()), "webp")
				if err != nil || decoded.Bounds() != img.Bounds() {
					t.Errorf("concurrent WebP decode: %v", err)
				}
			}
		})
	}
	close(start)
	workers.Wait()
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
