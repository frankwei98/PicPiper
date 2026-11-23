package imaging

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/frankwei98/PicPiper/internal/filelock"
)

const ComparisonScheme = "picpiper-preview"

const comparisonSessionPrefix = "session-"

type ComparisonImage struct {
	URL        string `json:"url,omitempty"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SnapshotID string `json:"snapshotId,omitempty"`
}

type comparisonFiles struct {
	mu        sync.Mutex
	root      string
	dir       string
	lease     *os.File
	owners    map[string]string
	snapshots map[string]*comparisonSnapshot
}

type comparisonSnapshot struct {
	path    string
	taskID  string
	readers int
	retired bool
}

func (files *comparisonFiles) newPath() (string, error) {
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.dir == "" {
		if err := os.MkdirAll(files.root, 0700); err != nil {
			return "", err
		}
		// Serialize creating and locking a session with startup cleanup.
		guard, err := filelock.Open(filepath.Join(files.root, ".lock"), true)
		if err != nil {
			return "", err
		}
		defer guard.Close()
		dir, err := os.MkdirTemp(files.root, comparisonSessionPrefix)
		if err != nil {
			return "", err
		}
		lease, err := filelock.Open(filepath.Join(dir, ".lease"), false)
		if err != nil {
			_ = os.RemoveAll(dir)
			return "", err
		}
		files.dir, files.lease = dir, lease
		files.owners = make(map[string]string)
		files.snapshots = make(map[string]*comparisonSnapshot)
	}
	return filepath.Join(files.dir, rand.Text()+".png"), nil
}

func (files *comparisonFiles) removeAbandoned() {
	guard, err := filelock.Open(filepath.Join(files.root, ".lock"), false)
	if err != nil {
		return
	}
	defer guard.Close()
	entries, err := os.ReadDir(files.root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), comparisonSessionPrefix) {
			continue
		}
		dir := filepath.Join(files.root, entry.Name())
		lease, err := filelock.Open(filepath.Join(dir, ".lease"), false)
		if err != nil {
			continue
		}
		// Only a session whose owner released the lease can reach this point.
		// Close the handle before removing its directory on Windows.
		_ = lease.Close()
		_ = os.RemoveAll(dir)
	}
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
	for id, snapshot := range files.snapshots {
		if snapshot.taskID == taskID {
			delete(files.snapshots, id)
			snapshot.retired = true
			if snapshot.readers == 0 {
				_ = os.Remove(snapshot.path)
			}
		}
	}
}

func (files *comparisonFiles) borrowSnapshot(id string) (string, func(), error) {
	files.mu.Lock()
	defer files.mu.Unlock()
	snapshot := files.snapshots[id]
	if snapshot == nil {
		return "", nil, apperror.New("comparisonExpired", "The comparison image is no longer available. Reopen the comparison to try again.")
	}
	snapshot.readers++
	return snapshot.path, func() {
		files.mu.Lock()
		defer files.mu.Unlock()
		snapshot.readers--
		if snapshot.readers == 0 && (snapshot.retired || files.dir == "") {
			_ = os.Remove(snapshot.path)
			if files.dir == "" {
				_ = os.Remove(filepath.Dir(snapshot.path))
			}
		}
	}, nil
}

func (files *comparisonFiles) close() {
	files.mu.Lock()
	defer files.mu.Unlock()
	if files.dir != "" {
		_ = files.lease.Close()
		_ = os.RemoveAll(files.dir)
		files.dir, files.lease, files.owners, files.snapshots = "", nil, nil, nil
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
	var snapshotPath string
	published := false
	defer func() {
		if !published {
			_ = os.Remove(path)
			if snapshotPath != "" {
				_ = os.Remove(snapshotPath)
			}
		}
	}()
	if req.SnapshotID == "" && req.MaxSize > 0 && req.TaskID != "" {
		// Decode Fit from the same private bytes that a later 100% request
		// will use, even if the caller renames or edits the original in place.
		snapshotPath = filepath.Join(filepath.Dir(path), "source-"+strings.TrimSuffix(filepath.Base(path), ".png"))
		if err := copyComparisonSource(ctx, req.Path, snapshotPath); err != nil {
			return ComparisonImage{}, err
		}
		req.Path = snapshotPath
	}
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
	if snapshotPath != "" {
		preview.SnapshotID = filepath.Base(snapshotPath)
		s.previews.snapshots[preview.SnapshotID] = &comparisonSnapshot{path: snapshotPath, taskID: req.TaskID}
	}
	published = true
	preview.URL = ComparisonScheme + "://localhost/" + name
	if runtime.GOOS == "windows" {
		// WebView2 exposes MyGo's registered schemes on *.localhost.
		preview.URL = "http://" + ComparisonScheme + ".localhost/" + name
	}
	return preview, nil
}

func copyComparisonSource(ctx context.Context, path, snapshot string) error {
	// Check before opening to avoid blocking on a non-regular path.
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return apperror.New("comparisonUnavailable", "Choose a readable image under 256 MB to compare.")
	}
	source, err := os.Open(path)
	if err != nil {
		return apperror.New("imageOpenFailed", "Could not open the image. Choose a readable image file.")
	}
	defer source.Close()
	if info, err := source.Stat(); err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return apperror.New("comparisonUnavailable", "Choose a readable image under 256 MB to compare.")
	}
	output, err := os.OpenFile(snapshot, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return apperror.New("comparisonFailed", "Could not prepare the comparison. Check available disk space.")
	}
	written, copyErr := io.Copy(output, io.LimitReader(contextReader{ctx: ctx, reader: source}, (256<<20)+1))
	closeErr := output.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	if written > 256<<20 {
		return apperror.New("comparisonUnavailable", "Choose a readable image under 256 MB to compare.")
	}
	if copyErr != nil || closeErr != nil {
		return apperror.New("comparisonFailed", "Could not prepare the comparison. Check available disk space.")
	}
	return nil
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
	if s.executable != "" || s.executableErr != nil {
		encoded, err := s.isolated(ctx, workerClipboardOperation, request{Path: paths[0]})
		if err != nil {
			return nil, err
		}
		return encoded.([]byte), nil
	}
	var encoded bytes.Buffer
	if err := writeClipboardPNG(ctx, paths[0], &encoded); err != nil {
		return nil, err
	}
	return encoded.Bytes(), nil
}

func writeClipboardPNG(ctx context.Context, path string, output io.Writer) error {
	img, _, err := decode(ctx, path)
	if err != nil {
		return err
	}
	if err := encodePNG(output, img); err != nil {
		return apperror.New("clipboardFailed", "Could not prepare the clipboard image.")
	}
	return ctx.Err()
}
