package cloud

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxThumbnailSourceBytes int64 = 128 << 20
const maxThumbnailBytes int64 = 2 << 20
const thumbnailCacheBytes int64 = 128 << 20
const thumbnailSourceLifetime = time.Hour

// The thumbnail cache mutex protects the index and the corresponding file changes.
type thumbnailCache struct {
	entries map[string]*list.Element
	recency list.List
	bytes   int64
	scanned time.Time
}

type thumbnailCacheEntry struct {
	name string
	size int64
}

func (c *thumbnailCache) touch(name string, size int64) {
	if element := c.entries[name]; element != nil {
		entry := element.Value.(*thumbnailCacheEntry)
		c.bytes += size - entry.size
		entry.size = size
		c.recency.MoveToFront(element)
		return
	}
	c.entries[name] = c.recency.PushFront(&thumbnailCacheEntry{name: name, size: size})
	c.bytes += size
}

func (c *thumbnailCache) forget(name string) {
	if element := c.entries[name]; element != nil {
		c.bytes -= element.Value.(*thumbnailCacheEntry).size
		c.recency.Remove(element)
		delete(c.entries, name)
	}
}

// NewWithThumbnails shares the app's bounded image workers instead of decoding
// remote objects on bridge goroutines. The renderer produces a small data URL.
func NewWithThumbnails(dataDir string, render func(context.Context, string) (string, error)) *Service {
	s := New(dataDir)
	s.renderThumbnail = render
	s.refreshThumbnailCacheLocked(filepath.Join(dataDir, "gallery-thumbnails"))
	return s
}

type thumbnailRequest struct {
	Profile      profile `json:"profile"`
	Key          string  `json:"key"`
	ETag         string  `json:"etag"`
	Size         int64   `json:"size"`
	LastModified *string `json:"lastModified"`
}

func thumbnailIdentity(p profile, key string) string {
	data, _ := json.Marshal([]any{p.ID, p.Endpoint, p.Region, p.Bucket, p.PathStyle, p.AccessKeyID, key})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func validThumbnail(data []byte) bool {
	return int64(len(data)) <= maxThumbnailBytes && (strings.HasPrefix(string(data), "data:image/png;base64,") || strings.HasPrefix(string(data), "data:image/jpeg;base64,"))
}

func (s *Service) readGalleryThumbnail(ctx context.Context, p thumbnailRequest) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateProfile(p.Profile); err != nil {
		return nil, err
	}
	if err := validateKey(p.Key); err != nil {
		return nil, err
	}
	if !isImage(p.Key) {
		return nil, appErr("thumbnailUnavailable", "This object is not an image.")
	}
	version, _ := json.Marshal([]any{"v1-384", p.ETag, p.Size, p.LastModified})
	hash := sha256.Sum256(version)
	dir := filepath.Join(s.dataDir, "gallery-thumbnails")
	cachePath := filepath.Join(dir, thumbnailIdentity(p.Profile, p.Key)+"-"+hex.EncodeToString(hash[:])+".thumb")
	if data, ok := s.cachedThumbnail(cachePath); ok {
		return map[string]string{"dataUrl": data}, nil
	}
	// Only misses need the bounded renderer slot. Recheck after acquiring it
	// so concurrent requests for the same object share the completed cache.
	select {
	case s.thumbnailSlot <- struct{}{}:
		defer func() { <-s.thumbnailSlot }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if data, ok := s.cachedThumbnail(cachePath); ok {
		return map[string]string{"dataUrl": data}, nil
	}
	s.thumbnailCacheMu.Lock()
	epoch := s.thumbnailEpoch
	s.thumbnailCacheMu.Unlock()
	if s.renderThumbnail == nil {
		return nil, appErr("thumbnailUnavailable", "Image preview is unavailable.")
	}
	if p.Size > maxThumbnailSourceBytes {
		return nil, appErr("thumbnailTooLarge", "This image is too large for a thumbnail.")
	}
	secret, err := s.getSecret(p.Profile, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.doS3(ctx, p.Profile, secret, http.MethodGet, p.Key, nil, "", nil)
	if err != nil {
		return nil, appErr("thumbnailDownloadFailed", "Could not download the image thumbnail source.")
	}
	defer resp.Body.Close()
	if resp.ContentLength > maxThumbnailSourceBytes {
		return nil, appErr("thumbnailTooLarge", "This image is too large for a thumbnail.")
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return nil, appErr("thumbnailCacheFailed", "Could not create the thumbnail cache.")
	}
	source, err := os.CreateTemp(dir, "source-*")
	if err != nil {
		return nil, appErr("thumbnailCacheFailed", "Could not prepare the image thumbnail.")
	}
	defer os.Remove(source.Name())
	written, copyErr := io.Copy(source, io.LimitReader(resp.Body, maxThumbnailSourceBytes+1))
	closeErr := source.Close()
	if copyErr != nil || closeErr != nil {
		return nil, appErr("thumbnailDownloadFailed", "Could not download the image thumbnail source.")
	}
	if written > maxThumbnailSourceBytes {
		return nil, appErr("thumbnailTooLarge", "This image is too large for a thumbnail.")
	}
	dataURL, err := s.renderThumbnail(ctx, source.Name())
	if err != nil {
		return nil, err
	}
	if !validThumbnail([]byte(dataURL)) {
		return nil, appErr("thumbnailUnavailable", "Could not generate the image thumbnail.")
	}
	s.thumbnailCacheMu.Lock()
	// Deletion never waits for network/rendering. A deletion during this miss
	// invalidates its publication, so an in-flight renderer cannot undo it.
	if epoch == s.thumbnailEpoch {
		err = atomicWrite(cachePath, []byte(dataURL), 0600, "thumbnailCacheFailed")
		if err == nil {
			s.thumbnails.touch(filepath.Base(cachePath), int64(len(dataURL)))
			s.pruneThumbnailsLocked(dir, thumbnailCacheBytes)
		}
	}
	s.thumbnailCacheMu.Unlock()
	if err != nil {
		return nil, err
	}
	return map[string]string{"dataUrl": dataURL}, nil
}

func (s *Service) refreshThumbnailCacheLocked(dir string) {
	now := s.now()
	cache := &s.thumbnails
	if cache.entries != nil && now.Sub(cache.scanned) < thumbnailSourceLifetime {
		return
	}
	// Reconcile files left by earlier app runs and occasionally clean abandoned
	// downloads. Normal hits and writes only update one index entry.
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) && cache.entries != nil {
		cache.scanned = now
		return
	}
	type cached struct {
		name     string
		size     int64
		modified time.Time
	}
	files := make([]cached, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "source-") {
			if info, err := entry.Info(); err == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > thumbnailSourceLifetime {
				_ = os.Remove(filepath.Join(dir, entry.Name()))
			}
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".thumb") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, cached{entry.Name(), info.Size(), info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modified.Before(files[j].modified) })
	cache.scanned = now
	cache.entries = make(map[string]*list.Element, len(files))
	cache.recency.Init()
	cache.bytes = 0
	for _, file := range files {
		cache.touch(file.name, file.size)
	}
	s.pruneThumbnailsLocked(dir, thumbnailCacheBytes)
}

func (s *Service) pruneThumbnailsLocked(dir string, budget int64) {
	cache := &s.thumbnails
	for oldest := cache.recency.Back(); oldest != nil && cache.bytes > budget; {
		previous := oldest.Prev()
		s.removeCachedThumbnailLocked(dir, oldest.Value.(*thumbnailCacheEntry).name)
		oldest = previous
	}
}

func (s *Service) removeCachedThumbnailLocked(dir, name string) {
	if err := os.Remove(filepath.Join(dir, name)); err == nil || os.IsNotExist(err) {
		s.thumbnails.forget(name)
	}
}

func (s *Service) removeGalleryThumbnails(ctx context.Context, p profile, key string) {
	s.thumbnailCacheMu.Lock()
	defer s.thumbnailCacheMu.Unlock()
	s.thumbnailEpoch++
	dir := filepath.Join(s.dataDir, "gallery-thumbnails")
	prefix := thumbnailIdentity(p, key) + "-"
	for name := range s.thumbnails.entries {
		if strings.HasPrefix(name, prefix) {
			s.removeCachedThumbnailLocked(dir, name)
		}
	}
	// An instance using the same data folder may have written another version
	// since the last scan.
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), ".thumb") && s.thumbnails.entries[entry.Name()] == nil {
			s.removeCachedThumbnailLocked(dir, entry.Name())
		}
	}
}

func (s *Service) cachedThumbnail(path string) (string, bool) {
	s.thumbnailCacheMu.Lock()
	defer s.thumbnailCacheMu.Unlock()
	dir, name := filepath.Dir(path), filepath.Base(path)
	s.refreshThumbnailCacheLocked(dir)
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			s.thumbnails.forget(name)
		}
		return "", false
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxThumbnailBytes+1))
	file.Close()
	if readErr == nil && validThumbnail(data) {
		_ = os.Chtimes(path, s.now(), s.now())
		s.thumbnails.touch(name, int64(len(data)))
		s.pruneThumbnailsLocked(dir, thumbnailCacheBytes)
		return string(data), true
	}
	s.removeCachedThumbnailLocked(dir, name)
	return "", false
}
