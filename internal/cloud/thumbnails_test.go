package cloud

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGalleryThumbnailPersistsAcrossRestartAndTracksObjectVersion(t *testing.T) {
	dir := t.TempDir()
	var downloads, renders atomic.Int32
	renderer := func(ctx context.Context, path string) (string, error) {
		renders.Add(1)
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "synthetic-image" {
			return "", fmt.Errorf("missing downloaded input")
		}
		return "data:image/png;base64,c3ludGhldGlj", nil
	}
	service := func() *Service {
		s := NewWithThumbnails(dir, renderer)
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			downloads.Add(1)
			if r.URL.Host != "s3.example.test" || r.URL.Path != "/images/a/photo.png" || !strings.Contains(r.Header.Get("Authorization"), "Credential=access/") {
				t.Errorf("thumbnail did not use signed S3 object request")
			}
			return r2Response(200, "synthetic-image"), nil
		})
		return s
	}
	s := service()
	p := testProfile("https://s3.example.test")
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"profile": p, "key": "a/photo.png", "size": 15, "etag": "version1"}
	for range 2 {
		result, err := call(t, s, "read_gallery_thumbnail", request)
		if err != nil {
			t.Fatal(err)
		}
		if result.(map[string]string)["dataUrl"] != "data:image/png;base64,c3ludGhldGlj" {
			t.Fatal("thumbnail missing")
		}
		s = service() // A new service must reuse the persisted thumbnail without S3.
	}
	if downloads.Load() != 1 || renders.Load() != 1 {
		t.Fatal("thumbnail was downloaded or rendered again")
	}
	request["etag"] = "version2"
	if _, err := call(t, s, "read_gallery_thumbnail", request); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 2 {
		t.Fatal("changed ETag reused stale thumbnail")
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "gallery-thumbnails", "source-*"))
	if len(matches) != 0 {
		t.Fatal("full downloaded image left on disk")
	}
}

func TestGalleryThumbnailBoundsDownloadsAndRejectsUnsafeKeys(t *testing.T) {
	s := NewWithThumbnails(t.TempDir(), func(context.Context, string) (string, error) {
		t.Fatal("oversize image reached decoder")
		return "", nil
	})
	p := testProfile("https://s3.example.test")
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	var downloads atomic.Int32
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
		downloads.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("too large")), ContentLength: maxThumbnailSourceBytes + 1}, nil
	})
	for _, key := range []string{"../escape.png", "a/../../escape.png"} {
		if _, err := call(t, s, "read_gallery_thumbnail", map[string]any{"profile": p, "key": key}); err == nil {
			t.Fatal("unsafe key accepted")
		}
	}
	if downloads.Load() != 0 {
		t.Fatal("unsafe key reached S3")
	}
	if _, err := call(t, s, "read_gallery_thumbnail", map[string]any{"profile": p, "key": "image.png"}); err == nil {
		t.Fatal("oversize response accepted")
	}
	files, _ := filepath.Glob(filepath.Join(s.dataDir, "gallery-thumbnails", "*"))
	if len(files) != 0 {
		t.Fatal("failed thumbnail left cache files")
	}
}

func TestGalleryThumbnailConcurrentMissesDownloadOnce(t *testing.T) {
	s := NewWithThumbnails(t.TempDir(), func(context.Context, string) (string, error) { return "data:image/png;base64,c3ludGhldGlj", nil })
	p := testProfile("https://s3.example.test")
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	var downloads atomic.Int32
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) { downloads.Add(1); return r2Response(200, "image"), nil })
	var group sync.WaitGroup
	for range 6 {
		group.Go(func() {
			if _, err := call(t, s, "read_gallery_thumbnail", map[string]any{"profile": p, "key": "a.png", "etag": "v1"}); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	if downloads.Load() != 1 {
		t.Fatalf("duplicate downloads: %d", downloads.Load())
	}
}

func TestThumbnailCacheEvictsLeastRecentlyUsedAndDeletionClearsVersions(t *testing.T) {
	s := New(t.TempDir())
	dir := filepath.Join(s.dataDir, "gallery-thumbnails")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	p := testProfile("https://s3.example.test")
	prefix := thumbnailIdentity(p, "image.png")
	data := "data:image/png;base64,c3ludGhldGlj"
	for i := range 3 {
		path := filepath.Join(dir, fmt.Sprintf("%s-%d.thumb", prefix, i))
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		modified := time.Unix(int64(i), 0)
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	s.refreshThumbnailCacheLocked(dir)
	if cached, ok := s.cachedThumbnail(filepath.Join(dir, prefix+"-0.thumb")); !ok || cached != data {
		t.Fatal("oldest thumbnail missing before eviction")
	}
	s.pruneThumbnailsLocked(dir, 2*int64(len(data)))
	if _, err := os.Stat(filepath.Join(dir, prefix+"-1.thumb")); !os.IsNotExist(err) {
		t.Fatal("least recently used thumbnail retained")
	}
	if _, err := os.Stat(filepath.Join(dir, prefix+"-0.thumb")); err != nil {
		t.Fatal("recently accessed thumbnail was evicted")
	}
	if err := os.WriteFile(filepath.Join(dir, prefix+"-external.thumb"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) { return r2Response(204, ""), nil })
	if _, err := call(t, s, "delete_gallery_object", map[string]any{"profile": p, "key": "image.png"}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 || s.thumbnails.bytes != 0 {
		t.Fatal("deleted object left cached thumbnails")
	}
}

func TestThumbnailCacheReplacesCorruptFilesAndForgetsMissingFiles(t *testing.T) {
	dataDir := t.TempDir()
	dir := filepath.Join(dataDir, "gallery-thumbnails")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	p := testProfile("https://s3.example.test")
	const data = "data:image/png;base64,c3ludGhldGlj"
	corrupt := filepath.Join(dir, "corrupt.thumb")
	missing := filepath.Join(dir, "missing.thumb")
	for _, path := range []string{corrupt, missing} {
		if err := os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s := NewWithThumbnails(dataDir, func(context.Context, string) (string, error) { return data, nil })
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{corrupt, missing} {
		if _, ok := s.cachedThumbnail(path); ok {
			t.Fatal("bad cache file was treated as a hit")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("bad cache file remains: %v", err)
		}
	}
	if s.thumbnails.bytes != 0 {
		t.Fatalf("bad cache files are still counted: %d bytes", s.thumbnails.bytes)
	}
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) { return r2Response(200, "image"), nil })
	req := thumbnailRequest{Profile: p, Key: "recovered.png"}
	for range 2 {
		if _, err := s.readGalleryThumbnail(context.Background(), req); err != nil {
			t.Fatal(err)
		}
		if s.thumbnails.bytes != int64(len(data)) {
			t.Fatalf("cache write or hit miscounted the file: %d bytes", s.thumbnails.bytes)
		}
	}
}

func TestCachedThumbnailsAndDeletionDoNotWaitForRendering(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	s := NewWithThumbnails(t.TempDir(), func(ctx context.Context, path string) (string, error) {
		data, _ := os.ReadFile(path)
		if string(data) == "blocked" {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return "data:image/png;base64,c3ludGhldGlj", nil
	})
	p := testProfile("https://s3.example.test")
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodDelete {
			return r2Response(204, ""), nil
		}
		if strings.HasSuffix(r.URL.Path, "blocked.png") {
			return r2Response(200, "blocked"), nil
		}
		return r2Response(200, "cached"), nil
	})
	cached := thumbnailRequest{Profile: p, Key: "cached.png", ETag: "v1"}
	if _, err := s.readGalleryThumbnail(context.Background(), cached); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.readGalleryThumbnail(context.Background(), thumbnailRequest{Profile: p, Key: "blocked.png"})
		done <- err
	}()
	defer func() {
		releaseOnce()
		if err := <-done; err != nil {
			t.Error(err)
		}
		files, _ := filepath.Glob(filepath.Join(s.dataDir, "gallery-thumbnails", thumbnailIdentity(p, "blocked.png")+"-*.thumb"))
		if len(files) != 0 {
			t.Error("in-flight rendering republished deleted thumbnail")
		}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("render did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.readGalleryThumbnail(ctx, cached); err != nil {
		t.Fatalf("cache hit waited for renderer: %v", err)
	}
	deleted := make(chan struct{})
	go func() { s.removeGalleryThumbnails(context.Background(), p, "blocked.png"); close(deleted) }()
	select {
	case <-deleted:
	case <-time.After(time.Second):
		t.Fatal("cache deletion waited for renderer")
	}
}

func TestThumbnailStartupRemovesOnlyStaleSources(t *testing.T) {
	dir := t.TempDir()
	cache := filepath.Join(dir, "gallery-thumbnails")
	os.MkdirAll(cache, 0700)
	old, fresh := filepath.Join(cache, "source-stale"), filepath.Join(cache, "source-active")
	os.WriteFile(old, []byte("old"), 0600)
	os.WriteFile(fresh, []byte("new"), 0600)
	past := time.Now().Add(-2 * time.Hour)
	os.Chtimes(old, past, past)
	NewWithThumbnails(dir, nil)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("stale source remained")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("active source removed")
	}
}
