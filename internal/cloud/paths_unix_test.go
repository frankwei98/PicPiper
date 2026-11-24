//go:build unix

package cloud

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestUploadSourceRejectsSparseFileOverSinglePUTLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.png")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, maxS3UploadBytes+1); err != nil {
		t.Skipf("cannot set sparse fixture length: %v", err)
	}
	s := New(t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	file, _, _, err := s.readUploadSource(ctx, path, "uploadReadFailed")
	if file != nil {
		_ = file.Close()
	}
	requirePathError(t, err, "uploadReadFailed")
}

func TestUploadSourceRejectsNamedPipeWithoutOpeningIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pipe.png")
	if err := unix.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	s := New(t.TempDir())
	done := make(chan error, 1)
	go func() {
		file, _, _, err := s.readUploadSource(context.Background(), path, "uploadReadFailed")
		if file != nil {
			_ = file.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		requirePathError(t, err, "uploadReadFailed")
	case <-time.After(5 * time.Second):
		t.Fatal("opening an upload source blocked on a named pipe")
	}
}
