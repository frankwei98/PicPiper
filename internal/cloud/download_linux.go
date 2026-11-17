package cloud

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func publishDownload(source, target string) error {
	return publishDownloadWith(func(source, target string) error {
		err := unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE)
		if errors.Is(err, unix.EINVAL) {
			return fmt.Errorf("%w: %v", errors.ErrUnsupported, err)
		}
		return err
	}, os.Link, source, target)
}
