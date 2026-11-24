package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAPNGFullCanvasFirstFramePreserves16BitPixelsWithoutCopy(t *testing.T) {
	const width, height = 1024, 512
	frame := image.NewNRGBA64(image.Rect(0, 0, width, height))
	sample := color.NRGBA64{R: 0x1234, G: 0x5678, B: 0x9abc, A: 0xcdef}
	frame.SetNRGBA64(20, 10, sample)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, frame); err != nil {
		t.Fatal(err)
	}
	base := encoded.Bytes()
	animation := binary.BigEndian.AppendUint32(nil, 1)
	animation = binary.BigEndian.AppendUint32(animation, 0)
	control := make([]byte, 26)
	binary.BigEndian.PutUint32(control[4:8], width)
	binary.BigEndian.PutUint32(control[8:12], height)
	binary.BigEndian.PutUint16(control[20:22], 1)
	binary.BigEndian.PutUint16(control[22:24], 10)
	data := append([]byte{}, base[:33]...)
	data = append(data, pngChunk("acTL", animation)...)
	data = append(data, pngChunk("fcTL", control)...)
	data = append(data, base[33:]...)
	path := filepath.Join(t.TempDir(), "full-canvas.png")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	decoded, info, err := decode(context.Background(), path)
	runtime.ReadMemStats(&after)

	if err != nil {
		t.Fatal(err)
	}
	if !info.Animated || info.BitDepth != 16 || decoded.Bounds() != frame.Bounds() {
		t.Fatalf("incorrect frame info %+v with bounds %v", info, decoded.Bounds())
	}
	if got := color.NRGBA64Model.Convert(decoded.At(20, 10)); got != sample {
		t.Fatalf("decoded pixel = %+v, want %+v", got, sample)
	}
	if _, _, _, alpha := decoded.At(0, 0).RGBA(); alpha != 0 {
		t.Fatalf("transparent pixel has alpha %d", alpha)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 7<<20 {
		t.Fatalf("16-bit APNG first-frame decode allocated %d bytes for %d pixels", allocated, width*height)
	}
}

func TestAPNGFirstFrameAcceptsPaletteAfterFrameControl(t *testing.T) {
	img := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.NRGBA{R: 240, A: 128}, color.NRGBA{B: 240, A: 255}})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	base := encoded.Bytes()
	control := binary.BigEndian.AppendUint32(nil, 1)
	control = binary.BigEndian.AppendUint32(control, 0)
	frame := make([]byte, 26)
	binary.BigEndian.PutUint32(frame[4:8], 2)
	binary.BigEndian.PutUint32(frame[8:12], 2)
	binary.BigEndian.PutUint16(frame[20:22], 1)
	binary.BigEndian.PutUint16(frame[22:24], 10)
	data := append([]byte{}, base[:33]...)
	data = append(data, pngChunk("acTL", control)...)
	data = append(data, pngChunk("fcTL", frame)...)
	data = append(data, base[33:]...)
	path := filepath.Join(t.TempDir(), "palette.png")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	decoded, _, err := decode(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	got := color.NRGBAModel.Convert(decoded.At(0, 0)).(color.NRGBA)
	if got.R != 240 || got.B != 0 || got.A != 128 {
		t.Fatalf("palette or alpha lost: %+v", got)
	}
}

func TestAPNGFirstFrameRejectsRepeatedHeader(t *testing.T) {
	encode := func(width, height int) []byte {
		var out bytes.Buffer
		if err := png.Encode(&out, image.NewNRGBA(image.Rect(0, 0, width, height))); err != nil {
			t.Fatal(err)
		}
		return out.Bytes()
	}
	canvas, oversized := encode(1, 1), encode(64, 64)
	control := binary.BigEndian.AppendUint32(nil, 1)
	control = binary.BigEndian.AppendUint32(control, 0)
	frame := make([]byte, 26)
	binary.BigEndian.PutUint32(frame[4:8], 1)
	binary.BigEndian.PutUint32(frame[8:12], 1)
	binary.BigEndian.PutUint16(frame[20:22], 1)
	binary.BigEndian.PutUint16(frame[22:24], 10)
	data := append([]byte{}, canvas[:33]...)
	data = append(data, pngChunk("acTL", control)...)
	data = append(data, pngChunk("fcTL", frame)...)
	// The frame control fits the 1x1 canvas; the second header and its pixels do not.
	data = append(data, oversized[8:]...)
	path := filepath.Join(t.TempDir(), "repeated-header.png")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if info, err := inspect(path); err != nil || !info.Animated || info.Width != 1 || info.Height != 1 {
		t.Fatalf("fixture is not a 1x1 APNG: %+v %v", info, err)
	}
	if _, _, err := decode(context.Background(), path); err == nil {
		t.Fatal("a repeated IHDR replaced the frame size validated against the canvas")
	}
}

func TestAPNGFirstFrameExcludesDefaultPoster(t *testing.T) {
	encode := func(img image.Image) []byte {
		var out bytes.Buffer
		if err := png.Encode(&out, img); err != nil {
			t.Fatal(err)
		}
		return out.Bytes()
	}
	poster := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			poster.SetNRGBA(x, y, color.NRGBA{B: 255, A: 255})
		}
	}
	first := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			first.SetNRGBA(x, y, color.NRGBA{R: 255, A: 128})
		}
	}
	poster.SetNRGBA(0, 0, color.NRGBA{B: 255, A: 128})
	base, pixels := encode(poster), encode(first)
	control := binary.BigEndian.AppendUint32(nil, 1)
	control = binary.BigEndian.AppendUint32(control, 0)
	data := append([]byte{}, base[:33]...)
	data = append(data, pngChunk("acTL", control)...)
	data = append(data, base[33:len(base)-12]...)
	frame := make([]byte, 26)
	binary.BigEndian.PutUint32(frame[4:8], 2)
	binary.BigEndian.PutUint32(frame[8:12], 2)
	binary.BigEndian.PutUint32(frame[12:16], 1)
	binary.BigEndian.PutUint32(frame[16:20], 1)
	binary.BigEndian.PutUint16(frame[20:22], 1)
	binary.BigEndian.PutUint16(frame[22:24], 10)
	data = append(data, pngChunk("fcTL", frame)...)
	sequence := uint32(1)
	for pos := 8; pos+12 <= len(pixels); {
		size := int(binary.BigEndian.Uint32(pixels[pos : pos+4]))
		kind := string(pixels[pos+4 : pos+8])
		if kind == "IDAT" {
			payload := binary.BigEndian.AppendUint32(nil, sequence)
			payload = append(payload, pixels[pos+8:pos+8+size]...)
			data = append(data, pngChunk("fdAT", payload)...)
			sequence++
		}
		pos += size + 12
	}
	data = append(data, pngChunk("IEND", nil)...)
	path := filepath.Join(t.TempDir(), "poster.apng")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	info, err := inspect(path)
	if err != nil || !info.Animated {
		t.Fatalf("APNG not detected: %+v %v", info, err)
	}
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	result := call(t, service, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "first.png", Settings: settings{TargetFormat: "png", AnimationMode: "firstFrame"}}).(Result)
	img, _, err := decode(context.Background(), result.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	got := color.NRGBAModel.Convert(img.At(1, 1)).(color.NRGBA)
	if got.R != 255 || got.B != 0 || got.A != 128 {
		t.Fatalf("poster was exported instead of animation: %+v", got)
	}
	if _, _, _, a := img.At(0, 0).RGBA(); a != 0 {
		t.Fatal("first frame did not retain its canvas offset")
	}
}
