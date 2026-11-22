package filelock

import "os"

// Open takes an exclusive lock on a dedicated lock file until it is closed.
// The caller must not remove or replace the file while others may open it.
func Open(path string, wait bool) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lock(file, wait); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
