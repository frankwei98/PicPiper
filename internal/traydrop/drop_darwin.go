//go:build darwin && cgo

// Package traydrop attaches Finder file drops to this app's status-item window.
// Install and its returned cleanup function must run on the AppKit main thread.
package traydrop

/*
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
#include <stdint.h>
uintptr_t PPInstallTrayDrop(const char*, uintptr_t);
void PPRemoveTrayDrop(uintptr_t);
*/
import "C"

import (
	"encoding/json"
	"errors"
	"runtime/cgo"
	"sync"
	"unsafe"
)

func Install(tooltip string, fn func([]string)) (func(), error) {
	handle := cgo.NewHandle(fn)
	label := C.CString(tooltip)
	defer C.free(unsafe.Pointer(label))
	receiver := C.PPInstallTrayDrop(label, C.uintptr_t(handle))
	if receiver == 0 {
		handle.Delete()
		return nil, errors.New("could not locate the app's native status button")
	}
	return sync.OnceFunc(func() { C.PPRemoveTrayDrop(receiver); handle.Delete() }), nil
}

//export picPiperTrayFiles
func picPiperTrayFiles(handle C.uintptr_t, encoded *C.char) {
	var paths []string
	if json.Unmarshal([]byte(C.GoString(encoded)), &paths) == nil && len(paths) > 0 {
		cgo.Handle(handle).Value().(func([]string))(paths)
	}
}
