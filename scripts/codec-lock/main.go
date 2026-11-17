//go:build darwin || linux

// Hold an advisory build lock until the invoking Node process closes stdin.
// The kernel releases the lock even if either process exits unexpectedly.
package main

import (
	"fmt"
	"io"
	"os"
	"syscall"
)

func main() {
	if err := hold(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func hold() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("expected a build lock path")
	}
	file, err := os.OpenFile(os.Args[1], os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	if _, err = fmt.Fprintln(os.Stdout, "locked"); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, os.Stdin)
	return err
}
