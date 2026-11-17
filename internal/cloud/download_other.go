//go:build !darwin && !linux && !windows

package cloud

import "os"

func publishDownload(source, target string) error {
	return os.Link(source, target)
}
