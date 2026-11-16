package cloud

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func saveUnique(dir, name string, r io.Reader) (string, error) {
	if !safeFilename(name) {
		return "", fmt.Errorf("unsafe filename")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(dir, ".picpiper-download-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	file, err := os.OpenFile(filepath.Join(stage, "image"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, copyErr := io.Copy(file, r)
	closeErr := file.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 10000; i++ {
		candidate := name
		if i > 0 {
			candidate = stem + " (" + strconv.Itoa(i+1) + ")" + ext
		}
		target := filepath.Join(dir, candidate)
		if err := publishDownload(file.Name(), target); os.IsExist(err) {
			continue
		} else if err != nil {
			return "", err
		}
		return target, nil
	}
	return "", fmt.Errorf("unable to reserve a unique filename")
}

// Used only when the filesystem cannot atomically publish without replacing.
func copyDownloadExclusive(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	original, statErr := output.Stat()
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr == nil && closeErr == nil {
		return nil
	}
	// Never remove a replacement created by another application during the copy.
	if current, err := os.Stat(target); err == nil && statErr == nil && os.SameFile(original, current) {
		_ = os.Remove(target)
	}
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
