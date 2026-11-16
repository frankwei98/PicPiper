//go:build !darwin

package imaging

import "os"

func publishExport(source, destination string) error {
	return publishExportWith(os.Link, source, destination)
}
