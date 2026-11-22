package cloud

import (
	"container/list"
	"context"
	"crypto/rand"
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

	"github.com/frankwei98/PicPiper/internal/filelock"
)

const maxThumbnailSourceBytes int64 = 128 << 20
const maxThumbnailBytes int64 = 2 << 20
const thumbnailCacheBytes int64 = 128 << 20
const thumbnailSourceLifetime = time.Hour

// The mutex protects this index; the file lock coordinates access to the
// shared directory with other running instances.
type thumbnailCache struct {
	entries           map[string]*list.Element
	recency           list.List
	bytes             int64
	scanned           time.Time
	generation        thumbnailGeneration
	recencyGeneration thumbnailGeneration
	recencyStale      bool
}

type thumbnailCacheEntry struct {
	name string
	size int64
}

func (c *thumbnailCache) size(name string) int64 {
	if element := c.entries[name]; element != nil {
		return element.Value.(*thumbnailCacheEntry).size
	}
	return 0
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
	dir := filepath.Join(dataDir, "gallery-thumbnails")
	if guard, err := s.lockThumbnailCache(dir); err == nil {
		if s.thumbnails.bytes > thumbnailCacheBytes && s.invalidateThumbnailIndex(guard) == nil {
			s.pruneThumbnailsLocked(dir, thumbnailCacheBytes)
		}
		_ = guard.Close()
	}
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
		err = s.storeThumbnailLocked(dir, cachePath, dataURL)
	}
	s.thumbnailCacheMu.Unlock()
	if err != nil {
		return nil, err
	}
	return map[string]string{"dataUrl": dataURL}, nil
}

// Byte zero is reserved for the Windows file lock. Byte-count changes require
// a fresh index; recency changes matter only when choosing what to evict.
const (
	thumbnailGenerationSize   = 16
	thumbnailGenerationOffset = 1
	thumbnailRecencyOffset    = thumbnailGenerationOffset + thumbnailGenerationSize
)

type thumbnailGeneration [thumbnailGenerationSize]byte

func (s *Service) lockThumbnailCache(dir string) (*os.File, error) {
	guard, err := filelock.Open(dir+".lock", true)
	if err != nil {
		return nil, err
	}
	var versions [2 * thumbnailGenerationSize]byte
	_, err = guard.ReadAt(versions[:], thumbnailGenerationOffset)
	if err == nil || err == io.EOF {
		generation := thumbnailGeneration(versions[:thumbnailGenerationSize])
		recency := thumbnailGeneration(versions[thumbnailGenerationSize:])
		cache := &s.thumbnails
		if cache.generation != generation {
			cache.scanned = time.Time{}
		}
		cache.recencyStale = cache.recencyStale || cache.recencyGeneration != recency
		err = s.refreshThumbnailCacheLocked(dir)
		if err == nil {
			cache.generation, cache.recencyGeneration = generation, recency
			return guard, nil
		}
	}
	_ = guard.Close()
	return nil, err
}

func updateThumbnailGeneration(guard *os.File, offset int64, current *thumbnailGeneration) error {
	// Publish before touching files so the next lock holder reconciles even if
	// this instance exits before completing the change.
	var generation thumbnailGeneration
	rand.Read(generation[:])
	if _, err := guard.WriteAt(generation[:], offset); err != nil {
		return err
	}
	*current = generation
	return nil
}

func (s *Service) invalidateThumbnailIndex(guard *os.File) error {
	return updateThumbnailGeneration(guard, thumbnailGenerationOffset, &s.thumbnails.generation)
}

func (s *Service) storeThumbnailLocked(dir, path, dataURL string) error {
	guard, err := s.lockThumbnailCache(dir)
	if err != nil {
		return appErr("thumbnailCacheFailed", "Could not write the thumbnail cache.")
	}
	defer guard.Close()
	name, size := filepath.Base(path), int64(len(dataURL))
	if s.thumbnails.bytes-s.thumbnails.size(name)+size > thumbnailCacheBytes {
		if err := s.refreshThumbnailRecencyLocked(dir); err != nil {
			return appErr("thumbnailCacheFailed", "Could not write the thumbnail cache.")
		}
	}
	if err := s.invalidateThumbnailIndex(guard); err != nil {
		return appErr("thumbnailCacheFailed", "Could not write the thumbnail cache.")
	}
	if err := atomicWrite(path, []byte(dataURL), 0600, "thumbnailCacheFailed"); err != nil {
		return err
	}
	s.thumbnails.touch(name, size)
	s.pruneThumbnailsLocked(dir, thumbnailCacheBytes)
	return nil
}

func (s *Service) refreshThumbnailRecencyLocked(dir string) error {
	if !s.thumbnails.recencyStale {
		return nil
	}
	s.thumbnails.scanned = time.Time{}
	return s.refreshThumbnailCacheLocked(dir)
}

func (s *Service) refreshThumbnailCacheLocked(dir string) error {
	now := s.now()
	cache := &s.thumbnails
	if cache.entries != nil && !cache.scanned.IsZero() && now.Sub(cache.scanned) < thumbnailSourceLifetime {
		return nil
	}
	// Reconcile other instances' changes and occasionally clean abandoned
	// downloads. Normal hits and writes only update one index entry.
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return err
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
	cache.recencyStale = false
	cache.entries = make(map[string]*list.Element, len(files))
	cache.recency.Init()
	cache.bytes = 0
	for _, file := range files {
		cache.touch(file.name, file.size)
	}
	return nil
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
	guard, err := s.lockThumbnailCache(dir)
	if err != nil {
		return
	}
	defer guard.Close()
	if s.invalidateThumbnailIndex(guard) != nil {
		return
	}
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
	guard, err := s.lockThumbnailCache(dir)
	if err != nil {
		return "", false
	}
	defer guard.Close()
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
		cache, size := &s.thumbnails, int64(len(data))
		if cache.size(name) != size {
			// An older instance may have written without updating the index generation.
			cache.scanned = time.Time{}
			if err := s.refreshThumbnailCacheLocked(dir); err != nil {
				return string(data), true
			}
		}
		if updateThumbnailGeneration(guard, thumbnailRecencyOffset, &cache.recencyGeneration) == nil {
			if now := s.now(); os.Chtimes(path, now, now) == nil {
				cache.touch(name, size)
			}
		}
		if cache.bytes > thumbnailCacheBytes && s.refreshThumbnailRecencyLocked(dir) == nil && s.invalidateThumbnailIndex(guard) == nil {
			s.pruneThumbnailsLocked(dir, thumbnailCacheBytes)
		}
		return string(data), true
	}
	if s.invalidateThumbnailIndex(guard) == nil {
		s.removeCachedThumbnailLocked(dir, name)
	}
	return "", false
}
