//go:build !unix

package imaging

import "os"

func isolateWorkerStdout() (*os.File, error) {
	output := os.Stdout
	// The bundled WASI codecs capture Go's stdout when they initialize.
	os.Stdout = os.Stderr
	return output, nil
}
