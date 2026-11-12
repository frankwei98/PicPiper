//go:build !cgo || !nativeavif

package imaging

import (
	"image"
	"io"

	"github.com/gen2brain/avif"
)

func encodeAVIF(writer io.Writer, img image.Image, quality int) error {
	codecMu.Lock()
	defer codecMu.Unlock()
	return avif.Encode(writer, img, avif.Options{
		Quality: quality, QualityAlpha: 100, Speed: 6,
		ChromaSubsampling: image.YCbCrSubsampleRatio444,
	})
}
