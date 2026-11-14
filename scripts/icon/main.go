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

	appIcon := renderAppIcon(app, 1024)
	appPath := "resources/icon.png"
	if len(os.Args) == 2 {
		appPath = os.Args[1]
	}
	if err := writePNG(appPath, appIcon); err != nil {
		log.Fatal(err)
	}
	uiIcon := renderAppIcon(app, 96)
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
	statusBounds, ok := alphaBoundsAbove(tray, 16)
	if !ok {
		log.Fatal("resources/logo-tray.png has no visible status mark")
	}
	statusMark := blackWithAlphaAbove(tray, statusBounds, 16)
	if err := writePNG("resources/status-icon.png", makeStatusIcon(statusMark)); err != nil {
		log.Fatal(err)
	}
}

func renderAppIcon(source image.Image, size int) *image.NRGBA {
	output := image.NewNRGBA(image.Rect(0, 0, size, size))
	xdraw.CatmullRom.Scale(output, output.Bounds(), source, source.Bounds(), stdDraw.Over, nil)
	// Keep the intended solid tile opaque. Almost-opaque cutout pixels can make
	// modern macOS wrap the artwork in its own white background. Preserve true
	// transparency and antialiasing at the rounded corners, and leave RGB intact.
	for offset := 3; offset < len(output.Pix); offset += 4 {
		if output.Pix[offset] >= 245 {
			output.Pix[offset] = 255
		}
	}
	return output
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
	return alphaBoundsAbove(img, 0)
}

func alphaBoundsAbove(img image.Image, threshold uint8) (image.Rectangle, bool) {
	bounds := img.Bounds()
	minX, minY, maxX, maxY := bounds.Max.X, bounds.Max.Y, bounds.Min.X, bounds.Min.Y
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if uint8(a>>8) <= threshold {
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
	return blackWithAlphaAbove(img, bounds, 0)
}

func blackWithAlphaAbove(img image.Image, bounds image.Rectangle, threshold uint8) *image.NRGBA {
	mono := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			alpha := uint8(a >> 8)
			if alpha <= threshold {
				continue
			}
			mono.SetNRGBA(x-bounds.Min.X, y-bounds.Min.Y, color.NRGBA{A: alpha})
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

func makeStatusIcon(mark image.Image) *image.NRGBA {
	// MyGo sizes the entire image to 18pt high, so fit by height and keep only
	// a small inset. A square canvas makes this wide mark unnecessarily small.
	const canvasHeight = 64
	const inset = 2
	const markHeight = canvasHeight - 2*inset
	bounds := mark.Bounds()
	markWidth := max(1, int(math.Round(float64(markHeight)*float64(bounds.Dx())/float64(bounds.Dy()))))
	canvasWidth := markWidth + 2*inset
	canvas := image.NewNRGBA(image.Rect(0, 0, canvasWidth, canvasHeight))
	left := (canvasWidth - markWidth) / 2
	top := (canvasHeight - markHeight) / 2
	xdraw.CatmullRom.Scale(canvas, image.Rect(left, top, left+markWidth, top+markHeight), mark, bounds, stdDraw.Over, nil)
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
