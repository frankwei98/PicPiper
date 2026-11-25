package imaging

import (
	"errors"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

func exportLinkUnsupported(err error) bool {
	return errors.Is(err, errors.ErrUnsupported) || errors.Is(err, windows.ERROR_INVALID_FUNCTION)
}

func outputNameTooLong(name string, err error) bool {
	if errors.Is(err, windows.ERROR_FILENAME_EXCED_RANGE) {
		return true
	}
	// NTFS also reports ERROR_INVALID_NAME for components over 255 UTF-16
	// code units. Preserve that error for other filename syntax failures.
	if errors.Is(err, windows.ERROR_INVALID_NAME) {
		units := 0
		for _, r := range name {
			units += utf16.RuneLen(r)
			if units > 255 {
				return true
			}
		}
	}
	return false
}
