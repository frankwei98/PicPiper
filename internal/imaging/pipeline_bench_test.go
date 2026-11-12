package imaging

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkIsolatedImagePipeline includes the public service's inspection,
// original preview, compression, and actual encoded-output preview. This catches
// process startup and WASM compilation costs excluded by BenchmarkEncodeFormats.
func BenchmarkIsolatedImagePipeline(b *testing.B) {
	fixture := image.NewRGBA(image.Rect(0, 0, 1200, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 1200; x++ {
			fixture.SetRGBA(x, y, color.RGBA{R: uint8(30 + x*160/1200), G: uint8(65 + y*120/800), B: uint8(150 + (x+y)%80), A: 255})
		}
	}
	source := filepath.Join(b.TempDir(), "fixture.jpg")
	file, err := os.Create(source)
	if err != nil {
		b.Fatal(err)
	}
	err = jpeg.Encode(file, fixture, &jpeg.Options{Quality: 98})
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		b.Fatalf("fixture encoding: %v, close: %v", err, closeErr)
	}
	for _, format := range []string{"png", "webp", "avif", "jxl"} {
		for _, mode := range []string{"cold", "warm"} {
			b.Run(format+"/"+mode, func(b *testing.B) {
				dataDir := b.TempDir()
				newService := func() (*Service, string) {
					service := NewIsolated(dataDir)
					value, err := service.Call(context.Background(), "create_optimizer_run", json.RawMessage(`{}`))
					if err != nil {
						service.Close()
						b.Fatal(err)
					}
					return service, value.(map[string]string)["outputDir"]
				}
				pipeline := func(service *Service, outputDir string) {
					invoke := func(operation string, req request) any {
						payload, err := json.Marshal(req)
						if err != nil {
							b.Fatal(err)
						}
						value, err := service.Call(context.Background(), operation, payload)
						if err != nil {
							b.Fatal(err)
						}
						return value
					}
					invoke("inspect_image", request{Path: source})
					invoke("read_thumbnail", request{Path: source, MaxSize: 1024})
					result := invoke("compress_image", request{SourcePath: source, OutputDir: outputDir, OutputFileName: "fixture." + format, Settings: settings{TargetFormat: format, Quality: 85}}).(map[string]any)
					invoke("read_thumbnail", request{Path: result["outputPath"].(string), MaxSize: 1024})
					b.ReportMetric(result["outputBytes"].(float64), "bytes/output")
				}
				if mode == "warm" {
					service, outputDir := newService()
					b.Cleanup(service.Close)
					pipeline(service, outputDir)
					for b.Loop() {
						pipeline(service, outputDir)
					}
				} else {
					for b.Loop() {
						service, outputDir := newService()
						pipeline(service, outputDir)
						service.Close()
					}
				}
			})
		}
	}
}
