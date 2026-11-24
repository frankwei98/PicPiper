package cloud

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

type downloadReaderFunc func([]byte) (int, error)

func (read downloadReaderFunc) Read(b []byte) (int, error) { return read(b) }

func TestDownloadFailureLeavesNoPartialFile(t *testing.T) {
	for _, failure := range []error{io.ErrUnexpectedEOF, context.Canceled} {
		t.Run(failure.Error(), func(t *testing.T) {
			service := New(t.TempDir())
			dir := t.TempDir()
			existing := filepath.Join(dir, "photo.png")
			if err := os.WriteFile(existing, []byte("user image"), 0600); err != nil {
				t.Fatal(err)
			}
			source := downloadReaderFunc(func(b []byte) (int, error) { return copy(b, "partial"), failure })
			if _, err := service.saveUnique(dir, "photo.png", source); !errors.Is(err, failure) {
				t.Fatalf("download error = %v", err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 1 {
				t.Fatalf("partial download remains: %v %v", entries, err)
			}
			content, _ := os.ReadFile(existing)
			if string(content) != "user image" {
				t.Fatal("existing file changed")
			}
			path, err := service.saveUnique(dir, "photo.png", strings.NewReader("complete"))
			if err != nil || filepath.Base(path) != "photo (2).png" {
				t.Fatalf("retry consumed filename: %s %v", path, err)
			}
		})
	}
}

func TestDownloadCollisionWithLongFilename(t *testing.T) {
	for _, stem := range []string{strings.Repeat("a", 251), strings.Repeat("界", 83) + "ab"} {
		t.Run(stem[:3], func(t *testing.T) {
			service := New(t.TempDir())
			dir := t.TempDir()
			name := stem + ".png"
			existing := filepath.Join(dir, name)
			if err := os.WriteFile(existing, []byte("user image"), 0600); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				path, err := service.saveUnique(dir, name, strings.NewReader("download"))
				if err != nil {
					t.Fatal(err)
				}
				base := filepath.Base(path)
				if len(base) > 255 || !utf8.ValidString(base) || !strings.HasSuffix(base, ").png") {
					t.Fatalf("invalid collision filename: %q", base)
				}
				if data, err := os.ReadFile(path); err != nil || string(data) != "download" {
					t.Fatalf("download missing: %q %v", data, err)
				}
			}
			if data, err := os.ReadFile(existing); err != nil || string(data) != "user image" {
				t.Fatalf("existing file changed: %q %v", data, err)
			}
		})
	}
}

func TestDownloadPreservesFileCreatedDuringRead(t *testing.T) {
	service := New(t.TempDir())
	dir := t.TempDir()
	target := filepath.Join(dir, "photo.png")
	source := downloadReaderFunc(func(b []byte) (int, error) {
		if err := os.WriteFile(target, []byte("user replacement"), 0600); err != nil {
			t.Fatal(err)
		}
		return copy(b, "complete"), io.EOF
	})
	path, err := service.saveUnique(dir, "photo.png", source)
	if err != nil || filepath.Base(path) != "photo (2).png" {
		t.Fatalf("concurrent file overwritten: %s %v", path, err)
	}
	data, _ := os.ReadFile(target)
	if string(data) != "user replacement" {
		t.Fatal("concurrent file changed")
	}
}

func TestDownloadUnsupportedPublicationLeavesNoFinalFile(t *testing.T) {
	dir := t.TempDir()
	source, target := filepath.Join(dir, "staged"), filepath.Join(dir, "photo.png")
	if err := os.WriteFile(source, []byte("complete image"), 0600); err != nil {
		t.Fatal(err)
	}
	unsupported := func(string, string) error { return errors.ErrUnsupported }
	if err := publishDownloadWith(unsupported, unsupported, source, target); !errors.Is(err, errors.ErrUnsupported) {
		t.Fatalf("unsafe publication was not rejected: %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("unsupported publication exposed a final file: %v", err)
	}
}

func TestDownloadAtomicFallbackPreservesConcurrentFile(t *testing.T) {
	dir := t.TempDir()
	source, target := filepath.Join(dir, "staged"), filepath.Join(dir, "photo.png")
	if err := os.WriteFile(source, []byte("complete image"), 0600); err != nil {
		t.Fatal(err)
	}
	publish := func(string, string) error {
		if err := os.WriteFile(target, []byte("user image"), 0600); err != nil {
			return err
		}
		return errors.ErrUnsupported
	}
	if err := publishDownloadWith(publish, os.Link, source, target); !os.IsExist(err) {
		t.Fatalf("concurrent file was not protected: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "user image" {
		t.Fatalf("concurrent file changed: %q %v", data, err)
	}
}
