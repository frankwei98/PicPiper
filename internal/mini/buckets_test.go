package mini

import (
	"context"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

func TestUploadRejectsChangedOrMissingConfirmedBucket(t *testing.T) {
	var puts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || !strings.HasPrefix(r.URL.Path, "/replacement/") {
			t.Errorf("unexpected upload: %s %s", r.Method, r.URL.Path)
		}
		puts.Add(1)
		w.Header().Set("ETag", `"synthetic"`)
	}))
	defer server.Close()
	storage := cloud.New(t.TempDir())
	cfg := cloud.DefaultMiniSettings()
	cfg.Enabled = true
	p := map[string]any{"id": "same-id", "name": "Public", "endpoint": server.URL, "region": "us-east-1", "bucket": "original", "accessKeyId": "fake", "pathStyle": true, "publicBaseUrl": "https://cdn.example.test"}
	save := func() {
		t.Helper()
		if _, err := storage.Call(context.Background(), "save_app_settings", mustJSON(map[string]any{"settings": map[string]any{"profiles": []any{p}, "namingTemplate": "{slug}.{ext}", "mini": cfg}})); err != nil {
			t.Fatal(err)
		}
	}
	save()
	if _, err := storage.Call(context.Background(), "save_s3_secret", mustJSON(map[string]any{"profileId": "same-id", "secretAccessKey": "synthetic-secret"})); err != nil {
		t.Fatal(err)
	}
	confirmed := confirmedBucketKey(t, storage, "same-id")
	path := filepath.Join(t.TempDir(), "cached.png")
	if err := os.WriteFile(path, []byte("synthetic cached image"), 0600); err != nil {
		t.Fatal(err)
	}
	copies := make(chan string, 1)
	s := New(nil, storage, nil, func(text string) error { copies <- text; return nil })
	defer s.Close()
	const id = "cached-result"
	s.mu.Lock()
	s.items = []Item{{ID: id, Status: "completed", OutputName: "cached.png", outputPath: path}}
	s.mu.Unlock()
	p["bucket"] = "replacement"
	save()
	for _, key := range []string{confirmed, ""} {
		err := s.Upload([]string{id}, "same-id", "url", key)
		var business *apperror.Error
		if !errors.As(err, &business) || business.Code != "miniUploadTargetChanged" {
			t.Fatalf("changed or missing confirmed bucket accepted: %v", err)
		}
		state := s.Snapshot()
		if state.Busy || state.Items[0].UploadStatus != "" || len(state.Items[0].Uploads) != 0 || puts.Load() != 0 {
			t.Fatal("rejected confirmation mutated the queue or uploaded")
		}
	}
	refreshed := confirmedBucketKey(t, storage, "same-id")
	if refreshed == confirmed {
		t.Fatal("changed bucket kept its old identity")
	}
	if err := s.Upload([]string{id}, "same-id", "url", refreshed); err != nil {
		t.Fatal(err)
	}
	state := miniIdle(t, s)
	if puts.Load() != 1 || state.Items[0].Uploads[refreshed] == "" || state.Copied != "links" {
		t.Fatalf("reconfirmed upload failed: %+v", state)
	}
	if text := <-copies; text != state.Items[0].Uploads[refreshed] {
		t.Fatal("reconfirmed link was not copied")
	}
}

func TestUploadRemembersEveryBucketAndIgnoresProfileAliases(t *testing.T) {
	var puts atomic.Int32
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes.Add(1)
			t.Error("Mini hiding deleted an S3 object")
		}
		if r.Method == http.MethodPut {
			puts.Add(1)
			if r.Header.Get("If-None-Match") != "*" || r.Header.Get("Authorization") == "" {
				t.Error("conditional signing was lost")
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
	profiles := []any{}
	for _, pair := range [][2]string{{"first", "images"}, {"second", "assets"}, {"alias", "images"}} {
		endpoint := server.URL
		if pair[0] == "alias" {
			endpoint += "/"
		}
		profiles = append(profiles, map[string]any{"id": pair[0], "name": pair[0], "endpoint": endpoint, "region": "us-east-1", "bucket": pair[1], "accessKeyId": "fake-access", "pathStyle": true, "publicBaseUrl": "https://cdn.example.test/" + pair[0], "defaultPrefix": pair[0]})
		if _, err := storage.Call(context.Background(), "save_s3_secret", mustJSON(map[string]any{"profileId": pair[0], "secretAccessKey": "fake-secret"})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := storage.Call(context.Background(), "save_app_settings", mustJSON(map[string]any{"settings": map[string]any{"profiles": profiles, "namingTemplate": "{slug}.{ext}", "mini": cfg}})); err != nil {
		t.Fatal(err)
	}
	targets, err := storage.MiniUploadTargets()
	if err != nil || len(targets) != 3 {
		t.Fatal("missing upload targets")
	}
	if targets[0].BucketKey != targets[2].BucketKey || targets[0].BucketKey == targets[1].BucketKey {
		t.Fatal("bucket identity depends on the profile or conflates different buckets")
	}
	img := imaging.New(dir)
	defer img.Close()
	counted := &countedImages{delegate: img}
	copied := make(chan string, 8)
	s := New(counted, storage, func([]byte) error { return nil }, func(text string) error { copied <- text; return nil })
	defer s.Close()
	path := filepath.Join(dir, "fixture.png")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(f, image.NewNRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	if err = s.Add([]string{path}); err != nil {
		t.Fatal(err)
	}
	id := miniIdle(t, s).Items[0].ID
	firstURL := ""
	for n, target := range []string{"first", "second", "alias", "first", "second"} {
		if err = s.Upload([]string{id}, target, "markdown", confirmedBucketKey(t, storage, target)); err != nil {
			t.Fatal(err)
		}
		snapshot := miniIdle(t, s)
		if snapshot.Copied != "links" || len(snapshot.Items) != 1 {
			t.Fatal("upload did not retain the cached result")
		}
		if link := <-copied; !strings.HasPrefix(link, "![") {
			t.Fatal("links were not copied")
		}
		if n == 0 {
			firstURL = snapshot.Items[0].URL
		}
		if n == 2 || n == 3 {
			if snapshot.Items[0].URL != firstURL {
				t.Fatal("same bucket did not reuse its original link")
			}
		}
		want := int32(2)
		if n == 0 {
			want = 1
		}
		if puts.Load() != want {
			t.Fatalf("request %d duplicated a bucket upload: %d PUTs", n, puts.Load())
		}
	}
	if counted.compressions.Load() != 1 || len(s.Snapshot().Items[0].Uploads) != 2 {
		t.Fatal("bucket switching recompressed or lost history")
	}
	s.Clear()
	if len(s.Snapshot().Items) != 0 || puts.Load() != 2 || deletes.Load() != 0 {
		t.Fatal("clear changed remote objects")
	}
	s.Restore()
	if len(s.Snapshot().Items) != 1 || len(s.Snapshot().Items[0].Uploads) != 2 {
		t.Fatal("undo lost multi-bucket history")
	}
	if err = s.Upload([]string{id}, "first", "html", confirmedBucketKey(t, storage, "first")); err != nil {
		t.Fatal(err)
	}
	miniIdle(t, s)
	if puts.Load() != 2 {
		t.Fatal("clear/undo permitted a duplicate upload")
	}
}
