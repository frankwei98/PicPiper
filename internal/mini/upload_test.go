package mini

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

type countedImages struct {
	delegate     imageCaller
	compressions atomic.Int32
}

func (c *countedImages) Call(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	if op == "compress_image" {
		c.compressions.Add(1)
	}
	return c.delegate.Call(ctx, op, raw)
}
func miniIdle(t *testing.T, s *Service) State {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		v := s.Snapshot()
		if !v.Busy {
			return v
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Mini work did not finish")
	return State{}
}

func TestUploadCachedResultsRetriesWithoutRecompressingAndKeepsImageCopy(t *testing.T) {
	var puts atomic.Int32
	var reject atomic.Bool
	var block atomic.Bool
	entered, release := make(chan struct{}, 1), make(chan struct{})
	reject.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		puts.Add(1)
		if r.Method != "PUT" || r.Header.Get("If-None-Match") != "*" {
			t.Error("upload must use a conditional PUT")
		}
		if r.Header.Get("Content-Type") != "image/png" || !strings.HasSuffix(r.URL.Path, ".png") {
			t.Error("cached output used the new compression format")
		}
		payload, _ := io.ReadAll(r.Body)
		if _, err := png.Decode(bytes.NewReader(payload)); err != nil {
			t.Error("upload did not contain cached PNG")
		}
		if reject.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if block.Load() {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("ETag", `"synthetic"`)
	}))
	defer server.Close()
	dir := t.TempDir()
	storage := cloud.New(dir)
	cfg := cloud.DefaultMiniSettings()
	cfg.Enabled = true
	cfg.TargetFormat = "png"
	cfg.Action = "upload" // Settings from the previous automatic-upload design.
	p := map[string]any{"id": "synthetic", "name": "Synthetic", "endpoint": server.URL, "region": "us-east-1", "bucket": "images", "accessKeyId": "fake-access", "pathStyle": true, "publicBaseUrl": "https://cdn.example.test", "defaultPrefix": ""}
	if _, err := storage.Call(context.Background(), "save_app_settings", mustJSON(map[string]any{"settings": map[string]any{"profiles": []any{p}, "namingTemplate": "{slug}.{ext}", "mini": cfg}})); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Call(context.Background(), "save_s3_secret", mustJSON(map[string]any{"profileId": "synthetic", "secretAccessKey": "fake-secret"})); err != nil {
		t.Fatal(err)
	}
	images := imaging.New(dir)
	defer images.Close()
	counted := &countedImages{delegate: images}
	imageCopies := make(chan []byte, 8)
	textCopies := make(chan string, 8)
	s := New(counted, storage, func(b []byte) error { imageCopies <- b; return nil }, func(text string) error { textCopies <- text; return nil })
	defer s.Close()
	paths := []string{filepath.Join(dir, "first.png"), filepath.Join(dir, "second.png")}
	for _, path := range paths {
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		err = png.Encode(f, image.NewNRGBA(image.Rect(0, 0, 8, 8)))
		_ = f.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Add(paths); err != nil {
		t.Fatal(err)
	}
	before := miniIdle(t, s)
	if before.Copied != "image" || len(before.Items) != 2 {
		t.Fatal("default compression must copy an image")
	}
	if puts.Load() != 0 || before.Items[0].URL != "" || before.Items[1].URL != "" {
		t.Fatal("dropping an image uploaded without an explicit upload action")
	}
	<-imageCopies
	ids := []string{before.Items[0].ID, before.Items[1].ID}
	cached, _ := s.item(ids[0])
	cacheBytes, _ := os.ReadFile(cached.outputPath)
	// Removing inputs and changing preferences must not affect the existing output.
	for _, path := range paths {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	cfg.TargetFormat = "webp"
	if err := storage.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	if err := s.Upload([]string{ids[0], "missing"}, "synthetic", "markdown"); err == nil {
		t.Fatal("invalid selection accepted")
	}
	if s.Snapshot().Items[0].UploadStatus != "" {
		t.Fatal("partially queued invalid batch")
	}
	if err := s.Upload(ids, "missing", "markdown"); err == nil {
		t.Fatal("missing profile accepted")
	}
	if err := s.Upload(ids, "synthetic", "markdown"); err != nil {
		t.Fatal(err)
	}
	failed := miniIdle(t, s)
	for _, i := range failed.Items {
		if i.Status != "completed" || i.UploadStatus != "failed" || i.UploadError == "" {
			t.Fatal("failed upload lost the compressed result")
		}
	}
	if err := s.CopyImage(ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := png.Decode(bytes.NewReader(<-imageCopies)); err != nil {
		t.Fatal(err)
	}
	reject.Store(false)
	block.Store(true)
	if err := s.Upload([]string{ids[0]}, "synthetic", "markdown"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not start")
	}
	if err := s.Upload([]string{ids[0]}, "synthetic", "markdown"); err == nil {
		t.Fatal("duplicate pending upload accepted")
	}
	close(release)
	block.Store(false)
	first := miniIdle(t, s)
	if first.Items[0].URL == "" || first.Items[0].UploadStatus != "completed" {
		t.Fatal("single upload failed")
	}
	if text := <-textCopies; !strings.HasPrefix(text, "![") {
		t.Fatal("upload did not copy Markdown")
	}
	if err := s.Upload(ids, "synthetic", "html"); err != nil {
		t.Fatal(err)
	}
	uploaded := miniIdle(t, s)
	if text := <-textCopies; strings.Count(text, "<img ") != 2 {
		t.Fatal("batch upload did not copy both HTML links")
	}
	// First item reuses its successful destination; second item is retried once.
	if puts.Load() != 4 || counted.compressions.Load() != 2 {
		t.Fatalf("puts=%d compressions=%d", puts.Load(), counted.compressions.Load())
	}
	if len(uploaded.Items) != 2 {
		t.Fatal("upload appended duplicate results")
	}
	for _, i := range uploaded.Items {
		if i.Status != "completed" || i.UploadError != "" || len(i.Links) != 4 {
			t.Fatal("upload did not restore result state")
		}
	}
	after, _ := s.item(ids[0])
	afterBytes, _ := os.ReadFile(after.outputPath)
	if after.outputPath != cached.outputPath || !bytes.Equal(cacheBytes, afterBytes) {
		t.Fatal("upload modified cached output")
	}
	if err := s.CopyImage(ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := png.Decode(bytes.NewReader(<-imageCopies)); err != nil {
		t.Fatal(err)
	}
	plan, err := storage.MiniPlan()
	if err != nil || plan.Settings.Action != "clipboard" {
		t.Fatal("manual upload changed the automatic completion action")
	}
}
