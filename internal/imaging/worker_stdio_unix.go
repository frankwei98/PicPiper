//go:build unix

package imaging

import (
	"os"

	"golang.org/x/sys/unix"
)

func isolateWorkerStdout() (*os.File, error) {
	stdout := os.Stdout.Fd()
	fd, err := unix.FcntlInt(stdout, unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		return nil, err
	}
	// Preserve the pipe for replies and redirect descriptor 1 itself so native
	// codec diagnostics and writers that saved the original stdout go to stderr.
	if err := unix.Dup2(int(os.Stderr.Fd()), int(stdout)); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	// Keep Go's stdout object alive and writing to the redirected descriptor.
	return os.NewFile(uintptr(fd), "image-worker-protocol"), nil
}
