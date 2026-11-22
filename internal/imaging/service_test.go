package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func call(t *testing.T, service *Service, operation string, req any) any {
	t.Helper()
	payload, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	value, err := service.Call(context.Background(), operation, payload)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func fixture(t *testing.T, img image.Image) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.png")
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAllEXIFOrientations(t *testing.T) {
	source := image.NewGray(image.Rect(0, 0, 3, 2))
	copy(source.Pix, []byte{1, 2, 3, 4, 5, 6})
	cases := []struct {
		width, height int
		pixels        []uint8
	}{
		{3, 2, []uint8{1, 2, 3, 4, 5, 6}},
		{3, 2, []uint8{3, 2, 1, 6, 5, 4}},
		{3, 2, []uint8{6, 5, 4, 3, 2, 1}},
		{3, 2, []uint8{4, 5, 6, 1, 2, 3}},
		{2, 3, []uint8{1, 4, 2, 5, 3, 6}},
		{2, 3, []uint8{4, 1, 5, 2, 6, 3}},
		{2, 3, []uint8{6, 3, 5, 2, 4, 1}},
		{2, 3, []uint8{3, 6, 2, 5, 1, 4}},
	}
	for i, tc := range cases {
		actual := applyOrientation(source, i+1)
		if actual.Bounds().Dx() != tc.width || actual.Bounds().Dy() != tc.height {
			t.Fatalf("orientation %d: unexpected dimensions %v", i+1, actual.Bounds())
		}
		var pixels []uint8
		for y := 0; y < tc.height; y++ {
			for x := 0; x < tc.width; x++ {
				pixels = append(pixels, color.GrayModel.Convert(actual.At(x, y)).(color.Gray).Y)
			}
		}
		if !reflect.DeepEqual(pixels, tc.pixels) {
			t.Fatalf("orientation %d: got %v want %v", i+1, pixels, tc.pixels)
		}
	}
}

func TestJPEGOrientationAndMetadataAreAppliedBeforeExport(t *testing.T) {
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 4, 2)), nil); err != nil {
		t.Fatal(err)
	}
	exif := []byte{'E', 'x', 'i', 'f', 0, 0, 'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0}
	data := append([]byte{0xff, 0xd8, 0xff, 0xe1, 0, byte(len(exif) + 2)}, exif...)
	data = append(data, encoded.Bytes()[2:]...)
	path := filepath.Join(t.TempDir(), "rotated.jpg")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	info, err := inspect(path)
	if err != nil || info.Width != 2 || info.Height != 4 {
		t.Fatalf("orientation was not reflected in inspection: %+v %v", info, err)
	}
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", map[string]any{}).(map[string]string)
	result := call(t, service, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "rotated.jpg", Settings: settings{TargetFormat: "jpg", Quality: 85}}).(Result)
	output, err := inspect(result.OutputPath)
	if err != nil || output.Width != 2 || output.Height != 4 || orientation(result.OutputPath) != 1 {
		t.Fatalf("unexpected output %+v %v", output, err)
	}
	outputBytes, _ := os.ReadFile(result.OutputPath)
	if bytes.Contains(outputBytes, []byte("Exif")) {
		t.Fatal("EXIF remained in encoded image")
	}
}

func TestTransparentPNGAndJPEGWhiteBackground(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	source := fixture(t, img)
	service := New(t.TempDir())
	run := call(t, service, "create_optimizer_run", map[string]any{}).(map[string]string)
	for _, format := range []string{"jpg", "png"} {
		result := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "transparent." + format, Settings: settings{TargetFormat: format, Quality: 95}}).(Result)
		file, err := os.Open(result.OutputPath)
		if err != nil {
			t.Fatal(err)
		}
		decoded, _, err := image.Decode(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		pixel := color.NRGBAModel.Convert(decoded.At(0, 0)).(color.NRGBA)
		if format == "jpg" && (pixel.R < 250 || pixel.G < 250 || pixel.B < 250 || !strings.Contains(result.Warning, "white")) {
			t.Fatalf("JPEG lost white matte: %+v", pixel)
		}
		if format == "png" && pixel.A != 0 {
			t.Fatalf("PNG lost transparency: %+v", pixel)
		}
	}
	t.Cleanup(service.Close)
	response := call(t, service, "read_comparison_image", request{Path: source}).(ComparisonImage)
	if decoded := decodeComparison(t, service, response); decoded.Bounds() != img.Bounds() {
		t.Fatalf("comparison changed dimensions: %v", decoded.Bounds())
	}
}

func TestExportsReserveNamesAndRejectOutsideWorkspace(t *testing.T) {
	service := New(t.TempDir())
	source := fixture(t, image.NewGray(image.Rect(0, 0, 2, 2)))
	run := call(t, service, "create_optimizer_run", map[string]any{}).(map[string]string)
	output := call(t, service, "compress_image", request{SourcePath: source, OutputDir: run["outputDir"], OutputFileName: "photo.png", Settings: settings{TargetFormat: "png"}}).(Result)
	target := t.TempDir()
	existing := filepath.Join(target, "photo.png")
	if err := os.WriteFile(existing, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for range 4 {
		workers.Go(func() {
			payload, _ := json.Marshal(request{OutputPaths: []string{output.OutputPath}, TargetDir: target})
			if _, err := service.Call(context.Background(), "copy_outputs_to_dir", payload); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	contents, _ := os.ReadFile(existing)
	if string(contents) != "keep me" {
		t.Fatal("existing file was overwritten")
	}
	files, _ := os.ReadDir(target)
	if len(files) != 5 {
		t.Fatalf("expected all independent exports: %d", len(files))
	}
	payload, _ := json.Marshal(request{OutputPaths: []string{source}, TargetDir: target})
	if _, err := service.Call(context.Background(), "copy_outputs_to_dir", payload); err == nil {
		t.Fatal("exported a file outside the image workspace")
	}
	link := filepath.Join(run["outputDir"], "outside.png")
	if err := os.Symlink(source, link); err != nil {
		t.Fatal(err)
	}
	payload, _ = json.Marshal(request{OutputPaths: []string{link}, TargetDir: target})
	if _, err := service.Call(context.Background(), "copy_outputs_to_dir", payload); err == nil {
		t.Fatal("export followed an out-of-workspace symlink")
	}
}

func TestRejectsCorruptAndOversizedImagesBeforeDecoding(t *testing.T) {
	for _, data := range [][]byte{[]byte("not an image"), hugePNG()} {
		path := filepath.Join(t.TempDir(), "bad.png")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := inspect(path); err == nil {
			t.Fatal("invalid or oversized image was accepted")
		}
	}
	for _, name := range []string{"../bad.png", "nested/path.png", "CON.png", "con .preview.png", "AUX .x.jpg", "file. ", "hello\x00.png"} {
		if validFileName(name) {
			t.Fatalf("unsafe filename accepted: %q", name)
		}
	}
	for _, exif := range [][]byte{nil, []byte("Exif"), {'I', 'I', 42, 0, 255, 255, 255, 255}} {
		if tiffOrientation(exif) != 1 {
			t.Fatal("malformed EXIF did not fall back to stored pixels")
		}
	}
}

func hugePNG() []byte {
	data := []byte{137, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 13, 'I', 'H', 'D', 'R'}
	header := make([]byte, 13)
	binary.BigEndian.PutUint32(header[:4], 100_000)
	binary.BigEndian.PutUint32(header[4:8], 100_000)
	header[8], header[9] = 8, 2
	data = append(data, header...)
	checksum := crc32.ChecksumIEEE(data[12:])
	return binary.BigEndian.AppendUint32(data, checksum)
}
