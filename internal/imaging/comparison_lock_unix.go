//go:build unix

package imaging

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockPreviewLease(file *os.File, wait bool) error {
	flags := unix.LOCK_EX
	if !wait {
		flags |= unix.LOCK_NB
	}
	return unix.Flock(int(file.Fd()), flags)
}
