package cloud

import (
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

// NewWithThumbnails shares the app's bounded image workers instead of decoding
// remote objects on bridge goroutines. The renderer produces a small data URL.
func NewWithThumbnails(dataDir string, render func(context.Context, string) (string, error)) *Service {
	s := New(dataDir)
	s.renderThumbnail = render
	s.pruneThumbnails(filepath.Join(dataDir, "gallery-thumbnails"), thumbnailCacheBytes)
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
			s.pruneThumbnails(dir, thumbnailCacheBytes)
		}
	}
	s.thumbnailCacheMu.Unlock()
	if err != nil {
		return nil, err
	}
	return map[string]string{"dataUrl": dataURL}, nil
}

func (s *Service) pruneThumbnails(dir string, budget int64) {
	entries, _ := os.ReadDir(dir)
	type cached struct {
		name     string
		size     int64
		modified time.Time
	}
	files := []cached{}
	var total int64
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "source-") {
			if info, err := entry.Info(); err == nil && info.Mode().IsRegular() && s.now().Sub(info.ModTime()) > time.Hour {
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
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modified.Before(files[j].modified) })
	for _, file := range files {
		if total <= budget {
			break
		}
		if os.Remove(filepath.Join(dir, file.name)) == nil {
			total -= file.size
		}
	}
}

func (s *Service) removeGalleryThumbnails(ctx context.Context, p profile, key string) {
	s.thumbnailCacheMu.Lock()
	defer s.thumbnailCacheMu.Unlock()
	s.thumbnailEpoch++
	dir := filepath.Join(s.dataDir, "gallery-thumbnails")
	entries, _ := os.ReadDir(dir)
	prefix := thumbnailIdentity(p, key) + "-"
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), ".thumb") {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}

func (s *Service) cachedThumbnail(path string) (string, bool) {
	s.thumbnailCacheMu.Lock()
	defer s.thumbnailCacheMu.Unlock()
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maxThumbnailBytes+1))
	file.Close()
	if readErr == nil && validThumbnail(data) {
		_ = os.Chtimes(path, s.now(), s.now())
		return string(data), true
	}
	_ = os.Remove(path)
	return "", false
}
