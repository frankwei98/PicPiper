package mini

import (
	"context"
	"image"
	"image/png"
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

func TestClearUndoAndTwelveHourExpiryKeepFilesAndPendingWork(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "private-cache.webp")
	if err := os.WriteFile(output, []byte("cached image must remain"), 0600); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	var clock atomic.Int64
	clock.Store(base.UnixNano())
	s := New(nil, cloud.New(dir), nil, nil)
	defer s.Close()
	s.now = func() time.Time { return time.Unix(0, clock.Load()) }
	s.mu.Lock()
	s.items = []Item{
		{ID: "finished", Status: "completed", CompletedAt: base, outputPath: output, URL: "https://cdn.example.test/image.webp", Uploads: map[string]string{"bucket": "https://cdn.example.test/image.webp"}, Links: map[string]string{"url": "https://cdn.example.test/image.webp"}},
		{ID: "failed", Status: "failed", CompletedAt: base},
		{ID: "pending", Status: "queued", pending: true},
	}
	s.mu.Unlock()
	clock.Store(base.Add(resultLifetime - time.Nanosecond).UnixNano())
	if len(s.Snapshot().Items) != 3 {
		t.Fatal("result hidden before twelve hours")
	}
	snapshot := s.Snapshot()
	snapshot.Items[0].Uploads["bucket"] = "tampered"
	snapshot.Items[0].Links["url"] = "tampered"
	if s.Snapshot().Items[0].Uploads["bucket"] == "tampered" || s.Snapshot().Items[0].Links["url"] == "tampered" {
		t.Fatal("snapshot exposes mutable deduplication state")
	}
	s.Clear()
	cleared := s.Snapshot()
	if len(cleared.Items) != 0 || !cleared.CanUndoClear || !cleared.Busy {
		t.Fatal("clear must hide records, preserve work, and allow undo")
	}
	if i, err := s.item("finished"); err != nil || len(i.Uploads) != 1 {
		t.Fatal("clear deleted upload history")
	}
	s.Restore()
	if len(s.Snapshot().Items) != 3 || s.Snapshot().CanUndoClear {
		t.Fatal("undo did not restore the hidden records")
	}
	s.Clear()
	clock.Store(base.Add(resultLifetime).UnixNano())
	s.Restore()
	after := s.Snapshot()
	if len(after.Items) != 1 || after.Items[0].ID != "pending" {
		t.Fatal("expired results were restored, or pending work was removed")
	}
	// A queued result starts its retention clock only after it completes.
	s.update("pending", func(i *Item) { i.Status = "completed"; i.pending = false; i.CompletedAt = s.now() })
	clock.Store(base.Add(2*resultLifetime - time.Nanosecond).UnixNano())
	if len(s.Snapshot().Items) != 1 {
		t.Fatal("newly completed result inherited an older expiry")
	}
	clock.Store(base.Add(2 * resultLifetime).UnixNano())
	if len(s.Snapshot().Items) != 0 {
		t.Fatal("result did not expire at the boundary")
	}
	if bytes, err := os.ReadFile(output); err != nil || string(bytes) != "cached image must remain" {
		t.Fatal("hiding/expiry removed or changed a cached image")
	}
}

func TestRecentHistoryIsIndependentOfTheActiveQueueLimit(t *testing.T) {
	dir := t.TempDir()
	storage := cloud.New(dir)
	cfg := cloud.DefaultMiniSettings()
	cfg.Enabled = true
	cfg.TargetFormat = "png"
	if err := storage.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	images := imaging.New(dir)
	defer images.Close()
	path := filepath.Join(dir, "fixture.png")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(f, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	s := New(images, storage, func([]byte) error { return nil }, func(string) error { return nil })
	defer s.Close()
	paths := make([]string, 20)
	for n := range paths {
		paths[n] = path
	}
	for range 2 {
		if err = s.Add(paths); err != nil {
			t.Fatal(err)
		}
		miniIdle(t, s)
	}
	if len(s.Snapshot().Items) != 40 {
		t.Fatal("recent completed results were evicted by the active queue limit")
	}
	// Selecting the entire history must also work when it exceeds the maximum
	// number of compression jobs. All these objects already exist in the bucket.
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	profile := map[string]any{"id": "public", "name": "Public", "endpoint": server.URL, "region": "us-east-1", "bucket": "images", "accessKeyId": "fake", "pathStyle": true, "publicBaseUrl": "https://cdn.example.test"}
	if _, err = storage.Call(context.Background(), "save_app_settings", mustJSON(map[string]any{"settings": map[string]any{"mini": cfg, "profiles": []any{profile}, "namingTemplate": "{slug}.{ext}"}})); err != nil {
		t.Fatal(err)
	}
	targets, err := storage.MiniUploadTargets()
	if err != nil || len(targets) != 1 {
		t.Fatal("missing synthetic bucket")
	}
	ids := []string{}
	s.mu.Lock()
	for n := range s.items {
		s.items[n].Uploads = map[string]string{targets[0].BucketKey: "https://cdn.example.test/" + s.items[n].ID + ".png"}
		ids = append(ids, s.items[n].ID)
	}
	s.mu.Unlock()
	copied := make(chan string, 1)
	s.copyText = func(text string) error { copied <- text; return nil }
	if err = s.Upload(ids, "public", "url"); err != nil {
		t.Fatal(err)
	}
	if miniIdle(t, s).Copied != "links" {
		t.Fatal("large selection was not copied")
	}
	if len(strings.Split(<-copied, "\n")) != 40 || requests.Load() != 0 {
		t.Fatal("large selection reuploaded existing objects or lost links")
	}
	s.Clear()
	if len(s.Snapshot().Items) != 0 {
		t.Fatal("clear did not hide all recent history")
	}
	s.Restore()
	if len(s.Snapshot().Items) != 40 {
		t.Fatal("undo could not restore the complete history")
	}
}
