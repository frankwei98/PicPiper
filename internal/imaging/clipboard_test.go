package imaging

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestClipboardPreservesFullSizeTransparencyAndRestrictsPaths(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()
	source := image.NewNRGBA(image.Rect(0, 0, 1200, 2))
	source.SetNRGBA(1199, 1, color.NRGBA{R: 200, G: 100, B: 50, A: 128})
	path := fixture(t, source)
	run := call(t, s, "create_optimizer_run", request{}).(map[string]string)
	result := call(t, s, "compress_image", request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "alpha.png", Settings: settings{TargetFormat: "png", Quality: 85}}).(Result)
	data, err := s.ClipboardPNG(context.Background(), result.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	got, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if got.Bounds() != source.Bounds() || color.NRGBAModel.Convert(got.At(1199, 1)) != source.At(1199, 1) {
		t.Fatal("clipboard lost full size or transparent pixels")
	}
	if _, err := s.ClipboardPNG(context.Background(), path); err == nil {
		t.Fatal("accepted image outside output cache")
	}
	link := filepath.Join(run["outputDir"], "escape.png")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := s.OutputPaths([]string{result.OutputPath, link}); err == nil {
		t.Fatal("accepted escaping symlink in batch")
	}
}
