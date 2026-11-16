package imaging

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingExportReader struct{ err error }

func (r failingExportReader) Read(buffer []byte) (int, error) {
	return copy(buffer, "partial image"), r.err
}

type cancelExportReader struct{ cancel context.CancelFunc }

func (r cancelExportReader) Read(buffer []byte) (int, error) {
	r.cancel()
	return copy(buffer, "partial image"), nil
}

type exportReaderFunc func([]byte) (int, error)

func (read exportReaderFunc) Read(buffer []byte) (int, error) { return read(buffer) }

func TestExportFallsBackWhenHardLinksAreUnavailable(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "staged")
	if err := os.WriteFile(source, []byte("complete image"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(dir, "photo.png")
	unsupported := func(string, string) error { return errors.New("operation not supported") }
	if err := publishExportWith(unsupported, source, destination); err != nil {
		t.Fatalf("fallback copy failed: %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "complete image" {
		t.Fatalf("fallback content = %q, %v", data, err)
	}
}

func TestExportFallbackNeverReplacesExistingFile(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "staged")
	destination := filepath.Join(dir, "photo.png")
	if err := os.WriteFile(source, []byte("new image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("user file"), 0600); err != nil {
		t.Fatal(err)
	}
	unsupported := func(string, string) error { return errors.New("operation not supported") }
	if err := publishExportWith(unsupported, source, destination); !os.IsExist(err) {
		t.Fatalf("expected an exclusive-create conflict, got %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "user file" {
		t.Fatalf("existing file changed: %q %v", data, err)
	}
}

func TestExportFallbackRemovesIncompleteCopy(t *testing.T) {
	source := t.TempDir()
	destination := filepath.Join(t.TempDir(), "photo.png")
	if err := copyExclusive(source, destination); err == nil {
		t.Fatal("expected a copy failure")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("partial export left behind: %v", err)
	}
}

func TestExportPreservesFilesCreatedDuringCopy(t *testing.T) {
	for _, outcome := range []string{"failure", "cancellation", "success"} {
		t.Run(outcome, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "photo.png")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			source := exportReaderFunc(func(buffer []byte) (int, error) {
				replacement := target + ".replacement"
				if err := os.WriteFile(replacement, []byte("user replacement"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(replacement, target); err != nil {
					t.Fatal(err)
				}
				switch outcome {
				case "failure":
					return 0, io.ErrUnexpectedEOF
				case "cancellation":
					cancel()
					return 0, context.Canceled
				default:
					return copy(buffer, "complete image"), io.EOF
				}
			})
			path, err := copyReserved(ctx, dir, "photo.png", source)
			if outcome == "success" {
				if err != nil || filepath.Base(path) != "photo-2.png" {
					t.Fatalf("export did not avoid the concurrent file: %s %v", path, err)
				}
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "complete image" {
					t.Fatalf("export incomplete: %q %v", data, err)
				}
			} else if err == nil {
				t.Fatal("expected export error")
			}
			data, err := os.ReadFile(target)
			if err != nil || string(data) != "user replacement" {
				t.Fatalf("concurrent user file was removed or changed: %q %v", data, err)
			}
			entries, err := os.ReadDir(dir)
			want := 1
			if outcome == "success" {
				want = 2
			}
			if err != nil || len(entries) != want {
				t.Fatalf("staging output left behind: %v %v", entries, err)
			}
		})
	}
}

func TestFailedOrCancelledExportRemovesOnlyItsReservedFile(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "read failure", true: "cancellation"}[cancelled], func(t *testing.T) {
			dir := t.TempDir()
			existing := filepath.Join(dir, "photo.png")
			if err := os.WriteFile(existing, []byte("existing file"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var source io.Reader = failingExportReader{err: io.ErrUnexpectedEOF}
			if cancelled {
				source = cancelExportReader{cancel: cancel}
			}
			if _, err := copyReserved(ctx, dir, "photo.png", source); err == nil || cancelled && !errors.Is(err, context.Canceled) {
				t.Fatalf("expected export error, got %v", err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 1 || entries[0].Name() != "photo.png" {
				t.Fatalf("incomplete output left behind: %v %v", entries, err)
			}
			data, _ := os.ReadFile(existing)
			if string(data) != "existing file" {
				t.Fatal("existing file changed")
			}
			path, err := copyReserved(context.Background(), dir, "photo.png", strings.NewReader("complete image"))
			if err != nil || filepath.Base(path) != "photo-2.png" {
				t.Fatalf("failed export consumed a name: %s %v", path, err)
			}
		})
	}
}
