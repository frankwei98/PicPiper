package filelock

import (
	"os"

	"golang.org/x/sys/windows"
)

func lock(file *os.File, wait bool) error {
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK)
	if !wait {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	var overlap windows.Overlapped
	return windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &overlap)
}
