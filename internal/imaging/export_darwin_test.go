//go:build darwin

package imaging

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestDarwinExportFallsBackWhenExclusiveRenameIsUnsupported(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "staged")
	destination := filepath.Join(dir, "photo.png")
	if err := os.WriteFile(source, []byte("complete image"), 0600); err != nil {
		t.Fatal(err)
	}
	unsupported := func(string, string) error { return unix.ENOTSUP }
	if err := publishExportDarwinWith(unsupported, source, destination); err != nil {
		t.Fatalf("fallback copy failed: %v", err)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("fallback permissions = %04o, want 0600", info.Mode().Perm())
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "complete image" {
		t.Fatalf("fallback content = %q, %v", data, err)
	}
}

func TestDarwinExportFallbackDoesNotReplaceExistingFile(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "staged")
	destination := filepath.Join(dir, "photo.png")
	if err := os.WriteFile(source, []byte("new image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("user file"), 0600); err != nil {
		t.Fatal(err)
	}
	unsupported := func(string, string) error { return unix.ENOTSUP }
	if err := publishExportDarwinWith(unsupported, source, destination); !errors.Is(err, unix.EEXIST) {
		t.Fatalf("expected exclusive-create conflict, got %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "user file" {
		t.Fatalf("existing file changed: %q %v", data, err)
	}
}
