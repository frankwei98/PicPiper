package cloud

import (
	"errors"
	"golang.org/x/sys/unix"
)

func publishDownload(source, target string) error {
	err := unix.RenameatxNp(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_EXCL)
	if errors.Is(err, unix.ENOTSUP) {
		return copyDownloadExclusive(source, target)
	}
	return err
}
