package imaging

import (
	"image"
	"image/color"
	"image/png"
	"io"
)

// encodePNG keeps 8-bit YUV-decoded images on the 8-bit PNG path. The standard
// encoder otherwise recognizes YCbCr's 16-bit Color.RGBA values and emits a
// 16-bit PNG after allocating a color value for every pixel.
func encodePNG(w io.Writer, img image.Image) error {
	switch img.(type) {
	case *image.YCbCr, *image.NYCbCrA:
		img = yuvToNRGBA(img)
	}
	return (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(w, img)
}

func yuvToNRGBA(src image.Image) *image.NRGBA {
	bounds := src.Bounds()
	dst := image.NewNRGBA(bounds)
	set := func(x, y int, ycbcr color.YCbCr, alpha uint8) {
		r, g, b := color.YCbCrToRGB(ycbcr.Y, ycbcr.Cb, ycbcr.Cr)
		offset := dst.PixOffset(x, y)
		dst.Pix[offset+0] = r
		dst.Pix[offset+1] = g
		dst.Pix[offset+2] = b
		dst.Pix[offset+3] = alpha
	}
	switch src := src.(type) {
	case *image.YCbCr:
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				set(x, y, src.YCbCrAt(x, y), 0xff)
			}
		}
	case *image.NYCbCrA:
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				pixel := src.NYCbCrAAt(x, y)
				set(x, y, pixel.YCbCr, pixel.A)
			}
		}
	}
	return dst
}
