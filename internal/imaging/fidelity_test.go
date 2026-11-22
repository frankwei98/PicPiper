package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gen2brain/webp"
)

func pngChunk(kind string, data []byte) []byte {
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	chunk = append(chunk, kind...)
	chunk = append(chunk, data...)
	return binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
}

func TestHDRColorMetadataAndUnreadableProfiles(t *testing.T) {
	box := func(kind string, data []byte) []byte {
		encoded := binary.BigEndian.AppendUint32(nil, uint32(len(data)+8))
		encoded = append(encoded, kind...)
		return append(encoded, data...)
	}
	for _, transfer := range []uint16{16, 18} {
		color := []byte("nclx")
		color = binary.BigEndian.AppendUint16(color, 9)
		color = binary.BigEndian.AppendUint16(color, transfer)
		color = binary.BigEndian.AppendUint16(color, 9)
		color = append(color, 0x80)
		data := box("ftyp", []byte("avif\x00\x00\x00\x00avif"))
		pitm := box("pitm", []byte{0, 0, 0, 0, 0, 1})
		ipma := box("ipma", []byte{0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0x81})
		iprp := box("iprp", append(box("ipco", box("colr", color)), ipma...))
		data = append(data, box("meta", append(append(make([]byte, 4), pitm...), iprp...))...)
		path := filepath.Join(t.TempDir(), "hdr.avif")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		metadata := imageProperties(path)
		if !metadata.hdr || metadata.hdrTransfer != transfer || metadata.hdrPrimaries != 9 || validateColorProperties(metadata) != nil {
			t.Fatalf("HDR transfer %d was not retained for tone mapping: %+v", transfer, metadata)
		}
	}
	if err := validateColorProperties(sourceProperties{profilePresent: true}); err == nil {
		t.Fatal("an unreadable profile would be silently stripped")
	}
}

func TestHighBitDepthSurvivesOrientationAndPNGResizing(t *testing.T) {
	img := image.NewNRGBA64(image.Rect(0, 0, 8, 4))
	want := color.NRGBA64{R: 0x1234, G: 0x7654, B: 0xabcd, A: 0xffff}
	for y := 0; y < 4; y++ {
		for x := 0; x < 8; x++ {
			img.SetNRGBA64(x, y, want)
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	data := append([]byte{}, encoded.Bytes()[:33]...)
	data = append(data, pngChunk("eXIf", tiff)...)
	data = append(data, encoded.Bytes()[33:]...)
	source := filepath.Join(t.TempDir(), "16-bit.png")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	info, err := inspect(source)
	if err != nil || info.BitDepth != 16 || info.Width != 4 || info.Height != 8 {
		t.Fatalf("incorrect high-bit-depth inspection: %+v %v", info, err)
	}
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	for _, edge := range []int{0, 4} {
		result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "output.png", Settings: settings{TargetFormat: "png", MaxDimension: edge}}).(Result)
		decoded, _, err := decode(context.Background(), result.OutputPath)
		if err != nil || !highBitDepth(decoded) {
			t.Fatalf("PNG lost 16-bit precision: %T %v", decoded, err)
		}
		got := color.NRGBA64Model.Convert(decoded.At(0, 0)).(color.NRGBA64)
		if abs(int(got.R)-int(want.R)) > 1 || abs(int(got.G)-int(want.G)) > 1 || abs(int(got.B)-int(want.B)) > 1 || got.A != want.A {
			t.Fatalf("low-order sample bits lost: got %+v want %+v", got, want)
		}
	}
	payload, _ := json.Marshal(request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "lossless.jxl", Settings: settings{TargetFormat: "jxl", Quality: 100}})
	if _, err := service.Call(context.Background(), "compress_image", payload); err == nil {
		t.Fatal("8-bit encoder accepted high-bit-depth lossless output")
	}
}

func TestWebPAnimationPreservesFramesTimingLoopsAndResize(t *testing.T) {
	first, second := image.NewNRGBA(image.Rect(0, 0, 32, 16)), image.NewNRGBA(image.Rect(0, 0, 32, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 32; x++ {
			first.SetNRGBA(x, y, color.NRGBA{R: 220, A: 255})
			second.SetNRGBA(x, y, color.NRGBA{B: 220, A: 128})
		}
	}
	var buffer bytes.Buffer
	if err := webp.EncodeAll(&buffer, &webp.WEBP{Image: []image.Image{first, second}, Delay: []int{90, 170}, LoopCount: 3}, webp.Options{Quality: 85, Method: 4}); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "animated.webp")
	if err := os.WriteFile(source, buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := inspect(source)
	if err != nil || info.FrameCount != 2 {
		t.Fatalf("animation was not detected: %+v %v", info, err)
	}
	for _, mode := range []string{"", "preserve", "firstFrame"} {
		req := request{SourcePath: source, Settings: settings{TargetFormat: "webp", AnimationMode: mode}}
		if got, want := needsLargeImageSlot("compress_image", req), mode != "firstFrame"; got != want {
			t.Errorf("animation mode %q: large-image slot = %t, want %t", mode, got, want)
		}
	}
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	for _, format := range []string{"webp"} {
		t.Run(format, func(t *testing.T) {
			result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "animation." + format, Settings: settings{TargetFormat: format, Quality: 85, MaxDimension: 16}}).(Result)
			file, err := os.Open(result.OutputPath)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			animation, err := webp.DecodeAll(file)
			if err != nil {
				t.Fatal(err)
			}
			frames, delays := animation.Image, animation.Delay
			loops := imageProperties(result.OutputPath).loopCount
			if len(frames) != 2 || len(delays) != 2 || delays[0] != 90 || delays[1] != 170 || loops != 3 {
				t.Fatalf("animation changed: frames=%d delays=%v loops=%d", len(frames), delays, loops)
			}
			for i, frame := range frames {
				if frame.Bounds().Dx() != 16 || frame.Bounds().Dy() != 8 {
					t.Fatalf("incorrect frame dimensions: %v", frame.Bounds())
				}
				got := color.NRGBAModel.Convert(frame.At(8, 4)).(color.NRGBA)
				if i == 0 && (got.R < 200 || got.A != 255) || i == 1 && (got.B < 200 || abs(int(got.A)-128) > 1) {
					t.Fatalf("animation frame or transparency changed: frame=%d color=%+v", i, got)
				}
			}
		})
	}
	payload, _ := json.Marshal(request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "flattened.png", Settings: settings{TargetFormat: "png"}})
	if _, err := service.Call(context.Background(), "compress_image", payload); err == nil {
		t.Fatal("animation was silently flattened into PNG")
	}
	result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "first.png", Settings: settings{TargetFormat: "png", AnimationMode: "firstFrame", MaxDimension: 16}}).(Result)
	still, _, err := decode(context.Background(), result.OutputPath)
	if err != nil || still.Bounds().Dx() != 16 || still.Bounds().Dy() != 8 {
		t.Fatalf("first-frame output is invalid: %v %v", still, err)
	}
	got := color.NRGBAModel.Convert(still.At(8, 4)).(color.NRGBA)
	if got.R < 200 || got.B > 10 || got.A != 255 || !strings.Contains(result.Warning, "First frame only") {
		t.Fatalf("wrong first frame or missing disclosure: %+v %s", got, result.Warning)
	}
	original, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(original, buffer.Bytes()) {
		t.Fatal("first-frame extraction changed the original animation")
	}
}
