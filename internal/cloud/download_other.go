//go:build !darwin

package cloud

import "os"

func publishDownload(source, target string) error {
	err := os.Link(source, target)
	if err == nil || os.IsExist(err) {
		return err
	}
	return copyDownloadExclusive(source, target)
}
