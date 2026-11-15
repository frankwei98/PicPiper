package mini

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

func TestLinkFormatsEscapeUntrustedNames(t *testing.T) {
	url := "https://images.example.test/a%20b.webp"
	cases := map[string]string{"url": url, "html": `<img src="` + url + `" alt="a &amp; &#34;b&#34;">`, "bbcode": "[img]" + url + "[/img]", "markdown": `![a & "b"](` + url + `)`}
	for format, want := range cases {
		if got := FormatLink(url, `a & "b".webp`, format); got != want {
			t.Errorf("%s: %q != %q", format, got, want)
		}
	}
	if got := FormatLink("https://x.test/a(b).png", "a[b].png", "markdown"); got != `![a\[b\]](https://x.test/a%28b%29.png)` {
		t.Fatal(got)
	}
}

func TestQueueCopiesDecodedImageWithAlphaAndPreservesSource(t *testing.T) {
	dir := t.TempDir()
	storage := cloud.New(dir)
	cfg := cloud.DefaultMiniSettings()
	cfg.Enabled = true
	cfg.TargetFormat = "png"
	if err := storage.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "source.png")
	img := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	img.SetNRGBA(2, 2, color.NRGBA{R: 240, G: 20, A: 100})
	var source bytes.Buffer
	if err := png.Encode(&source, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, source.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	images := imaging.New(dir)
	defer images.Close()
	copied := make(chan []byte, 2)
	service := New(images, storage, func(data []byte) error { copied <- append([]byte{}, data...); return nil }, func(string) error { t.Error("unexpected text copy"); return nil })
	defer service.Close()
	if err := service.Add([]string{path}); err != nil {
		t.Fatal(err)
	}
	select {
	case data := <-copied:
		result, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, alpha := result.At(0, 0).RGBA()
		if alpha != 0 {
			t.Fatal("lost transparent background")
		}
		_, _, _, alpha = result.At(2, 2).RGBA()
		if alpha == 0 || alpha == 65535 {
			t.Fatal("lost partial alpha")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("clipboard action did not complete")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, source.Bytes()) {
		t.Fatal("source changed")
	}
	if len(service.Snapshot().Items) != 1 {
		t.Fatal("missing result")
	}
	if _, err := service.Export(context.Background(), nil, t.TempDir()); err == nil {
		t.Fatal("empty export selection accepted")
	}
	if _, err := service.Export(context.Background(), []string{"missing"}, t.TempDir()); err == nil {
		t.Fatal("unknown result accepted for export")
	}
	target := t.TempDir()
	saved, err := service.Export(context.Background(), []string{service.Snapshot().Items[0].ID}, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 {
		t.Fatalf("saved paths: %v", saved)
	}
	if _, err := os.Stat(saved[0]); err != nil {
		t.Fatalf("exported output missing: %v", err)
	}
	if err := service.Copy("missing", "url"); err == nil {
		t.Fatal("arbitrary result ID accepted")
	}
}

type gatedImages struct {
	entered  chan struct{}
	release  chan struct{}
	once     sync.Once
	delegate imageCaller
}

func (g *gatedImages) Call(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	if op == "compress_image" {
		g.once.Do(func() { close(g.entered) })
		select {
		case <-g.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return g.delegate.Call(ctx, op, raw)
}

func TestDropCapturesSettingsAndQueueIsBounded(t *testing.T) {
	dir := t.TempDir()
	storage := cloud.New(dir)
	cfg := cloud.DefaultMiniSettings()
	cfg.Enabled = true
	cfg.TargetFormat = "png"
	if err := storage.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "fixture.png")
	f, _ := os.Create(path)
	_ = png.Encode(f, image.NewNRGBA(image.Rect(0, 0, 2, 2)))
	_ = f.Close()
	images := imaging.New(dir)
	defer images.Close()
	gated := &gatedImages{entered: make(chan struct{}), release: make(chan struct{}), delegate: images}
	copied := make(chan struct{}, 3)
	service := New(gated, storage, func([]byte) error { copied <- struct{}{}; return nil }, func(string) error { return nil })
	defer service.Close()
	if err := service.Add([]string{path}); err != nil {
		t.Fatal(err)
	}
	<-gated.entered
	cfg.TargetFormat = "jpg"
	if err := storage.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 20)
	for n := range paths {
		paths[n] = path
	}
	if err := service.Add(paths); err != nil {
		t.Fatal(err)
	}
	if err := service.Add(paths); err == nil {
		t.Fatal("unbounded queue accepted")
	}
	close(gated.release)
	select {
	case <-copied:
	case <-time.After(10 * time.Second):
		t.Fatal("first batch stalled")
	}
	snapshot := service.Snapshot()
	if snapshot.Items[0].OutputName != "fixture.png" {
		t.Fatalf("drop-time format changed: %+v", snapshot.Items[0])
	}
	// Cancellation releases pending work without depending on a live WebView.
	service.Stop()
}
