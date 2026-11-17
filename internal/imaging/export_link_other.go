//go:build !windows

package imaging

import (
	"errors"
	"syscall"
)

func exportLinkUnsupported(err error) bool {
	return errors.Is(err, errors.ErrUnsupported) || errors.Is(err, syscall.EPERM)
}
