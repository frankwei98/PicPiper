package imaging

import (
	"errors"

	"golang.org/x/sys/windows"
)

func exportLinkUnsupported(err error) bool {
	return errors.Is(err, errors.ErrUnsupported) || errors.Is(err, windows.ERROR_INVALID_FUNCTION)
}

func outputNameTooLong(err error) bool {
	return errors.Is(err, windows.ERROR_FILENAME_EXCED_RANGE)
}
