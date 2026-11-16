package imaging

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(buffer)
	if err == nil {
		err = r.ctx.Err()
	}
	return n, err
}

// publishExportWith publishes a complete staged file, preferring the atomic
// link path. Filesystems such as FAT32, exFAT, and many network mounts reject
// hard links, so fall back to an exclusive copy instead of failing the export.
func publishExportWith(link func(source, destination string) error, source, destination string) error {
	err := link(source, destination)
	if err == nil || os.IsExist(err) {
		return err
	}
	return copyExclusive(source, destination)
}

// copyExclusive publishes through a newly created destination. It keeps the
// no-overwrite contract when links are unavailable, sacrificing atomicity.
// A failed copy removes its partial destination.
func copyExclusive(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr == nil && closeErr == nil {
		return nil
	}
	_ = os.Remove(destination)
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func copyReserved(ctx context.Context, dir, name string, source io.Reader) (string, error) {
	if !validFileName(name) {
		return "", apperror.New("invalidFileName", "Choose a filename without path separators or reserved characters.")
	}
	stage, err := os.MkdirTemp(dir, ".pic-piper-export-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	output, err := os.OpenFile(filepath.Join(stage, "image"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	defer output.Close()
	if _, err := io.Copy(output, contextReader{ctx: ctx, reader: source}); err != nil {
		return "", err
	}
	if err := output.Close(); err != nil {
		return "", err
	}
	// Publish only complete images. Cleanup never touches a public output path,
	// which another application may have replaced since we last inspected it.
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for sequence := 1; sequence <= 10000; sequence++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		candidate := name
		if sequence > 1 {
			candidate = fmt.Sprintf("%s-%d%s", stem, sequence, ext)
		}
		path := filepath.Join(dir, candidate)
		err := publishExport(output.Name(), path)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		return path, nil
	}
	return "", apperror.New("tooManyFiles", "Too many files share this name. Choose another output folder.")
}
