//go:build !darwin || !cgo

package traydrop

import "errors"

func Install(_ string, _ func([]string)) (func(), error) {
	return nil, errors.New("native icon drops require macOS with cgo")
}
