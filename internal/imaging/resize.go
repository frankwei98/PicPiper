package imaging

import (
	"image"
	"image/color"
	"math"

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
	horizontal := newResizeAxis(bounds.Dx(), target.Dx())
	vertical := newResizeAxis(bounds.Dy(), target.Dy())
	scratch := 32*int64(target.Dx())*int64(bounds.Dy()) +
		16*(horizontal.weightCount()+vertical.weightCount()) + 24*(int64(target.Dx())+int64(target.Dy()))
	if scratch <= resizeScratchLimit {
		imagedraw.CatmullRom.Scale(dst, target, src, bounds, imagedraw.Src, nil)
		return
	}
	scaleCatmullRom(dst, src, horizontal, vertical)
}

type resizeAxis struct {
	src, dst  int
	ratio     float64
	argScale  float64
	halfWidth float64
}

func newResizeAxis(src, dst int) resizeAxis {
	ratio := float64(src) / float64(dst)
	supportScale := max(1, ratio)
	return resizeAxis{src: src, dst: dst, ratio: ratio, argScale: 1 / supportScale, halfWidth: 2 * supportScale}
}

func (axis resizeAxis) weightCount() int64 {
	// Each range has at most four times the scale plus two boundary samples.
	return 4*int64(max(axis.src, axis.dst)) + 2*int64(axis.dst)
}

func (axis resizeAxis) span(dst int) (center float64, first, end int) {
	center = (float64(dst)+0.5)*axis.ratio - 0.5
	return center, max(0, int(math.Floor(center-axis.halfWidth))), min(axis.src, int(math.Ceil(center+axis.halfWidth)))
}

func (axis resizeAxis) weight(center float64, src int) float64 {
	distance := math.Abs((center - float64(src)) * axis.argScale)
	if distance >= 2 {
		return 0
	}
	return imagedraw.CatmullRom.At(distance)
}

type resizeWeights struct {
	first  int
	values []float64
}

func (axis resizeAxis) weights() []resizeWeights {
	if 8*axis.weightCount()+32*int64(axis.dst) > 1<<20 {
		return nil
	}
	values := make([]float64, 0, int(axis.weightCount()))
	spans := make([]resizeWeights, axis.dst)
	for x := range spans {
		center, first, end := axis.span(x)
		start, total := len(values), 0.0
		for col := first; col < end; col++ {
			weight := axis.weight(center, col)
			total += weight
			values = append(values, weight)
		}
		for i := start; i < len(values); i++ {
			values[i] /= total
		}
		spans[x] = resizeWeights{first, values[start:]}
	}
	return spans
}

type resizeSample [4]float64

func (p *resizeSample) addRGBA(c color.RGBA64, weight float64) {
	p[0] += float64(c.R) * weight
	p[1] += float64(c.G) * weight
	p[2] += float64(c.B) * weight
	p[3] += float64(c.A) * weight
}

func (axis resizeAxis) sample(x int, weights []resizeWeights, at func(int, int) color.RGBA64, origin image.Point) (sample resizeSample) {
	if weights != nil {
		span := weights[x]
		for col, weight := range span.values {
			if weight != 0 {
				sample.addRGBA(at(origin.X+span.first+col, origin.Y), weight)
			}
		}
		return sample
	}
	center, first, end := axis.span(x)
	total := 0.0
	for col := first; col < end; col++ {
		if weight := axis.weight(center, col); weight != 0 {
			sample.addRGBA(at(origin.X+col, origin.Y), weight)
			total += weight
		}
	}
	for c := range sample {
		sample[c] /= total
	}
	return sample
}

// Filter in two passes on premultiplied colors, keeping only a bounded strip
// of horizontal rows. Use the same widened kernel as the library when shrinking.
func scaleCatmullRom(dst resizeTarget, src image.Image, horizontal, vertical resizeAxis) {
	bounds, target := src.Bounds(), dst.Bounds()
	at := func(x, y int) color.RGBA64 {
		r, g, b, a := src.At(x, y).RGBA()
		return color.RGBA64{R: uint16(r), G: uint16(g), B: uint16(b), A: uint16(a)}
	}
	if typed, ok := src.(image.RGBA64Image); ok {
		at = typed.RGBA64At
	}

	weights := horizontal.weights()
	stripWidth := min(target.Dx(), 1024)
	rowCount := min(bounds.Dy(), int(math.Ceil(2*vertical.halfWidth))+2, (2<<20)/(32*stripWidth))
	cached := make([]resizeSample, rowCount*stripWidth)
	rowIDs := make([]int, rowCount)
	sums := make([]resizeSample, stripWidth)
	for start := 0; start < target.Dx(); start += stripWidth {
		width := min(stripWidth, target.Dx()-start)
		clear(rowIDs)
		for y := range target.Dy() {
			clear(sums)
			center, first, end := vertical.span(y)
			total := 0.0
			for row := first; row < end; row++ {
				weight := vertical.weight(center, row)
				if weight == 0 {
					continue
				}
				total += weight
				i := row % rowCount
				pixels := cached[i*stripWidth:][:width]
				if rowIDs[i] != row+1 {
					rowIDs[i] = row + 1
					origin := image.Pt(bounds.Min.X, bounds.Min.Y+row)
					for x := range pixels {
						pixels[x] = horizontal.sample(start+x, weights, at, origin)
					}
				}
				for x, pixel := range pixels {
					for c := range pixel {
						sums[x][c] += pixel[c] * weight
					}
				}
			}
			for x, pixel := range sums[:width] {
				dst.SetRGBA64(target.Min.X+start+x, target.Min.Y+y, pixel.rgba(total))
			}
		}
	}
}

func (p resizeSample) rgba(total float64) color.RGBA64 {
	channel := func(v float64) uint16 { return uint16(min(65535, max(0, v/total+0.5))) }
	return color.RGBA64{R: channel(min(p[0], p[3])), G: channel(min(p[1], p[3])), B: channel(min(p[2], p[3])), A: channel(p[3])}
}
