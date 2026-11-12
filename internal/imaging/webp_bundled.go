//go:build !cgo || !nativewebp

package imaging

import (
	"image"
	"io"

	"github.com/gen2brain/webp"
)

func encodeWebP(writer io.Writer, img image.Image, quality int) error {
	return webp.Encode(writer, img, webp.Options{Quality: quality, Method: 4, Exact: true})
}
