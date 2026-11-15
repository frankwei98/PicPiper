package imaging

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestAutomaticConcurrencyRoundsUpHalf(t *testing.T) {
	for _, tc := range []struct{ cpus, want int }{{0, 1}, {1, 1}, {2, 1}, {3, 2}, {4, 2}, {5, 3}, {10, 5}, {12, 6}, {64, 32}} {
		if got := defaultConcurrency(tc.cpus); got != tc.want {
			t.Errorf("%d cores: got %d, want %d", tc.cpus, got, tc.want)
		}
	}
	s := New(t.TempDir())
	defer s.Close()
	if got := s.ProcessingLimits(); got.CPUCount != runtime.NumCPU() || got.Concurrency != defaultConcurrency(runtime.NumCPU()) {
		t.Fatal(got)
	}
	s.SetConcurrency(1)
	if s.ProcessingLimits().Concurrency != 1 {
		t.Fatal("manual setting ignored")
	}
	s.SetConcurrency(0)
	if s.ProcessingLimits().Concurrency != defaultConcurrency(runtime.NumCPU()) {
		t.Fatal("auto setting ignored")
	}
}

func TestLiveConcurrencyIncreaseAndDecreasePreserveRunningWorkers(t *testing.T) {
	if runtime.NumCPU() < 2 {
		t.Skip("requires two available CPUs")
	}
	s := NewIsolated(t.TempDir())
	defer s.Close()
	s.SetConcurrency(1)
	type task struct {
		path   string
		cancel context.CancelFunc
		done   chan error
	}
	start := func(name string) task {
		path := filepath.Join(s.dataDir, name+".blocked-comparison")
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		done := make(chan error, 1)
		go func() {
			raw, _ := json.Marshal(request{Path: path})
			_, err := s.Call(ctx, "read_comparison_image", raw)
			done <- err
		}()
		return task{path, cancel, done}
	}
	waitStarted := func(job task) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(job.path + ".started"); err == nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("worker never started", job.path)
	}
	assertWaiting := func(job task) {
		t.Helper()
		time.Sleep(60 * time.Millisecond)
		if _, err := os.Stat(job.path + ".started"); err == nil {
			t.Fatal("worker exceeded reduced concurrency", job.path)
		}
	}
	finish := func(job task) {
		t.Helper()
		job.cancel()
		select {
		case err := <-job.done:
			if !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("worker did not cancel")
		}
	}
	a := start("a")
	waitStarted(a)
	b := start("b")
	assertWaiting(b)
	s.SetConcurrency(2)
	waitStarted(b)
	s.SetConcurrency(1)
	c := start("c")
	assertWaiting(c)
	finish(a)
	assertWaiting(c)
	finish(b)
	waitStarted(c)
	// A waiting operation must also cancel without consuming a slot.
	waiting := start("cancel-waiting")
	assertWaiting(waiting)
	finish(waiting)
	finish(c)
	s.workerMu.Lock()
	cached := len(s.idleWorkers)
	s.workerMu.Unlock()
	if cached > 1 {
		t.Fatal("shrinking retained excess idle workers", cached)
	}
	running := start("closing-active")
	waitStarted(running)
	queued := start("closing-queued")
	assertWaiting(queued)
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not cancel active and waiting operations")
	}
	for _, job := range []task{running, queued} {
		select {
		case err := <-job.done:
			if !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("operation remained after shutdown")
		}
	}
	raw, _ := json.Marshal(request{Path: "worker-pid"})
	if _, err := s.Call(context.Background(), "inspect_image", raw); !errors.Is(err, context.Canceled) {
		t.Fatal("closed service admitted a new worker", err)
	}
}
