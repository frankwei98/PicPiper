package cloud

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type downloadReaderFunc func([]byte) (int, error)

func (read downloadReaderFunc) Read(b []byte) (int, error) { return read(b) }

func TestDownloadFailureLeavesNoPartialFile(t *testing.T) {
	for _, failure := range []error{io.ErrUnexpectedEOF, context.Canceled} {
		t.Run(failure.Error(), func(t *testing.T) {
			dir := t.TempDir()
			existing := filepath.Join(dir, "photo.png")
			if err := os.WriteFile(existing, []byte("user image"), 0600); err != nil {
				t.Fatal(err)
			}
			source := downloadReaderFunc(func(b []byte) (int, error) { return copy(b, "partial"), failure })
			if _, err := saveUnique(dir, "photo.png", source); !errors.Is(err, failure) {
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
			path, err := saveUnique(dir, "photo.png", strings.NewReader("complete"))
			if err != nil || filepath.Base(path) != "photo (2).png" {
				t.Fatalf("retry consumed filename: %s %v", path, err)
			}
		})
	}
}

func TestDownloadPreservesFileCreatedDuringRead(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "photo.png")
	source := downloadReaderFunc(func(b []byte) (int, error) {
		if err := os.WriteFile(target, []byte("user replacement"), 0600); err != nil {
			t.Fatal(err)
		}
		return copy(b, "complete"), io.EOF
	})
	path, err := saveUnique(dir, "photo.png", source)
	if err != nil || filepath.Base(path) != "photo (2).png" {
		t.Fatalf("concurrent file overwritten: %s %v", path, err)
	}
	data, _ := os.ReadFile(target)
	if string(data) != "user replacement" {
		t.Fatal("concurrent file changed")
	}
}
