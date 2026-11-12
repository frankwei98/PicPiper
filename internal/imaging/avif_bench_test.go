package imaging

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gen2brain/avif"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

// Compare the previous app policy with the actual selected backend. Run without
// other CPU work; quality metrics and decode are outside the measured region.
func BenchmarkAVIFCompression(b *testing.B) {
	fixtures := map[string]image.Image{"gradient": lossyCodecFixture(b)}
	for _, name := range []string{"texture", "text", "alpha"} {
		img := image.NewNRGBA(image.Rect(0, 0, 768, 512))
		for y := 0; y < 512; y++ {
			for x := 0; x < 768; x++ {
				c := color.NRGBA{R: uint8(40 + x*150/768), G: uint8(30 + y*180/512), B: 140, A: 255}
				if name == "texture" {
					v := math.Sin(float64(x)*.11) + math.Sin(float64(y)*.13) + math.Sin(float64(x+y)*.047)
					c.R, c.G, c.B = uint8(100+v*25), uint8(110+v*28), uint8(80+v*20)
				}
				if name == "alpha" {
					c.A = uint8((x + y) % 256)
				}
				img.SetNRGBA(x, y, c)
			}
		}
		if name == "text" {
			d := font.Drawer{Dst: img, Src: image.NewUniform(color.NRGBA{R: 20, G: 30, B: 40, A: 255}), Face: basicfont.Face7x13}
			for y := 25; y < 500; y += 19 {
				d.Dot = fixed.P(12, y)
				d.DrawString("Pic Piper 0123456789 The quick brown fox jumps over the lazy dog.")
			}
		}
		fixtures[name] = img
	}
	// Optional, externally supplied photograph; no private images are checked in.
	if path := os.Getenv("PICPIPER_AVIF_FIXTURE"); path != "" {
		file, err := os.Open(path)
		if err != nil {
			b.Fatal(err)
		}
		img, _, err := image.Decode(file)
		file.Close()
		if err != nil {
			b.Fatal(err)
		}
		fixtures["photo"] = img
	}
	for _, name := range []string{"gradient", "texture", "text", "alpha", "photo"} {
		img, ok := fixtures[name]
		if !ok {
			continue
		}
		for _, quality := range []int{55, 85} {
			for _, backend := range []string{"previous", "current"} {
				b.Run(fmt.Sprintf("%s/q%d/%s", name, quality, backend), func(b *testing.B) {
					var output bytes.Buffer
					encode := func() error {
						output.Reset()
						if backend == "current" {
							return encodeModern(&output, img, "avif", quality)
						}
						codecMu.Lock()
						defer codecMu.Unlock()
						return avif.Encode(&output, img, avif.Options{Quality: quality, QualityAlpha: 100, Speed: 8, ChromaSubsampling: image.YCbCrSubsampleRatio444})
					}
					if err := encode(); err != nil {
						b.Fatal(err)
					}
					b.ResetTimer()
					for b.Loop() {
						if err := encode(); err != nil {
							b.Fatal(err)
						}
					}
					b.StopTimer()
					decoded, err := decodePixels(bytes.NewReader(output.Bytes()), "avif")
					if err != nil {
						b.Fatal(err)
					}
					psnr, ssim, alphaError := avifQualityMetrics(img, decoded)
					b.ReportMetric(float64(output.Len()), "bytes/output")
					b.ReportMetric(psnr, "RGB-PSNR-dB")
					b.ReportMetric(ssim, "RGB-SSIM")
					b.ReportMetric(float64(alphaError), "max-alpha-error")
					if directory := os.Getenv("PICPIPER_AVIF_OUTPUT"); directory != "" {
						if err := os.MkdirAll(directory, 0755); err != nil {
							b.Fatal(err)
						}
						path := filepath.Join(directory, strings.ReplaceAll(b.Name(), "/", "-"))
						if err := os.WriteFile(path+".avif", output.Bytes(), 0600); err != nil {
							b.Fatal(err)
						}
						file, err := os.Create(path + ".png")
						if err != nil {
							b.Fatal(err)
						}
						err = png.Encode(file, decoded)
						closeErr := file.Close()
						if err != nil || closeErr != nil {
							b.Fatalf("write decoded comparison: %v, %v", err, closeErr)
						}
					}
				})
			}
		}
	}
}

// RGB metrics compare displayed pixels composited on black, using 8x8 SSIM
// windows. Alpha is checked separately. These are diagnostics, not a claim of
// perceptual equivalence across codecs or a substitute for visual inspection.
func avifQualityMetrics(source, decoded image.Image) (psnr, ssim float64, alphaError int) {
	w, h := source.Bounds().Dx(), source.Bounds().Dy()
	var mse float64
	blocks := 0
	for by := 0; by < h; by += 8 {
		for bx := 0; bx < w; bx += 8 {
			for channel := 0; channel < 3; channel++ {
				var sx, sy, sxx, syy, sxy, n float64
				for y := by; y < min(by+8, h); y++ {
					for x := bx; x < min(bx+8, w); x++ {
						r, g, b, a := source.At(x+source.Bounds().Min.X, y+source.Bounds().Min.Y).RGBA()
						dr, dg, db, da := decoded.At(x+decoded.Bounds().Min.X, y+decoded.Bounds().Min.Y).RGBA()
						v := float64([]uint32{r, g, b}[channel]) / 257
						z := float64([]uint32{dr, dg, db}[channel]) / 257
						alphaError = max(alphaError, abs(int(a>>8)-int(da>>8)))
						n++
						sx, sy = sx+v, sy+z
						sxx, syy, sxy = sxx+v*v, syy+z*z, sxy+v*z
						mse += (v - z) * (v - z)
					}
				}
				mx, my := sx/n, sy/n
				vx, vy, covariance := sxx/n-mx*mx, syy/n-my*my, sxy/n-mx*my
				ssim += ((2*mx*my + 6.5025) * (2*covariance + 58.5225)) / ((mx*mx + my*my + 6.5025) * (vx + vy + 58.5225))
				blocks++
			}
		}
	}
	mse /= float64(w * h * 3)
	return 10 * math.Log10(255*255/mse), ssim / float64(blocks), alphaError
}
