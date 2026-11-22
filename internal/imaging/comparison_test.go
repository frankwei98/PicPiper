package imaging

import (
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func decodeComparison(t *testing.T, service *Service, comparison ComparisonImage) image.Image {
	t.Helper()
	reply := httptest.NewRecorder()
	service.ServeComparison(reply, httptest.NewRequest(http.MethodGet, comparison.URL, nil))
	if reply.Code != http.StatusOK || reply.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("comparison response %d, headers %v", reply.Code, reply.Header())
	}
	img, err := png.Decode(reply.Body)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestIsolatedComparisonBoundsPreviewAndReleasesPrivateFiles(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	original := image.NewNRGBA(image.Rect(0, 0, 1440, 80))
	original.SetNRGBA(1439, 79, color.NRGBA{R: 230, G: 123, B: 60, A: 100})
	source := fixture(t, original)
	forbidden := filepath.Join(service.dataDir, "caller-chosen.png")
	requested := request{TaskID: "comparison-test", Path: source, MaxSize: 1280, PreviewOutput: forbidden}
	fit := call(t, service, "read_comparison_image", requested).(ComparisonImage)
	if fit.Width != 1440 || fit.Height != 80 {
		t.Fatalf("comparison dimensions report the original size: %+v", fit)
	}
	if w := decodeComparison(t, service, fit).Bounds().Dx(); w != 1280 {
		t.Fatalf("fit width = %d", w)
	}
	requested.MaxSize = 0
	actual := call(t, service, "read_comparison_image", requested).(ComparisonImage)
	full := decodeComparison(t, service, actual)
	if full.Bounds() != original.Bounds() || full.At(1439, 79) != original.At(1439, 79) {
		t.Fatal("actual preview lost full size or transparency")
	}
	if _, err := os.Stat(forbidden); !os.IsNotExist(err) {
		t.Fatalf("caller-selected destination was accessed: %v", err)
	}
	call(t, service, "cancel_image_task", request{TaskID: requested.TaskID})
	for _, url := range []string{fit.URL, actual.URL, "/" + filepath.Base(source), "/../" + filepath.Base(source)} {
		recorder := httptest.NewRecorder()
		service.ServeComparison(recorder, httptest.NewRequest(http.MethodGet, url, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("unpublished image is accessible: %s (%d)", url, recorder.Code)
		}
	}
	entries, err := filepath.Glob(filepath.Join(service.previews.dir, "*.png"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("comparison cancellation did not free files: %v (%v)", entries, err)
	}
}

func TestComparisonStartupReapsAbandonedSessionsAndPreservesActiveOnes(t *testing.T) {
	dataDir := t.TempDir()
	newPreview := func() (*Service, string) {
		t.Helper()
		s := NewIsolated(dataDir)
		t.Cleanup(s.Close)
		path, err := s.previews.newPath()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("synthetic preview"), 0600); err != nil {
			t.Fatal(err)
		}
		return s, path
	}
	live, activePath := newPreview()
	abandoned, abandonedPath := newPreview()
	// The OS releases the session lease on process exit without removing PNGs.
	if err := abandoned.previews.lease.Close(); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(live.previews.root, "keep.txt")
	if err := os.WriteFile(unrelated, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}

	restarted := NewIsolated(dataDir)
	t.Cleanup(restarted.Close)
	if _, err := os.Stat(filepath.Dir(abandonedPath)); !os.IsNotExist(err) {
		t.Fatalf("abandoned session survived restart: %v", err)
	}
	for _, path := range []string{activePath, unrelated} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("startup removed %s: %v", path, err)
		}
	}
	live.Close()
	if _, err := os.Stat(filepath.Dir(activePath)); !os.IsNotExist(err) {
		t.Fatalf("normal close left an active session behind: %v", err)
	}
}
