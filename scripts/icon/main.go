// Command icon packages the supplied app and menu bar logo masters as PNG icons.
package main

import (
	"fmt"
	"image"
	"image/color"
	stdDraw "image/draw"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"

	xdraw "golang.org/x/image/draw"
)

func main() {
	if len(os.Args) > 2 {
		log.Fatal("usage: go run ./scripts/icon [app-icon-output.png]")
	}
	app, err := readPNG("resources/logo-app.png")
	if err != nil {
		log.Fatal(err)
	}
	tray, err := readPNG("resources/logo-tray.png")
	if err != nil {
		log.Fatal(err)
	}
	if _, ok := alphaBounds(app); !ok {
		log.Fatal("resources/logo-app.png has no visible pixels")
	}
	trayBounds, ok := alphaBounds(tray)
	if !ok || trayBounds.Dx() < 32 || trayBounds.Dy() < 32 || nontransparentPixels(tray) < 1024 || !hasTransparency(tray) {
		log.Fatal("resources/logo-tray.png has no usable visible mark")
	}

	appIcon := image.NewNRGBA(image.Rect(0, 0, 1024, 1024))
	xdraw.CatmullRom.Scale(appIcon, appIcon.Bounds(), app, app.Bounds(), stdDraw.Over, nil)
	appPath := "resources/icon.png"
	if len(os.Args) == 2 {
		appPath = os.Args[1]
	}
	if err := writePNG(appPath, appIcon); err != nil {
		log.Fatal(err)
	}
	uiIcon := image.NewNRGBA(image.Rect(0, 0, 96, 96))
	xdraw.CatmullRom.Scale(uiIcon, uiIcon.Bounds(), app, app.Bounds(), stdDraw.Over, nil)
	if err := writePNG("resources/logo-ui.png", uiIcon); err != nil {
		log.Fatal(err)
	}

	monoTray := blackWithAlpha(tray, trayBounds)
	if err := writePNG("resources/tray.png", makeTrayIcon(monoTray, 32, 28)); err != nil {
		log.Fatal(err)
	}
	if err := writePNG("resources/tray@2x.png", makeTrayIcon(monoTray, 64, 56)); err != nil {
		log.Fatal(err)
	}
}

func readPNG(path string) (image.Image, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer file.Close()
	img, err := png.Decode(file)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return img, nil
}

func alphaBounds(img image.Image) (image.Rectangle, bool) {
	bounds := img.Bounds()
	minX, minY, maxX, maxY := bounds.Max.X, bounds.Max.Y, bounds.Min.X, bounds.Min.Y
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			if x < minX {
				minX = x
			}
			if y < minY {
				minY = y
			}
			if x+1 > maxX {
				maxX = x + 1
			}
			if y+1 > maxY {
				maxY = y + 1
			}
		}
	}
	if maxX <= minX || maxY <= minY {
		return image.Rectangle{}, false
	}
	return image.Rect(minX, minY, maxX, maxY), true
}

func nontransparentPixels(img image.Image) int {
	count := 0
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a != 0 {
				count++
			}
		}
	}
	return count
}

func hasTransparency(img image.Image) bool {
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a == 0 {
				return true
			}
		}
	}
	return false
}

func blackWithAlpha(img image.Image, bounds image.Rectangle) *image.NRGBA {
	mono := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			mono.SetNRGBA(x-bounds.Min.X, y-bounds.Min.Y, color.NRGBA{A: uint8(a >> 8)})
		}
	}
	return mono
}

func makeTrayIcon(mark image.Image, canvasSize, markMax int) *image.NRGBA {
	canvas := image.NewNRGBA(image.Rect(0, 0, canvasSize, canvasSize))
	bounds := mark.Bounds()
	scale := float64(markMax) / float64(max(bounds.Dx(), bounds.Dy()))
	width := max(1, int(math.Round(float64(bounds.Dx())*scale)))
	height := max(1, int(math.Round(float64(bounds.Dy())*scale)))
	left := (canvasSize - width) / 2
	top := (canvasSize - height) / 2
	xdraw.CatmullRom.Scale(canvas, image.Rect(left, top, left+width, top+height), mark, bounds, stdDraw.Over, nil)
	return canvas
}

func writePNG(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	if err := png.Encode(file, img); err != nil {
		file.Close()
		return fmt.Errorf("encode %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	return nil
}
