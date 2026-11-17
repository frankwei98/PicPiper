package cloud

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Both operations publish an already complete staged file without replacing an
// existing destination. Never fall back to copying into the final filename.
func publishDownloadWith(publish, link func(string, string) error, source, target string) error {
	err := publish(source, target)
	if err == nil || os.IsExist(err) || !errors.Is(err, errors.ErrUnsupported) {
		return err
	}
	if linkErr := link(source, target); linkErr == nil || os.IsExist(linkErr) {
		return linkErr
	}
	return err
}

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
