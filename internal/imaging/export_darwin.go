package imaging

import (
	"errors"

	"golang.org/x/sys/unix"
)

func publishExport(source, destination string) error {
	return publishExportDarwinWith(func(source, destination string) error {
		return unix.RenameatxNp(unix.AT_FDCWD, source, unix.AT_FDCWD, destination, unix.RENAME_EXCL)
	}, source, destination)
}

func publishExportDarwinWith(rename func(source, destination string) error, source, destination string) error {
	err := rename(source, destination)
	if err == nil || errors.Is(err, unix.EEXIST) {
		return err
	}
	if errors.Is(err, unix.ENOTSUP) {
		return copyExclusive(source, destination)
	}
	return err
}
