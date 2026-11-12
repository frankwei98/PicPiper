// Command icon renders Pic Piper's app icon using only the Go standard library.
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"os"
)

func main() {
	img := image.NewNRGBA(image.Rect(0, 0, 1024, 1024))
	teal := color.NRGBA{R: 20, G: 107, B: 112, A: 255}
	white := color.NRGBA{R: 255, G: 255, B: 255, A: 255}
	round := func(left, top, right, bottom, radius int, fill color.NRGBA) {
		for y := top; y < bottom; y++ {
			for x := left; x < right; x++ {
				cx, cy := min(max(x, left+radius), right-radius), min(max(y, top+radius), bottom-radius)
				dx, dy := x-cx, y-cy
				if dx*dx+dy*dy <= radius*radius {
					img.SetNRGBA(x, y, fill)
				}
			}
		}
	}
	round(64, 64, 960, 960, 196, teal)
	round(218, 192, 716, 690, 60, white)
	round(240, 214, 694, 668, 40, teal)
	round(338, 326, 836, 824, 60, white)
	round(360, 348, 814, 802, 40, teal)
	round(654, 420, 734, 500, 40, white)
	for y := 540; y < 726; y++ {
		for x := 408; x < 766; x++ {
			if y >= 726-(x-408)*186/148 && y >= 540+(x-556)*186/210 {
				img.SetNRGBA(x, y, white)
			}
		}
	}
	path := "resources/icon.png"
	if len(os.Args) == 2 {
		path = os.Args[1]
	}
	file, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	if err := png.Encode(file, img); err != nil {
		log.Fatal(err)
	}
	if err := file.Close(); err != nil {
		log.Fatal(err)
	}
}
