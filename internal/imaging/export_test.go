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
