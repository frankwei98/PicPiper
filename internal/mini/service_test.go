package mini

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
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

func TestMiniOutputFileNameSanitizesWindowsInvalidStems(t *testing.T) {
	for _, test := range []struct {
		input string
		want  string
	}{
		{input: "a?b:c.png", want: "a_b_c.webp"},
		{input: "a\x01b.png", want: "a_b.webp"},
		{input: "con.jpg", want: "con-image.webp"},
		{input: ".png", want: "image.webp"},
	} {
		if got := miniOutputFileName(test.input, "webp"); got != test.want {
			t.Errorf("miniOutputFileName(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

func TestMiniAPNGErrorGuidesUserToMainWindow(t *testing.T) {
	dir := t.TempDir()
	images := imaging.New(dir)
	defer images.Close()
	storage := cloud.New(dir)
	settings := cloud.DefaultMiniSettings()
	settings.Enabled = true
	settings.TargetFormat = "webp"
	if err := storage.SaveMiniSettings(settings); err != nil {
		t.Fatal(err)
	}
	path := writeMiniAPNG(t, dir)
	service := New(images, storage, func([]byte) error { return nil }, func(string) error { return nil })
	defer service.Close()
	if err := service.Add([]string{path}); err != nil {
		t.Fatal(err)
	}
	state := miniIdle(t, service)
	if len(state.Items) != 1 || state.Items[0].Status != "failed" {
		t.Fatalf("APNG did not fail in Mini as expected: %+v", state.Items)
	}
	message := state.Items[0].Error
	if !strings.Contains(message, "main window") || strings.Contains(message, "First frame only") {
		t.Fatalf("Mini gave an unavailable action instead of a usable direction: %q", message)
	}
}

func TestMiniImageErrorMapsAnimationSettingsFailures(t *testing.T) {
	for _, code := range []string{"animationUnsupported", "animationNeedsTarget"} {
		var mapped *apperror.Error
		if err := miniImageError(apperror.New(code, "source error")); !errors.As(err, &mapped) {
			t.Fatalf("%s error was not mapped to an app error: %v", code, err)
		}
		if mapped.Code != "miniAnimationUnsupported" || !strings.Contains(mapped.Message, "main window") {
			t.Fatalf("%s error mapping was not Mini-specific: %+v", code, mapped)
		}
	}
}

func writeMiniAPNG(t *testing.T, dir string) string {
	t.Helper()
	var plain bytes.Buffer
	if err := png.Encode(&plain, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	base := plain.Bytes()
	data := append([]byte{}, base[:33]...)
	data = append(data, miniPNGChunk("acTL", binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint32(nil, 1), 0))...)
	frame := make([]byte, 26)
	binary.BigEndian.PutUint32(frame[4:8], 2)
	binary.BigEndian.PutUint32(frame[8:12], 2)
	binary.BigEndian.PutUint16(frame[20:22], 1)
	binary.BigEndian.PutUint16(frame[22:24], 10)
	data = append(data, miniPNGChunk("fcTL", frame)...)
	data = append(data, base[33:]...)
	path := filepath.Join(dir, "animated.apng")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func miniPNGChunk(kind string, payload []byte) []byte {
	chunk := make([]byte, 12+len(payload))
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(payload)))
	copy(chunk[4:8], kind)
	copy(chunk[8:], payload)
	checksum := crc32.ChecksumIEEE(chunk[4 : 8+len(payload)])
	binary.BigEndian.PutUint32(chunk[8+len(payload):], checksum)
	return chunk
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

type parallelMiniImages struct {
	delegate imageCaller
	entered  chan string
	release  chan struct{}
}

func (p *parallelMiniImages) Call(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	if op == "compress_image" {
		var req struct {
			SourcePath string `json:"sourcePath"`
		}
		_ = json.Unmarshal(raw, &req)
		p.entered <- req.SourcePath
		select {
		case <-p.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return p.delegate.Call(ctx, op, raw)
}
func TestMiniPipelinesImagesUsingConfiguredBudget(t *testing.T) {
	dir := t.TempDir()
	images := imaging.New(dir)
	defer images.Close()
	images.SetConcurrency(2)
	if images.ProcessingLimits().Concurrency < 2 {
		t.Skip("requires two available CPUs")
	}
	images.SetConcurrency(1)
	storage := cloud.New(dir)
	cfg := cloud.DefaultMiniSettings()
	cfg.Enabled = true
	cfg.TargetFormat = "png"
	if err := storage.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	var fixture bytes.Buffer
	if err := png.Encode(&fixture, image.NewNRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 3)
	for n := range paths {
		paths[n] = filepath.Join(dir, fmt.Sprintf("source-%d.png", n))
		if err := os.WriteFile(paths[n], fixture.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	gate := &parallelMiniImages{delegate: images, entered: make(chan string, 3), release: make(chan struct{})}
	copied := make(chan struct{}, 1)
	service := New(gate, storage, func([]byte) error { copied <- struct{}{}; return nil }, func(string) error { return nil })
	defer service.Close()
	if err := service.Add(paths); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("Mini did not start")
	}
	select {
	case <-gate.entered:
		t.Fatal("Mini exceeded the initial budget")
	case <-time.After(60 * time.Millisecond):
	}
	images.SetConcurrency(2)
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("Mini did not apply the increased budget to its running batch")
	}
	select {
	case <-gate.entered:
		t.Fatal("Mini exceeded processing budget")
	case <-time.After(60 * time.Millisecond):
	}
	close(gate.release)
	select {
	case <-copied:
	case <-time.After(5 * time.Second):
		t.Fatal("Mini did not finish its batch")
	}
	state := miniIdle(t, service)
	if len(state.Items) != 3 {
		t.Fatal("lost results", state)
	}
	for _, item := range state.Items {
		if item.Status != "completed" {
			t.Fatalf("unfinished result: %+v", item)
		}
	}
}
