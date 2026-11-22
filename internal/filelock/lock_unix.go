//go:build unix

package filelock

import (
	"os"

	"golang.org/x/sys/unix"
)

func lock(file *os.File, wait bool) error {
	flags := unix.LOCK_EX
	if !wait {
		flags |= unix.LOCK_NB
	}
	return unix.Flock(int(file.Fd()), flags)
}
