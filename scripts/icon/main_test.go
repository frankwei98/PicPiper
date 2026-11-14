package main

import (
	"image"
	"image/color"
	"testing"
)

func TestAppIconKeepsItsTileOpaqueWithoutFlatteningCorners(t *testing.T) {
	// Cutout tools can leave a visually opaque tile at alpha 254. IconServices
	// then treats the entire tile as foreground and supplies a white enclosure.
	source := image.NewNRGBA(image.Rect(0, 0, 64, 64))
	ink := color.NRGBA{R: 12, G: 13, B: 20, A: 254}
	for y := 6; y < 58; y++ {
		for x := 6; x < 58; x++ {
			source.SetNRGBA(x, y, ink)
		}
	}
	source.SetNRGBA(5, 32, color.NRGBA{R: 12, G: 13, B: 20, A: 128})
	output := renderAppIcon(source, 64)
	want := ink
	want.A = 255
	if got := output.NRGBAAt(32, 12); got != want {
		t.Fatalf("tile is not opaque or its color changed: got %+v want %+v", got, want)
	}
	if got := output.NRGBAAt(0, 0); got.A != 0 {
		t.Fatalf("transparent corner was flattened: %+v", got)
	}
	if got := output.NRGBAAt(5, 32); got.A != 128 {
		t.Fatalf("antialiased edge was made opaque: %+v", got)
	}
}
