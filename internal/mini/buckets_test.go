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

	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

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
		if err = s.Upload([]string{id}, target, "markdown"); err != nil {
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
	if err = s.Upload([]string{id}, "first", "html"); err != nil {
		t.Fatal(err)
	}
	miniIdle(t, s)
	if puts.Load() != 2 {
		t.Fatal("clear/undo permitted a duplicate upload")
	}
}
