//go:build unix

package cloud

import (
	"os"

	"golang.org/x/sys/unix"
)

func openUploadFile(path string) (*os.File, error) {
	// A FIFO substituted after Stat must still not block the uploader.
	return os.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
}
