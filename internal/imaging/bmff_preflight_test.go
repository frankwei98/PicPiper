package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"os"
	"path/filepath"
	"testing"

	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/gen2brain/avif"
)

func TestHEICSequenceRejectedBeforeCodec(t *testing.T) {
	pict := bmffBox("hdlr", append(make([]byte, 8), "pict"...))
	track := bmffBox("trak", bmffBox("mdia", pict))
	oversizedStsz := make([]byte, 12)
	binary.BigEndian.PutUint32(oversizedStsz[8:12], 0xffffffff)
	hostileTrack := bmffBox("trak", bmffBox("mdia", append(append([]byte(nil), pict...), bmffBox("minf", bmffBox("stbl", bmffBox("stsz", oversizedStsz)))...)))
	largeMovie := binary.BigEndian.AppendUint32(nil, 1)
	largeMovie = append(largeMovie, "moov"...)
	largeMovie = binary.BigEndian.AppendUint64(largeMovie, uint64(len(track)+16))
	largeMovie = append(largeMovie, track...)
	tailMovie := append([]byte{0, 0, 0, 0, 'm', 'o', 'o', 'v'}, track...)
	for _, tc := range []struct {
		name   string
		brands string
		boxes  []byte
		code   string
	}{
		{"msf1", "msf1\x00\x00\x00\x00", nil, "heicSequenceUnsupported"},
		{"hevc", "hevc\x00\x00\x00\x00", nil, "heicSequenceUnsupported"},
		{"hevx", "hevx\x00\x00\x00\x00", nil, "heicSequenceUnsupported"},
		{"compatible sequence", "heic\x00\x00\x00\x00msf1", nil, "heicSequenceUnsupported"},
		{"late large-size track", "heic\x00\x00\x00\x00", append(bmffBox("mdat", make([]byte, 256<<10)), largeMovie...), "heicSequenceUnsupported"},
		{"track through EOF", "heix\x00\x00\x00\x00", tailMovie, "heicSequenceUnsupported"},
		{"oversized stsz sample count", "heic\x00\x00\x00\x00", bmffBox("moov", hostileTrack), "heicSequenceUnsupported"},
		{"truncated track", "heic\x00\x00\x00\x00", bmffBox("moov", track[:len(track)-1]), "unsupportedImage"},
		{"too many boxes", "heic\x00\x00\x00\x00", bmffBox("moov", bytes.Repeat(bmffBox("free", nil), bmffBoxBudget)), "unsupportedImage"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeBMFFFixture(t, append(bmffBox("ftyp", []byte(tc.brands)), tc.boxes...))
			_, err := inspect(path)
			requireImagingCode(t, err, tc.code)
			_, _, err = decode(context.Background(), path)
			requireImagingCode(t, err, tc.code)
		})
	}
}

func TestAVIFTrackPreflightChecksHeaderAndSampleSizes(t *testing.T) {
	// The two declarations need individual checks. The bundled decoder uses
	// tkhd for track output and may read a separate ispe for DecodeConfig.
	extent := binary.BigEndian.AppendUint32(make([]byte, 4), 1)
	extent = binary.BigEndian.AppendUint32(extent, 1)
	meta := bmffBox("meta", append(make([]byte, 4), bmffBox("iprp", bmffBox("ipco", bmffBox("ispe", extent)))...))
	prefix := append(bmffBox("ftyp", []byte("avis\x00\x00\x00\x00avif")), meta...)
	for _, tc := range []struct {
		name           string
		version        byte
		display, entry uint16
	}{
		{"track header v0", 0, 7000, 16},
		{"track header v1", 1, 7000, 16},
		{"sample description", 0, 16, 7000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			offset := 76 + int(tc.version)*12
			header := make([]byte, offset+8)
			header[0] = tc.version
			binary.BigEndian.PutUint32(header[offset:], uint32(tc.display)<<16)
			binary.BigEndian.PutUint32(header[offset+4:], uint32(tc.display)<<16)
			sample := make([]byte, 78)
			binary.BigEndian.PutUint16(sample[24:], tc.entry)
			binary.BigEndian.PutUint16(sample[26:], tc.entry)
			stsd := bmffBox("stsd", append(binary.BigEndian.AppendUint32(make([]byte, 4), 1), bmffBox("av01", sample)...))
			pict := bmffBox("hdlr", append(make([]byte, 8), "pict"...))
			mdia := bmffBox("mdia", append(pict, bmffBox("minf", bmffBox("stbl", stsd))...))
			track := bmffBox("trak", append(bmffBox("tkhd", header), mdia...))
			path := writeBMFFFixture(t, append(prefix, bmffBox("moov", track)...))
			_, err := inspect(path)
			requireImagingCode(t, err, "imageTooLarge")
			_, _, err = decode(context.Background(), path)
			requireImagingCode(t, err, "imageTooLarge")
		})
	}
}

func TestAVIFAnimationRemainsExplicitFirstFrameExport(t *testing.T) {
	frames := []image.Image{}
	for _, value := range []uint8{35, 210} {
		frame := image.NewNRGBA(image.Rect(0, 0, 16, 16))
		draw.Draw(frame, frame.Bounds(), image.NewUniform(color.NRGBA{R: value, G: value, B: value, A: 255}), image.Point{}, draw.Src)
		frames = append(frames, frame)
	}
	var encoded bytes.Buffer
	animation := &avif.AVIF{Image: frames, Delay: []float64{0.1, 0.1}}
	if err := avif.EncodeAll(&encoded, animation); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	if len(data) < 12 || string(data[8:12]) != "avis" {
		t.Fatal("expected an avis sequence from the bundled encoder")
	}
	service := New(t.TempDir())
	t.Cleanup(service.Close)
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)

	for _, major := range []string{"avis", "avif"} {
		t.Run(major, func(t *testing.T) {
			data := bytes.Clone(data)
			copy(data[8:12], major)
			path := writeBMFFFixture(t, data)
			inspection, err := inspect(path)
			if err != nil || !inspection.Animated {
				t.Fatalf("inspect AVIF sequence = %+v, %v", inspection, err)
			}
			req := request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: major + ".png", Settings: settings{TargetFormat: "png", Quality: 100}}
			_, err = service.compress(context.Background(), req)
			requireImagingCode(t, err, "animationUnsupported")
			req.Settings.AnimationMode = "firstFrame"
			result, err := service.compress(context.Background(), req)
			if err != nil || result.Width != 16 || result.Height != 16 {
				t.Fatalf("first-frame output = %+v, %v", result, err)
			}
			output, _, err := decode(context.Background(), result.OutputPath)
			if err != nil {
				t.Fatal(err)
			}
			if value := color.NRGBAModel.Convert(output.At(0, 0)).(color.NRGBA).R; value > 75 {
				t.Fatalf("export did not use the first frame: red = %d", value)
			}
		})
	}
}

func TestDecodedBoundsChecksDimensionsWithoutPixelAllocation(t *testing.T) {
	for _, bounds := range []image.Rectangle{
		image.Rect(0, 0, 0, 3),
		image.Rect(0, 0, 2, maxPixels),
		image.Rect(0, 0, 10000, 4001),
	} {
		requireImagingCode(t, checkDecodedBounds(&image.RGBA{Rect: bounds}), "imageTooLarge")
	}
	if err := checkDecodedBounds(&image.RGBA{Rect: image.Rect(0, 0, 10000, 4000)}); err != nil {
		t.Fatalf("40 million pixels should be accepted: %v", err)
	}
}

func writeBMFFFixture(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "image.bmff")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func requireImagingCode(t *testing.T, err error, code string) {
	t.Helper()
	var business *apperror.Error
	if !errors.As(err, &business) || business.Code != code {
		t.Fatalf("got %v, want business error %q", err, code)
	}
}
