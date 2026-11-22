package imaging

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHDRTransferReferenceValues(t *testing.T) {
	// ST 2084: code 0.5080784215 represents 100 cd/m²; code 1 is 10000.
	for _, sample := range []struct{ code, nits float64 }{{0, 0}, {0.5080784215, 100}, {0.7518270962, 1000}, {1, 10000}} {
		if got := pqNits(sample.code); math.Abs(got-sample.nits) > 0.0001 {
			t.Fatalf("PQ(%g) = %g, want %g nits", sample.code, got, sample.nits)
		}
	}
	if math.Abs(hlgScene(0.5)-1.0/12) > 1e-9 || math.Abs(hlgScene(1)-1) > 1e-7 {
		t.Fatal("HLG inverse OETF does not match its reference endpoints")
	}
}

func TestHDRPNGPreviewComparisonAndExport(t *testing.T) {
	for _, test := range []struct {
		name     string
		transfer byte
		code     uint16
		want     uint8
	}{{"PQ", 16, 33297, 187}, {"HLG", 18, 49151, 215}} {
		t.Run(test.name, func(t *testing.T) {
			// PNG 3 cICP declares the transfer function of actual 16-bit pixels.
			// Neutral 100-nit PQ / approximately 203-nit HLG patches check the
			// luminance policy independently of the implementation's lookup table.
			img := image.NewNRGBA64(image.Rect(0, 0, 8, 4))
			for y := 0; y < 4; y++ {
				for x := 0; x < 8; x++ {
					alpha := uint16(65535)
					if x >= 4 {
						alpha = 32768
					}
					img.SetNRGBA64(x, y, color.NRGBA64{R: test.code, G: test.code, B: test.code, A: alpha})
				}
			}
			var encoded bytes.Buffer
			if err := png.Encode(&encoded, img); err != nil {
				t.Fatal(err)
			}
			data := append([]byte{}, encoded.Bytes()[:33]...)
			data = append(data, pngChunk("cICP", []byte{9, test.transfer, 0, 1})...)
			// cICP has priority over iCCP in PNG 3.
			data = append(data, pngChunk("iCCP", []byte("ignored\x00\x00invalid zlib"))...)
			data = append(data, encoded.Bytes()[33:]...)
			path := filepath.Join(t.TempDir(), "hdr.png")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			info, err := inspect(path)
			if err != nil || !info.HDR || info.BitDepth != 16 || info.Warning == nil || !strings.Contains(*info.Warning, "tone-mapped") {
				t.Fatalf("HDR inspection failed: %+v %v", info, err)
			}
			decoded, _, err := decode(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			for _, x := range []int{0, 7} {
				got := color.NRGBA64Model.Convert(decoded.At(x, 0)).(color.NRGBA64)
				if abs(int(got.R/257)-int(test.want)) > 1 || abs(int(got.G)-int(got.R)) > 2 || abs(int(got.B)-int(got.R)) > 2 || got.A != img.NRGBA64At(x, 0).A {
					t.Fatalf("tone mapping changed neutral hue, luminance or alpha: %+v want ~%d", got, test.want)
				}
			}
			service := New(t.TempDir())
			run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
			result := call(t, service, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "sdr.png", Settings: settings{TargetFormat: "png"}}).(Result)
			output, _, err := decode(context.Background(), result.OutputPath)
			if err != nil || imageProperties(result.OutputPath).hdr || !highBitDepth(output) || !strings.Contains(result.Warning, "tone-mapped") {
				t.Fatalf("SDR export invalid: %v %s", err, result.Warning)
			}
			if output.At(7, 0) != decoded.At(7, 0) {
				t.Fatal("export differs from the displayed tone mapping")
			}
			thumbnail := call(t, service, "read_thumbnail", request{Path: path}).(map[string]string)
			t.Cleanup(service.Close)
			comparison := call(t, service, "read_comparison_image", request{Path: path}).(ComparisonImage)
			for _, preview := range []image.Image{decodePreview(t, thumbnail["dataUrl"]), decodeComparison(t, service, comparison)} {
				got := color.NRGBAModel.Convert(preview.At(0, 0)).(color.NRGBA)
				if abs(int(got.R)-int(test.want)) > 1 {
					t.Fatalf("preview did not use export's tone mapping: %+v", got)
				}
			}
			original, _ := os.ReadFile(path)
			if !bytes.Equal(original, data) {
				t.Fatal("HDR original changed")
			}
		})
	}
}

func TestHDRAVIFContainerDecodesAndToneMaps(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.SetRGBA(x, y, color.RGBA{R: 130, G: 130, B: 130, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := encodeModern(&encoded, img, "avif", 100); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	position := bytes.Index(data, []byte("nclx"))
	if position < 0 || position+11 > len(data) {
		t.Fatal("AVIF encoder omitted nclx color properties")
	}
	// These pixels are PQ code values; change only their color declaration,
	// leaving the encoded AV1 samples and YUV matrix/range unchanged.
	binary.BigEndian.PutUint16(data[position+4:position+6], 9)
	binary.BigEndian.PutUint16(data[position+6:position+8], 16)
	path := filepath.Join(t.TempDir(), "pq.avif")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	decoded, info, err := decode(context.Background(), path)
	if err != nil || !info.HDR {
		t.Fatalf("PQ AVIF could not be decoded: %+v %v", info, err)
	}
	got := color.NRGBAModel.Convert(decoded.At(8, 8)).(color.NRGBA)
	if got.R < 180 || got.R > 195 || abs(int(got.G)-int(got.R)) > 2 || abs(int(got.B)-int(got.R)) > 2 {
		t.Fatalf("AVIF did not decode PQ sample values before tone mapping: %+v", got)
	}
}

func TestHDRToneMappingRangeAndCancellation(t *testing.T) {
	for _, transfer := range []uint16{16, 18} {
		img := image.NewNRGBA64(image.Rect(0, 0, 256, 1))
		for x := 0; x < 256; x++ {
			v := uint16(x * 257)
			img.SetNRGBA64(x, 0, color.NRGBA64{R: v, G: v, B: v, A: 65535})
		}
		result, err := toneMapHDR(context.Background(), img, sourceProperties{hdr: true, hdrPrimaries: 9, hdrTransfer: transfer})
		if err != nil {
			t.Fatal(err)
		}
		previous := uint32(0)
		for x := 0; x < 256; x++ {
			r, _, _, _ := result.At(x, 0).RGBA()
			if r < previous {
				t.Fatalf("non-monotonic highlights at %d", x)
			}
			previous = r
		}
		if previous < 65530 {
			t.Fatal("peak does not reach SDR white")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := toneMapHDR(ctx, image.NewNRGBA(image.Rect(0, 0, 1, 1)), sourceProperties{}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled tone mapping continued")
	}
}

func decodePreview(t *testing.T, url string) image.Image {
	t.Helper()
	_, encoded, ok := strings.Cut(url, ",")
	if !ok {
		t.Fatal("missing preview data URL")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return img
}
