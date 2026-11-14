package cloud

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

func startR2OnTestPort(s *Service) (any, error) {
	return s.startR2OAuthWithListener(func() (net.Listener, error) {
		return net.Listen("tcp4", "127.0.0.1:0")
	})
}

func TestR2CancellationReleasesListenerBeforeServeStarts(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Reproduce cancellation after Listen succeeds but before the Serve
	// goroutine registers that listener with http.Server.
	session := &r2Session{ctx: ctx, cancel: cancel, server: &http.Server{}, listener: listener, status: "pending", token: "synthetic-token"}
	session.mu.Lock()
	session.stopLocked()
	session.mu.Unlock()
	replacement, err := net.Listen("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatalf("canceled sign-in still owns its callback port before Serve starts: %v", err)
	}
	defer replacement.Close()
	// A late cleanup of the canceled session must not close a replacement
	// listener that has already acquired the same address.
	session.mu.Lock()
	session.stopLocked()
	session.mu.Unlock()
	probe, err := net.DialTimeout("tcp4", replacement.Addr().String(), time.Second)
	if err != nil {
		t.Fatalf("late cleanup closed the replacement listener: %v", err)
	}
	probe.Close()
	if ctx.Err() != context.Canceled || session.token != "" || session.status != "closed" {
		t.Fatal("cancellation did not clear the session")
	}
}
