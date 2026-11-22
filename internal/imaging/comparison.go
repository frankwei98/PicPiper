package imaging

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

const ComparisonScheme = "picpiper-preview"

type ComparisonImage struct {
	URL    string `json:"url,omitempty"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type comparisonFiles struct {
	mu     sync.Mutex
	dir    string
	owners map[string]string
}

func (files *comparisonFiles) newPath() (string, error) {
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.dir == "" {
		dir, err := os.MkdirTemp("", "picpiper-preview-")
		if err != nil {
			return "", err
		}
		files.dir = dir
		files.owners = make(map[string]string)
	}
	return filepath.Join(files.dir, rand.Text()+".png"), nil
}

func (files *comparisonFiles) release(taskID string) {
	files.mu.Lock()
	defer files.mu.Unlock()
	for name, owner := range files.owners {
		if owner == taskID {
			delete(files.owners, name)
			_ = os.Remove(filepath.Join(files.dir, name))
		}
	}
}

func (files *comparisonFiles) close() {
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.dir != "" {
		_ = os.RemoveAll(files.dir)
		files.dir, files.owners = "", nil
	}
}

// ServeComparison serves only generated, published PNGs identified by random URLs.
func (s *Service) ServeComparison(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	files := &s.previews
	name := strings.TrimPrefix(r.URL.Path, "/")
	files.mu.Lock()
	if _, found := files.owners[name]; !found {
		files.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(files.dir, name)
	file, err := os.Open(path)
	files.mu.Unlock()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() {
		_ = file.Close()
		files.mu.Lock()
		defer files.mu.Unlock()
		if _, found := files.owners[name]; !found {
			// Windows can defer removal until the active reader closes.
			_ = os.Remove(path)
			if files.dir == "" {
				_ = os.Remove(filepath.Dir(path))
			}
		}
	}()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, time.Time{}, file)
}

func (s *Service) comparison(ctx context.Context, req request) (ComparisonImage, error) {
	path, err := s.previews.newPath()
	if err != nil {
		return ComparisonImage{}, err
	}
	req.PreviewOutput = path
	published := false
	defer func() {
		if !published {
			_ = os.Remove(path)
		}
	}()
	preview, err := s.renderPNGFile(ctx, req)
	if err != nil {
		return ComparisonImage{}, err
	}
	s.previews.mu.Lock()
	defer s.previews.mu.Unlock()
	// Cancellation precedes taking this lock to release all of the task's URLs.
	if err := ctx.Err(); err != nil {
		return ComparisonImage{}, err
	}
	name := filepath.Base(path)
	s.previews.owners[name] = req.TaskID
	published = true
	preview.URL = ComparisonScheme + "://localhost/" + name
	if runtime.GOOS == "windows" {
		// WebView2 exposes MyGo's registered schemes on *.localhost.
		preview.URL = "http://" + ComparisonScheme + ".localhost/" + name
	}
	return preview, nil
}

func (s *Service) renderPNGFile(ctx context.Context, req request) (ComparisonImage, error) {
	if s.executable == "" && s.executableErr == nil {
		return renderPreviewPNG(ctx, req)
	}
	value, err := s.isolated(ctx, "render_preview_png", req)
	if err != nil {
		return ComparisonImage{}, err
	}
	return value.(ComparisonImage), nil
}

func renderPreviewPNG(ctx context.Context, req request) (ComparisonImage, error) {
	img, _, err := decode(ctx, req.Path)
	if err != nil {
		return ComparisonImage{}, err
	}
	width, height := img.Bounds().Dx(), img.Bounds().Dy()
	if limit := min(req.MaxSize, 1280); limit > 0 && max(width, height) > limit {
		scale := float64(limit) / float64(max(width, height))
		img = resizePreservingDepth(img, max(1, int(float64(width)*scale)), max(1, int(float64(height)*scale)))
	}
	file, err := os.OpenFile(req.PreviewOutput, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return ComparisonImage{}, err
	}
	err = encodePNG(file, img)
	closeErr := file.Close()
	if err != nil {
		return ComparisonImage{}, err
	}
	if closeErr != nil {
		return ComparisonImage{}, closeErr
	}
	return ComparisonImage{Width: width, Height: height}, ctx.Err()
}

// ClipboardPNG produces full-resolution PNG bytes for the native clipboard.
func (s *Service) ClipboardPNG(ctx context.Context, path string) ([]byte, error) {
	payload, _ := json.Marshal(request{Path: path})
	value, err := s.Call(ctx, "copy_image_png", payload)
	if err != nil {
		return nil, err
	}
	return value.([]byte), nil
}

func (s *Service) clipboardPNG(ctx context.Context, source string) ([]byte, error) {
	paths, err := s.OutputPaths([]string{source})
	if err != nil {
		return nil, err
	}
	path, err := s.previews.newPath()
	if err != nil {
		return nil, err
	}
	defer os.Remove(path)
	if _, err = s.renderPNGFile(ctx, request{Path: paths[0], PreviewOutput: path}); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, apperror.New("clipboardFailed", "Could not prepare the clipboard image.")
	}
	return data, ctx.Err()
}
