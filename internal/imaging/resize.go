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
		scaleImage(dst, src)
		return dst
	}
	return resize(src, width, height)
}

func resize(src image.Image, width, height int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, width, height))
	scaleImage(dst, src)
	return dst
}

type resizeTarget interface {
	imagedraw.Image
	imagedraw.RGBA64Image
}

func scaleImage(dst resizeTarget, src image.Image) {
	target, bounds := dst.Bounds(), src.Bounds()
	// The kernel allocates four float64s per target column and source row,
	// plus horizontal and vertical contribution tables.
	scratch := 32*int64(target.Dx())*int64(bounds.Dy()) +
		80*(int64(bounds.Dx())+int64(bounds.Dy())) + 24*(int64(target.Dx())+int64(target.Dy()))
	if scratch <= resizeScratchLimit {
		imagedraw.CatmullRom.Scale(dst, target, src, bounds, imagedraw.Src, nil)
		return
	}
	scaleArea(dst, src)
}

// Area averaging covers every source pixel in the destination pixel's
// footprint. Integer overlap weights preserve fractional edges and avoid a
// full intermediate image. RGBA64 reads and writes use premultiplied color.
func scaleArea(dst resizeTarget, src image.Image) {
	bounds, target := src.Bounds(), dst.Bounds()
	at := func(x, y int) color.RGBA64 {
		r, g, b, a := src.At(x, y).RGBA()
		return color.RGBA64{R: uint16(r), G: uint16(g), B: uint16(b), A: uint16(a)}
	}
	if typed, ok := src.(image.RGBA64Image); ok {
		at = typed.RGBA64At
	}
	srcWidth, srcHeight := int64(bounds.Dx()), int64(bounds.Dy())
	dstWidth, dstHeight := int64(target.Dx()), int64(target.Dy())
	area := uint64(srcWidth * srcHeight)
	for y := range dstHeight {
		top, bottom := y*srcHeight, (y+1)*srcHeight
		for x := range dstWidth {
			left, right := x*srcWidth, (x+1)*srcWidth
			var r, g, b, a uint64
			for row := top / dstHeight; row*dstHeight < bottom; row++ {
				rowWeight := uint64(min(bottom, (row+1)*dstHeight) - max(top, row*dstHeight))
				for col := left / dstWidth; col*dstWidth < right; col++ {
					weight := rowWeight * uint64(min(right, (col+1)*dstWidth)-max(left, col*dstWidth))
					pixel := at(bounds.Min.X+int(col), bounds.Min.Y+int(row))
					r += uint64(pixel.R) * weight
					g += uint64(pixel.G) * weight
					b += uint64(pixel.B) * weight
					a += uint64(pixel.A) * weight
				}
			}
			dst.SetRGBA64(target.Min.X+int(x), target.Min.Y+int(y), color.RGBA64{
				R: uint16((r + area/2) / area),
				G: uint16((g + area/2) / area),
				B: uint16((b + area/2) / area),
				A: uint16((a + area/2) / area),
			})
		}
	}
}
