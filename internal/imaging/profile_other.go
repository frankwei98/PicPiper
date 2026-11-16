//go:build !darwin || !cgo

package imaging

import (
	"context"
	_ "embed"
	"image"

	"github.com/frankwei98/PicPiper/internal/imaging/icc"
)

//go:embed testdata/display-p3.icc
var portableDisplayP3 []byte

func displayP3Profile() []byte { return portableDisplayP3 }

func normalizeProfile(src image.Image, profile []byte) (image.Image, error) {
	return icc.Normalize(context.Background(), src, profile, highBitDepth(src))
}
