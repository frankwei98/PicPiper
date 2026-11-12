//go:build !darwin

package imaging

import "os"

func publishExport(source, destination string) error {
	return os.Link(source, destination)
}
