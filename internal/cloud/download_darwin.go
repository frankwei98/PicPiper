package cloud

import (
	"os"

	"golang.org/x/sys/unix"
)

func publishDownload(source, target string) error {
	return publishDownloadWith(func(source, target string) error {
		return unix.RenameatxNp(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_EXCL)
	}, os.Link, source, target)
}
