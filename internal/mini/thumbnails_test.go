package mini

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type thumbnailImageCaller func(context.Context, string, json.RawMessage) (any, error)

func (f thumbnailImageCaller) Call(ctx context.Context, operation string, raw json.RawMessage) (any, error) {
	return f(ctx, operation, raw)
}

func TestMiniThumbnailReusesResultThroughClearAndRestore(t *testing.T) {
	const dataURL = "data:image/png;base64,AA=="
	base := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	calls := 0
	images := thumbnailImageCaller(func(_ context.Context, operation string, raw json.RawMessage) (any, error) {
		calls++
		var request struct {
			Path    string `json:"path"`
			TaskID  string `json:"taskId"`
			MaxSize int    `json:"maxSize"`
		}
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
		if operation != "read_thumbnail" || request.Path != "finished.png" || request.MaxSize != 96 {
			t.Fatalf("unexpected thumbnail request %s %+v", operation, request)
		}
		return map[string]any{"dataUrl": dataURL}, nil
	})
	s := newThumbnailTestService(t, images, base, "finished")
	ctx := context.Background()
	read := func(taskID string) {
		t.Helper()
		value, err := s.Thumbnail(ctx, "finished", taskID)
		if err != nil {
			t.Fatal(err)
		}
		if encoded, err := json.Marshal(value); err != nil || string(encoded) != `{"dataUrl":"`+dataURL+`"}` {
			t.Fatalf("unexpected thumbnail %s (%v)", encoded, err)
		}
	}
	missing := func(taskID string) {
		t.Helper()
		value, err := s.Thumbnail(ctx, "finished", taskID)
		var failure *apperror.Error
		if value != nil || !errors.As(err, &failure) || failure.Code != "miniItemMissing" {
			t.Fatalf("unavailable result returned %v (%v)", value, err)
		}
	}

	read("first-panel")
	read("reopened-panel")
	s.Clear()
	missing("hidden")
	s.Restore()
	read("restored")
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.Thumbnail(canceled, "finished", "canceled"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cached result ignored cancellation: %v", err)
	}

	s.mu.Lock()
	s.now = func() time.Time { return base.Add(resultLifetime) }
	s.mu.Unlock()
	missing("expired")
	if calls != 1 {
		t.Fatalf("rendered the thumbnail %d times, want 1", calls)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.thumbnails.entries) != 0 || s.thumbnails.bytes != 0 {
		t.Fatal("expired result retained its cached thumbnail")
	}
}

func TestMiniThumbnailRetriesCanceledRender(t *testing.T) {
	images := thumbnailImageCaller(func(_ context.Context, _ string, raw json.RawMessage) (any, error) {
		var request struct {
			TaskID string `json:"taskId"`
		}
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
		if request.TaskID == "canceled" {
			return nil, context.Canceled
		}
		return map[string]string{"dataUrl": "data:image/png;base64,AA=="}, nil
	})
	s := newThumbnailTestService(t, images, time.Now(), "finished")
	if _, err := s.Thumbnail(context.Background(), "finished", "canceled"); !errors.Is(err, context.Canceled) {
		t.Fatalf("renderer cancellation was lost: %v", err)
	}
	if result, err := s.Thumbnail(context.Background(), "finished", "retry"); err != nil || result == nil {
		t.Fatalf("retry returned %v (%v)", result, err)
	}
}

func TestMiniThumbnailEvictsLeastRecentlyUsedByBytes(t *testing.T) {
	const prefix = "data:image/png;base64,"
	dataURL := prefix + strings.Repeat("AAAA", (miniThumbnailCacheBytes/2-len(prefix))/4)
	var rendered []string
	images := thumbnailImageCaller(func(_ context.Context, _ string, raw json.RawMessage) (any, error) {
		var request struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
		rendered = append(rendered, request.Path)
		return map[string]string{"dataUrl": dataURL}, nil
	})
	s := newThumbnailTestService(t, images, time.Now(), "a", "b", "c")
	for _, id := range []string{"a", "b", "a", "c", "a", "b"} {
		if _, err := s.Thumbnail(context.Background(), id, "thumbnail-"+id); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"a.png", "b.png", "c.png", "b.png"}
	if !slices.Equal(rendered, want) {
		t.Fatalf("renderer saw %v, want %v", rendered, want)
	}
}

func newThumbnailTestService(t *testing.T, images imageCaller, now time.Time, ids ...string) *Service {
	t.Helper()
	s := New(images, nil, nil, nil)
	t.Cleanup(s.Close)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = func() time.Time { return now }
	for _, id := range ids {
		s.items = append(s.items, Item{ID: id, Status: "completed", CompletedAt: now, outputPath: id + ".png"})
	}
	return s
}
