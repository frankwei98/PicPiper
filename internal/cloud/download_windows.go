package cloud

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func publishDownload(source, target string) error {
	return publishDownloadWith(func(source, target string) error {
		from, err := downloadWindowsPath(source)
		if err != nil {
			return err
		}
		to, err := downloadWindowsPath(target)
		if err != nil {
			return err
		}
		// Neither REPLACE_EXISTING nor COPY_ALLOWED: publish on the same volume
		// without ever creating a partial or overwriting another application.
		if err = windows.MoveFileEx(from, to, 0); err != nil {
			return &os.LinkError{Op: "rename", Old: source, New: target, Err: err}
		}
		return nil
	}, os.Link, source, target)
}

func downloadWindowsPath(path string) (*uint16, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(abs, `\\?\`) {
		if strings.HasPrefix(abs, `\\`) {
			abs = `\\?\UNC\` + abs[2:]
		} else {
			abs = `\\?\` + abs
		}
	}
	return windows.UTF16PtrFromString(abs)
}
