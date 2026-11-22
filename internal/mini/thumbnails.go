package mini

import (
	"container/list"
	"context"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

const miniThumbnailCacheBytes = 2 << 20

// The service owns the cache across Mini windows. Its mutex also protects the
// record validity checks, so a late render cannot restore an expired entry.
type thumbCache struct {
	entries map[string]*list.Element
	recency list.List
	bytes   int
}

type thumbEntry struct {
	id, dataURL string
}

func (cache *thumbCache) get(id string) string {
	if entry := cache.entries[id]; entry != nil {
		cache.recency.MoveToFront(entry)
		return entry.Value.(thumbEntry).dataURL
	}
	return ""
}

func (cache *thumbCache) store(id, dataURL string) {
	if len(dataURL) > miniThumbnailCacheBytes {
		return
	}
	cache.forget(id)
	for cache.bytes+len(dataURL) > miniThumbnailCacheBytes {
		cache.forget(cache.recency.Back().Value.(thumbEntry).id)
	}
	if cache.entries == nil {
		cache.entries = make(map[string]*list.Element)
	}
	cache.entries[id] = cache.recency.PushFront(thumbEntry{id, dataURL})
	cache.bytes += len(dataURL)
}

func (cache *thumbCache) forget(id string) {
	element := cache.entries[id]
	if element == nil {
		return
	}
	entry := element.Value.(thumbEntry)
	delete(cache.entries, id)
	cache.recency.Remove(element)
	cache.bytes -= len(entry.dataURL)
}

func (s *Service) Thumbnail(ctx context.Context, id, taskID string) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.pruneLocked()
	path := s.thumbnailPathLocked(id)
	if path == "" {
		s.mu.Unlock()
		return nil, apperror.New("miniItemMissing", "This Mini result is no longer available.")
	}
	dataURL := s.thumbnails.get(id)
	s.mu.Unlock()
	if dataURL != "" {
		return map[string]string{"dataUrl": dataURL}, nil
	}

	var response map[string]string
	if err := s.imageCallContext(ctx, "read_thumbnail", map[string]any{"path": path, "taskId": taskID, "maxSize": 96}, &response); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.pruneLocked()
	if s.thumbnailPathLocked(id) != path {
		return nil, apperror.New("miniItemMissing", "This Mini result is no longer available.")
	}
	if dataURL := response["dataUrl"]; dataURL != "" {
		s.thumbnails.store(id, dataURL)
	}
	return response, nil
}

func (s *Service) thumbnailPathLocked(id string) string {
	for _, item := range s.items {
		if item.ID == id && item.Status == "completed" && !item.hidden {
			return item.outputPath
		}
	}
	return ""
}
