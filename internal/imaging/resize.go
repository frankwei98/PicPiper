package imaging

import (
	"image"
	"image/color"

	imagedraw "golang.org/x/image/draw"
)

const resizeScratchLimit = 16 << 20

func resizePreservingDepth(src image.Image, width, height int) image.Image {
	bounds := image.Rect(0, 0, width, height)
	if highBitDepth(src) {
		dst := image.NewNRGBA64(bounds)
		scaleImage(dst, src, true)
		return dst
	}
	return resize(src, width, height)
}

func resize(src image.Image, width, height int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, width, height))
	scaleImage(dst, src, false)
	return dst
}

type resizeTarget interface {
	imagedraw.Image
	imagedraw.RGBA64Image
}

func scaleImage(dst resizeTarget, src image.Image, preserve16Bit bool) {
	target := dst.Bounds()
	for {
		bounds := src.Bounds()
		// The kernel allocates four float64s per target column and source
		// row, plus horizontal and vertical contribution tables.
		scratch := 32*int64(target.Dx())*int64(bounds.Dy()) +
			80*(int64(bounds.Dx())+int64(bounds.Dy())) + 24*(int64(target.Dx())+int64(target.Dy()))
		if scratch <= resizeScratchLimit {
			imagedraw.CatmullRom.Scale(dst, target, src, bounds, imagedraw.Src, nil)
			return
		}
		width := max(target.Dx(), (bounds.Dx()+1)/2)
		height := max(target.Dy(), (bounds.Dy()+1)/2)
		if width == target.Dx() && height == target.Dy() {
			scaleBilinear(dst, src)
			return
		}
		// Reduce by at most 2x per step so large downscales still sample the
		// whole image. Each pass works in premultiplied color, including edges.
		stage := image.Rect(0, 0, width, height)
		var next resizeTarget
		if preserve16Bit {
			next = image.NewNRGBA64(stage)
		} else {
			next = image.NewNRGBA(stage)
		}
		scaleBilinear(next, src)
		src = next
	}
}

func scaleBilinear(dst resizeTarget, src image.Image) {
	bounds, target := src.Bounds(), dst.Bounds()
	at := func(x, y int) color.RGBA64 {
		r, g, b, a := src.At(x, y).RGBA()
		return color.RGBA64{R: uint16(r), G: uint16(g), B: uint16(b), A: uint16(a)}
	}
	if typed, ok := src.(image.RGBA64Image); ok {
		at = typed.RGBA64At
	}
	xScale := float64(bounds.Dx()) / float64(target.Dx())
	yScale := float64(bounds.Dy()) / float64(target.Dy())
	for y := range target.Dy() {
		yPosition := (float64(y)+0.5)*yScale - 0.5
		y0 := min(bounds.Max.Y-1, bounds.Min.Y+int(yPosition))
		y1 := min(bounds.Max.Y-1, y0+1)
		yWeight := max(0, yPosition-float64(y0-bounds.Min.Y))
		for x := range target.Dx() {
			xPosition := (float64(x)+0.5)*xScale - 0.5
			x0 := min(bounds.Max.X-1, bounds.Min.X+int(xPosition))
			x1 := min(bounds.Max.X-1, x0+1)
			xWeight := max(0, xPosition-float64(x0-bounds.Min.X))
			topLeft, topRight := at(x0, y0), at(x1, y0)
			bottomLeft, bottomRight := at(x0, y1), at(x1, y1)
			// SetRGBA64 avoids boxing a color.Color for every output pixel.
			dst.SetRGBA64(target.Min.X+x, target.Min.Y+y, color.RGBA64{
				R: bilinearChannel(topLeft.R, topRight.R, bottomLeft.R, bottomRight.R, xWeight, yWeight),
				G: bilinearChannel(topLeft.G, topRight.G, bottomLeft.G, bottomRight.G, xWeight, yWeight),
				B: bilinearChannel(topLeft.B, topRight.B, bottomLeft.B, bottomRight.B, xWeight, yWeight),
				A: bilinearChannel(topLeft.A, topRight.A, bottomLeft.A, bottomRight.A, xWeight, yWeight),
			})
		}
	}
}

func bilinearChannel(topLeft, topRight, bottomLeft, bottomRight uint16, x, y float64) uint16 {
	top := float64(topLeft) + x*(float64(topRight)-float64(topLeft))
	bottom := float64(bottomLeft) + x*(float64(bottomRight)-float64(bottomLeft))
	return uint16(top + y*(bottom-top) + 0.5)
}
