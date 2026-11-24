package imaging

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"testing"

	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/gen2brain/webp"
)

func TestLongAnimatedWebPAllowsPreviewAndFirstFrameExport(t *testing.T) {
	const frameCount = 121
	frames := make([]image.Image, frameCount)
	delays := make([]int, frameCount)
	for i := range frames {
		frame := image.NewNRGBA(image.Rect(0, 0, 1, 1))
		frame.SetNRGBA(0, 0, color.NRGBA{R: uint8(220 - i%2), G: 40, B: 10, A: 255})
		frames[i] = frame
		delays[i] = 10
	}
	var encoded bytes.Buffer
	if err := webp.EncodeAll(&encoded, &webp.WEBP{Image: frames, Delay: delays, LoopCount: 0}, webp.Options{Quality: 100, Method: 4, Lossless: true}); err != nil {
		t.Fatal(err)
	}

	source := filepath.Join(t.TempDir(), "long-animation.webp")
	if err := os.WriteFile(source, encoded.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)

	inspection := call(t, service, "inspect_image", request{Path: source}).(map[string]any)
	if inspection["animated"] != true || inspection["frameCount"] != float64(frameCount) {
		t.Fatalf("inspection did not report all animation frames: %+v", inspection)
	}
	thumbnail := call(t, service, "read_thumbnail", request{Path: source, MaxSize: 32}).(map[string]any)
	if thumbnail["dataUrl"] == nil || thumbnail["dataUrl"] == "" {
		t.Fatal("animated WebP did not produce a thumbnail")
	}
	comparison := call(t, service, "read_comparison_image", request{TaskID: "long-webp", Path: source}).(ComparisonImage)
	if got := decodeComparison(t, service, comparison).Bounds(); got.Dx() != 1 || got.Dy() != 1 {
		t.Fatalf("comparison has incorrect dimensions: %v", got)
	}

	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	preserveRequest := request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "preserved.webp", Settings: settings{TargetFormat: "webp", Quality: 80}}
	payload, err := json.Marshal(preserveRequest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Call(context.Background(), "compress_image", payload); err == nil {
		t.Fatal("preserving an animation over 120 frames unexpectedly succeeded")
	} else if businessError, ok := err.(*apperror.Error); !ok || businessError.Code != "animationDecodeFailed" {
		t.Fatalf("preserving an over-limit animation returned %T %v, want animationDecodeFailed", err, err)
	}

	result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "first.webp", Settings: settings{TargetFormat: "webp", Quality: 80, AnimationMode: "firstFrame"}}).(map[string]any)
	outputPath, ok := result["outputPath"].(string)
	if !ok || outputPath == "" {
		t.Fatalf("first-frame export did not return an output path: %+v", result)
	}
	output, info, err := decode(context.Background(), outputPath)
	if err != nil || info.Animated || output.Bounds().Dx() != 1 || output.Bounds().Dy() != 1 {
		t.Fatalf("first-frame WebP output is invalid: info=%+v image=%v err=%v", info, output, err)
	}
	pixel := color.NRGBAModel.Convert(output.At(0, 0)).(color.NRGBA)
	if pixel.R < 180 || pixel.G > 80 || pixel.B > 50 || pixel.A != 255 {
		t.Fatalf("first-frame WebP has unexpected pixel: %+v", pixel)
	}
}
