//go:build !darwin || !cgo

package imaging

import (
	"fmt"
	"image"
)

func displayP3Profile() []byte { return nil }

func normalizeProfile(src image.Image, profile []byte) (image.Image, error) {
	return nil, fmt.Errorf("embedded color profile conversion requires the macOS build")
}
