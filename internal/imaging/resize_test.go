package imaging

import (
	"context"
	"image"
	"image/color"
	"runtime"
	"strings"
	"testing"
)

func TestResizeFitsLongestEdgeWithoutCroppingOrUpscaling(t *testing.T) {
	for _, tc := range []struct{ width, height, limit, wantWidth, wantHeight int }{
		{600, 400, 128, 128, 85},
		{400, 600, 128, 85, 128},
		{60, 40, 128, 60, 40},
		{600, 1, 128, 128, 1},
	} {
		source := fixture(t, image.NewNRGBA(image.Rect(0, 0, tc.width, tc.height)))
		service := New(t.TempDir())
		run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
		result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "resized.png", Settings: settings{TargetFormat: "png", MaxDimension: tc.limit}}).(Result)
		img, _, err := decode(context.Background(), result.OutputPath)
		if err != nil || img.Bounds().Dx() != tc.wantWidth || img.Bounds().Dy() != tc.wantHeight || result.Width != tc.wantWidth || result.Height != tc.wantHeight {
			t.Fatalf("%+v: unexpected resize result %+v %v", tc, result, err)
		}
		if tc.width > tc.limit && !strings.Contains(result.Warning, "without cropping") {
			t.Fatal("resize must be visible in result feedback")
		}
	}
}

func TestDownsamplingFiltersFineDetailAndPreservesTransparentColors(t *testing.T) {
	checker := image.NewNRGBA(image.Rect(0, 0, 128, 128))
	for y := 0; y < 128; y++ {
		for x := 0; x < 128; x++ {
			value := uint8(0)
			if (x+y)%2 == 0 {
				value = 255
			}
			checker.SetNRGBA(x, y, color.NRGBA{R: value, G: value, B: value, A: 255})
		}
	}
	filtered := resize(checker, 8, 8)
	for _, pixel := range []image.Point{{1, 1}, {4, 4}, {6, 6}} {
		value := filtered.NRGBAAt(pixel.X, pixel.Y)
		if value.R < 110 || value.R > 145 || value.A != 255 {
			t.Fatalf("fine detail aliased rather than being filtered: %+v", value)
		}
	}
	alpha := image.NewNRGBA(image.Rect(0, 0, 32, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			alpha.SetNRGBA(x, y, color.NRGBA{R: 255, A: 255})
		}
	}
	edge := resize(alpha, 8, 4).NRGBAAt(3, 2)
	if edge.A == 0 || edge.R < 245 || edge.G != 0 || edge.B != 0 {
		t.Fatalf("transparent edge gained a dark fringe: %+v", edge)
	}
}

func TestLargeResizePreserves16BitColorAndAlpha(t *testing.T) {
	source := image.NewNRGBA64(image.Rect(0, 0, 1400, 800))
	pixel := color.NRGBA64{R: 60001, G: 32019, B: 12345, A: 34827}
	for y := range 800 {
		for x := range 700 {
			source.SetNRGBA64(x, y, pixel)
		}
	}
	got := resizePreservingDepth(source, 1300, 743).(*image.NRGBA64)
	if result := got.NRGBA64At(100, 100); abs(int(result.R)-int(pixel.R)) > 4 ||
		abs(int(result.G)-int(pixel.G)) > 4 || abs(int(result.B)-int(pixel.B)) > 4 || result.A != pixel.A {
		t.Fatalf("bounded resize lost color precision or alpha: %+v", result)
	}
	if result := got.NRGBA64At(1000, 100); result.A != 0 {
		t.Fatalf("bounded resize changed transparent area: %+v", result)
	}
}

func TestLargeResizeFiltersFineStripesAt1920Preset(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 3648, 1824))
	for y := range source.Bounds().Dy() {
		for x := range source.Bounds().Dx() {
			grey := uint8(x % 2 * 255)
			source.SetNRGBA(x, y, color.NRGBA{R: grey, G: grey, B: grey, A: 255})
		}
	}
	result := resize(source, 1920, 960)
	for x := 16; x < 1904; x++ {
		if grey := result.NRGBAAt(x, 480).R; grey < 110 || grey > 145 {
			t.Fatalf("large resize aliased fine detail at column %d: %d", x, grey)
		}
	}
}

func TestLargeThumbnailResizeDoesNotAllocateAnIntermediateImage(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 6000, 6000))
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	thumbnail := resize(source, 96, 96)
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(thumbnail)
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 4<<20 {
		t.Fatalf("96px resize allocated %d bytes for an already decoded image", allocated)
	}
}
