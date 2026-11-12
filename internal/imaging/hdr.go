package imaging

import (
	"context"
	"fmt"
	"image"
	"image/color"
	"math"
	"sync"
)

var hdrCurves struct {
	once sync.Once
	pq   [65536]float64
	hlg  [65536]float64
}

// pqNits implements the SMPTE ST 2084 EOTF, with output in absolute cd/m².
func pqNits(encoded float64) float64 {
	const m1, m2 = 2610.0 / 16384, 2523.0 / 32
	const c1, c2, c3 = 3424.0 / 4096, 2413.0 / 128, 2392.0 / 128
	p := math.Pow(encoded, 1/m2)
	return 10000 * math.Pow(math.Max(p-c1, 0)/(c2-c3*p), 1/m1)
}

// hlgScene implements the ARIB STD-B67 inverse OETF. The BT.2100 OOTF is
// applied to the pixel's scene luminance below, for a 1000-nit reference display.
func hlgScene(encoded float64) float64 {
	if encoded <= 0.5 {
		return encoded * encoded / 3
	}
	const a, b, c = 0.17883277, 0.28466892, 0.55991073
	return (math.Exp((encoded-c)/a) + b) / 12
}

func hdrBasis(primaries uint16) ([3]float64, [3][3]float64, error) {
	switch primaries {
	case 1: // BT.709 / sRGB, D65.
		return [3]float64{0.2126, 0.7152, 0.0722}, [3][3]float64{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}, nil
	case 9: // BT.2020, D65 -> linear sRGB.
		return [3]float64{0.2627, 0.6780, 0.0593}, [3][3]float64{{1.660491, -0.587641, -0.072850}, {-0.124550, 1.132900, -0.008349}, {-0.018151, -0.100579, 1.118730}}, nil
	case 12: // Display P3, D65 -> linear sRGB.
		return [3]float64{0.228975, 0.691739, 0.079287}, [3][3]float64{{1.224940, -0.224940, 0}, {-0.042057, 1.042057, 0}, {-0.019638, -0.078636, 1.098274}}, nil
	default:
		return [3]float64{}, [3][3]float64{}, fmt.Errorf("unrecognized HDR color primaries")
	}
}

func srgbSample(linear float64) uint16 {
	linear = math.Max(0, math.Min(1, linear))
	encoded := linear * 12.92
	if linear > 0.0031308 {
		encoded = 1.055*math.Pow(linear, 1/2.4) - 0.055
	}
	return uint16(math.Round(encoded * 65535))
}

func toneMapHDR(ctx context.Context, src image.Image, metadata sourceProperties) (image.Image, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	weights, matrix, err := hdrBasis(metadata.hdrPrimaries)
	if err != nil {
		return nil, err
	}
	hdrCurves.once.Do(func() {
		for i := range hdrCurves.pq {
			encoded := float64(i) / 65535
			hdrCurves.pq[i], hdrCurves.hlg[i] = pqNits(encoded), hlgScene(encoded)
		}
	})
	curve := &hdrCurves.pq
	peak := 10000.0
	if metadata.hdrTransfer == 18 {
		curve, peak = &hdrCurves.hlg, 1000
	}
	bounds := src.Bounds()
	output := image.NewNRGBA64(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	// Extended Reinhard maps luminance rather than individual channels, retaining
	// hue through the highlight shoulder. Reference white is 203 nits; exposure
	// of two keeps diffuse white bright while reserving room for highlights.
	const referenceWhite, exposure = 203.0, 2.0
	white := peak / referenceWhite * exposure
	for y := 0; y < bounds.Dy(); y++ {
		if y%32 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		for x := 0; x < bounds.Dx(); x++ {
			sample := color.NRGBA64Model.Convert(src.At(bounds.Min.X+x, bounds.Min.Y+y)).(color.NRGBA64)
			rgb := [3]float64{curve[sample.R], curve[sample.G], curve[sample.B]}
			luminance := rgb[0]*weights[0] + rgb[1]*weights[1] + rgb[2]*weights[2]
			if metadata.hdrTransfer == 18 {
				gain := 1000 * math.Pow(luminance, 0.2)
				for c := range rgb {
					rgb[c] *= gain
				}
				luminance *= gain
			}
			var mapped [3]uint16
			if luminance > 0 {
				level := luminance / referenceWhite * exposure
				shoulder := level * (1 + level/(white*white)) / (1 + level)
				gain := shoulder / luminance
				for c, row := range matrix {
					mapped[c] = srgbSample((row[0]*rgb[0] + row[1]*rgb[1] + row[2]*rgb[2]) * gain)
				}
			}
			output.SetNRGBA64(x, y, color.NRGBA64{R: mapped[0], G: mapped[1], B: mapped[2], A: sample.A})
		}
	}
	return output, nil
}
