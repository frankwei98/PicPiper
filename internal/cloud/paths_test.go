package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

func requirePathError(t *testing.T, err error, code string) {
	t.Helper()
	var business *apperror.Error
	if !errors.As(err, &business) || business.Code != code {
		t.Fatalf("error = %v, want structured error %q", err, code)
	}
}

func TestCallRejectsApplicationPrivatePaths(t *testing.T) {
	dataDir := t.TempDir()
	externalDir := t.TempDir()
	privateFile := filepath.Join(dataDir, "private.png")
	if err := os.WriteFile(privateFile, []byte("synthetic-private-image"), 0600); err != nil {
		t.Fatal(err)
	}
	privateLink := filepath.Join(t.TempDir(), "private-link")
	if err := os.Symlink(dataDir, privateLink); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	s := New(dataDir)
	p := testProfile(server.URL)
	if _, err := s.saveSecret(p.ID, "synthetic-secret"); err != nil {
		t.Fatal(err)
	}
	credentialPath := s.secretPath(p.ID)
	cacheDir := filepath.Join(dataDir, "optimizer-cache")
	if err := os.MkdirAll(cacheDir, 0700); err != nil {
		t.Fatal(err)
	}
	cacheEscapeLink := filepath.Join(cacheDir, "escape.png")
	if err := os.Symlink(credentialPath, cacheEscapeLink); err != nil {
		t.Fatal(err)
	}
	cacheCredentialLink := filepath.Join(cacheDir, "credential.png")
	externalCredentialLink := filepath.Join(externalDir, "credential.png")
	if err := s.saveSettings(defaults()); err != nil {
		t.Fatal(err)
	}
	externalSettingsLink := filepath.Join(externalDir, "settings.png")
	for _, link := range []struct{ target, path string }{
		{target: credentialPath, path: cacheCredentialLink},
		{target: credentialPath, path: externalCredentialLink},
		{target: s.settingsPath(), path: externalSettingsLink},
	} {
		if err := os.Link(link.target, link.path); err != nil {
			t.Fatal(err)
		}
	}
	danglingPrivateLink := filepath.Join(t.TempDir(), "dangling-private")
	if err := os.Symlink(filepath.Join(dataDir, "not-created", "secret.png"), danglingPrivateLink); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name       string
		path       string
		uploadCode string
		namingCode string
	}{
		{name: "private file", path: privateFile, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "credential file", path: credentialPath, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "private root", path: dataDir, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "nonexistent private child", path: filepath.Join(dataDir, "not-created", "source.png"), uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "symlink private file", path: filepath.Join(privateLink, "private.png"), uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "symlink nonexistent private child", path: filepath.Join(privateLink, "future", "source.png"), uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "optimizer-cache symlink escaping to credential", path: cacheEscapeLink, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "optimizer-cache hard link to credential", path: cacheCredentialLink, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "external hard link to credential", path: externalCredentialLink, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "external hard link to app settings", path: externalSettingsLink, uploadCode: "invalidSourcePath", namingCode: "invalidSourcePath"},
		{name: "dangling symlink into private data", path: danglingPrivateLink, uploadCode: "uploadReadFailed", namingCode: "readFileFailed"},
	} {
		t.Run("upload/"+tc.name, func(t *testing.T) {
			_, err := call(t, s, "upload_gallery_object", map[string]any{"profile": p, "sourcePath": tc.path, "objectKey": "private.png"})
			requirePathError(t, err, tc.uploadCode)
		})
		t.Run("naming/"+tc.name, func(t *testing.T) {
			_, err := call(t, s, "generate_object_key", map[string]any{"sourcePath": tc.path, "outputFileName": "private.png", "namingTemplate": "{slug}.{ext}", "ext": "png"})
			requirePathError(t, err, tc.namingCode)
		})
	}

	for _, outputDir := range []string{dataDir, filepath.Join(dataDir, "not-created"), privateLink, filepath.Join(privateLink, "not-created"), danglingPrivateLink, filepath.Join(danglingPrivateLink, "child")} {
		t.Run("download/"+filepath.Base(outputDir), func(t *testing.T) {
			_, err := call(t, s, "download_gallery_object", map[string]any{"profile": p, "key": "private.png", "outputDir": outputDir})
			requirePathError(t, err, "invalidDownloadPath")
		})
	}
	if count := requests.Load(); count != 0 {
		t.Fatalf("private paths reached S3 %d times", count)
	}
}

func TestCallAcceptsExternalAndOptimizerCacheSources(t *testing.T) {
	dataDir := t.TempDir()
	externalDir := t.TempDir()
	cacheSource := filepath.Join(dataDir, "optimizer-cache", "run-test", "job-test", "out.webp")
	if err := os.MkdirAll(filepath.Dir(cacheSource), 0700); err != nil {
		t.Fatal(err)
	}
	externalSource := filepath.Join(externalDir, "original.png")
	for path, content := range map[string]string{cacheSource: "synthetic-optimized-image", externalSource: "synthetic-original-image"} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	type upload struct {
		body    string
		length  int64
		chunked bool
	}
	uploaded := make(chan upload, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			uploaded <- upload{body: string(body), length: r.ContentLength, chunked: len(r.TransferEncoding) != 0}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	s := New(dataDir)
	p := testProfile(server.URL)
	if _, err := s.saveSecret(p.ID, "synthetic-secret"); err != nil {
		t.Fatal(err)
	}

	for i, path := range []string{externalSource, cacheSource} {
		_, err := call(t, s, "generate_object_key", map[string]any{"sourcePath": path, "outputFileName": "source.png", "namingTemplate": "{slug}-{hash}.{ext}", "ext": "png"})
		if err != nil {
			t.Fatalf("naming of accepted path %q failed: %v", path, err)
		}
		_, err = call(t, s, "upload_gallery_object", map[string]any{"profile": p, "sourcePath": path, "objectKey": "accepted-" + string(rune('a'+i)) + ".png"})
		if err != nil {
			t.Fatalf("upload of accepted path %q failed: %v", path, err)
		}
	}
	for _, expected := range []string{"synthetic-original-image", "synthetic-optimized-image"} {
		select {
		case got := <-uploaded:
			if got.body != expected || got.length != int64(len(expected)) || got.chunked {
				t.Fatalf("invalid fixed-length upload: %+v", got)
			}
		default:
			t.Fatal("upload did not send a PUT")
		}
	}
}

func TestCallReportsInvalidExternalSourceErrors(t *testing.T) {
	s := New(t.TempDir())
	missing := filepath.Join(t.TempDir(), "missing.png")
	_, err := call(t, s, "upload_gallery_object", map[string]any{"profile": testProfile("https://s3.example.test"), "sourcePath": missing, "objectKey": "missing.png"})
	requirePathError(t, err, "uploadReadFailed")
	_, err = call(t, s, "generate_object_key", map[string]any{"sourcePath": missing, "outputFileName": "missing.png", "namingTemplate": "{slug}.{ext}", "ext": "png"})
	requirePathError(t, err, "readFileFailed")
	_, err = call(t, s, "upload_gallery_object", map[string]any{"profile": testProfile("https://s3.example.test"), "sourcePath": t.TempDir(), "objectKey": "directory.png"})
	requirePathError(t, err, "uploadReadFailed")
	empty := filepath.Join(t.TempDir(), "empty.png")
	if err := os.WriteFile(empty, nil, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = call(t, s, "upload_gallery_object", map[string]any{"profile": testProfile("https://s3.example.test"), "sourcePath": empty, "objectKey": "empty.png"})
	requirePathError(t, err, "uploadReadFailed")
	_, err = call(t, s, "generate_object_key", map[string]any{"sourcePath": empty, "outputFileName": "empty.png", "namingTemplate": "{slug}.{ext}", "ext": "png"})
	requirePathError(t, err, "readFileFailed")
}

func TestCallDownloadHonorsCancellation(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	s := New(t.TempDir())
	p := testProfile(server.URL)
	if _, err := s.saveSecret(p.ID, "synthetic-secret"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	outputDir := t.TempDir()
	done := make(chan error, 1)
	go func() {
		request, _ := json.Marshal(map[string]any{"profile": p, "key": "cancel.png", "outputDir": outputDir})
		_, err := s.Call(ctx, "download_gallery_object", request)
		done <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("download did not reach the loopback server")
	}
	cancel()
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Fatalf("download cancellation error = %v", err)
	}
}

func TestUploadHashReaderStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := uploadContextReader{ctx, downloadReaderFunc(func(b []byte) (int, error) {
		cancel()
		return copy(b, "partial"), nil
	})}
	if _, err := io.Copy(io.Discard, reader); !errors.Is(err, context.Canceled) {
		t.Fatalf("hash reader ignored cancellation: %v", err)
	}
}
