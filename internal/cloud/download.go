package cloud

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
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

func (s *Service) saveUnique(dir, name string, r io.Reader) (string, error) {
	if !safeFilename(name) {
		return "", fmt.Errorf("unsafe filename")
	}
	dir, err := s.resolveDownloadDir(dir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	checked, err := s.resolveDownloadDir(dir)
	if err != nil {
		return "", err
	}
	if checked != dir {
		return "", appErr("invalidDownloadPath", "The download folder changed. Select it again.")
	}
	directory, err := os.Stat(dir)
	if err != nil {
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
	var syncErr error
	if copyErr == nil {
		syncErr = file.Sync()
	}
	closeErr := file.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if syncErr != nil {
		return "", syncErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	checked, err = s.resolveDownloadDir(dir)
	if err != nil {
		return "", err
	}
	current, err := os.Stat(checked)
	if err != nil || checked != dir || !os.SameFile(directory, current) {
		return "", appErr("invalidDownloadPath", "The download folder changed. Select it again.")
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 10000; i++ {
		candidate := name
		if i > 0 {
			suffix := " (" + strconv.Itoa(i+1) + ")"
			// Leave room for the collision suffix within a filesystem component.
			// Trim whole runes so non-ASCII filenames remain valid UTF-8.
			shortStem := stem
			for len(shortStem)+len(suffix)+len(ext) > 255 && len(shortStem) > 0 {
				_, size := utf8.DecodeLastRuneInString(shortStem)
				shortStem = shortStem[:len(shortStem)-size]
			}
			candidate = shortStem + suffix + ext
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
