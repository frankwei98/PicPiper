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

func TestIsolatedClipboardStreamsWithoutWritablePreviewStorage(t *testing.T) {
	s := NewIsolated(t.TempDir())
	t.Cleanup(s.Close)
	s.SetConcurrency(1)
	// A regular file here makes creating a comparison session impossible on
	// every platform, even when tests run with elevated permissions.
	if err := os.WriteFile(s.previews.root, nil, 0600); err != nil {
		t.Fatal(err)
	}
	run := call(t, s, "create_optimizer_run", request{}).(map[string]string)
	source := image.NewNRGBA(image.Rect(0, 0, 1200, 2))
	last := color.NRGBA{R: 200, G: 100, B: 50, A: 128}
	source.SetNRGBA(1199, 1, last)
	path := fixture(t, source)
	result, err := s.compress(context.Background(), request{SourcePath: path, OutputDir: run["outputDir"], OutputFileName: "alpha.png", Settings: settings{TargetFormat: "png", Quality: 85}})
	if err != nil {
		t.Fatal(err)
	}
	pid := workerPID(t, s)
	bad := filepath.Join(run["outputDir"], "broken.png")
	if err := os.WriteFile(bad, []byte("not an image"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClipboardPNG(context.Background(), bad); err == nil {
		t.Fatal("clipboard accepted an unreadable image")
	}
	data, err := s.ClipboardPNG(context.Background(), result.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	got, err := png.Decode(bytes.NewReader(data))
	if err != nil || got.Bounds() != source.Bounds() || color.NRGBAModel.Convert(got.At(1199, 1)) != last {
		t.Fatalf("streamed clipboard PNG lost dimensions or transparency: %v", err)
	}
	if workerPID(t, s) != pid {
		t.Fatal("clipboard stream did not leave the worker ready for its next request")
	}
}

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
