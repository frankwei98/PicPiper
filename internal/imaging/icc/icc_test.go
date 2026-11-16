package icc

import (
	"context"
	"errors"
	"image"
	"image/color"
	"os"
	"sync"
	"testing"
)

func TestRGBLUTProfileUsesItsLookupTable(t *testing.T) {
	profile, err := os.ReadFile("../testdata/rgb-lut.icc")
	if err != nil {
		t.Fatal(err)
	}
	src := image.NewNRGBA(image.Rect(3, 4, 5, 5))
	src.SetNRGBA(3, 4, color.NRGBA{R: 220, G: 30, B: 90, A: 255})
	src.SetNRGBA(4, 4, color.NRGBA{R: 10, G: 180, B: 240, A: 128})
	result, err := Normalize(context.Background(), src, profile, false)
	if err != nil {
		t.Fatal(err)
	}
	first := color.NRGBAModel.Convert(result.At(0, 0)).(color.NRGBA)
	second := color.NRGBAModel.Convert(result.At(1, 0)).(color.NRGBA)
	if first.R != second.R || first.G != second.G || first.B != second.B || first.A != 255 || second.A != 128 {
		t.Fatalf("LUT or alpha ignored: %+v %+v", first, second)
	}
}

func TestProfilesRejectMalformedInputAndSupportCancellation(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	if _, err := Normalize(context.Background(), src, []byte("invalid profile"), false); err == nil {
		t.Fatal("invalid profile accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	profile, err := os.ReadFile("../testdata/srgb.icc")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Normalize(ctx, src, profile, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestConcurrentTransformsUseIndependentInstances(t *testing.T) {
	profile, err := os.ReadFile("../testdata/srgb.icc")
	if err != nil {
		t.Fatal(err)
	}
	var jobs sync.WaitGroup
	for range 8 {
		jobs.Go(func() {
			src := image.NewNRGBA64(image.Rect(0, 0, 2, 1))
			src.SetNRGBA64(0, 0, color.NRGBA64{R: 0x4123, G: 0xa123, B: 0x6123, A: 0x8123})
			result, err := Normalize(context.Background(), src, profile, true)
			if err != nil {
				t.Error(err)
				return
			}
			got := color.NRGBA64Model.Convert(result.At(0, 0)).(color.NRGBA64)
			if abs(int(got.R)-0x4123) > 3 || got.A != 0x8123 {
				t.Errorf("sRGB samples changed: %+v", got)
			}
		})
	}
	jobs.Wait()
}
func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
