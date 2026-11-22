package imaging

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
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

func TestLargeImageOperationsWaitWithoutTakingAWorkerAndCanCancel(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	service.SetConcurrency(1)
	for range cap(service.largeImages) {
		service.largeImages <- struct{}{}
	}
	largeSource := filepath.Join(t.TempDir(), "large.png")
	header := make([]byte, 13)
	// 16-bit RGBA at this size exceeds the budget during profile conversion,
	// even though the decoded image and a resized output alone fit.
	binary.BigEndian.PutUint32(header[:4], 4096)
	binary.BigEndian.PutUint32(header[4:8], 4096)
	header[8], header[9] = 16, 6
	prefix := append([]byte("\x89PNG\r\n\x1a\n"), pngChunk("IHDR", header)...)
	if err := os.WriteFile(largeSource, append(prefix, pngChunk("IDAT", nil)...), 0600); err != nil {
		t.Fatal(err)
	}
	source := fixture(t, image.NewNRGBA(image.Rect(0, 0, 16, 8)))
	for _, test := range []struct {
		operation string
		request   request
	}{
		{"compress_image", request{SourcePath: largeSource, Settings: settings{MaxDimension: 2560}}},
		{"read_thumbnail", request{Path: largeSource, MaxSize: 96}},
		{"read_comparison_image", request{Path: largeSource, MaxSize: 1280}},
	} {
		t.Run(test.operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			payload, _ := json.Marshal(test.request)
			done := make(chan error, 1)
			go func() {
				_, err := service.Call(ctx, test.operation, payload)
				done <- err
			}()
			call(t, service, "read_thumbnail", request{Path: source, MaxSize: 96})
			if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("large operation did not wait for its memory budget: %v", err)
			}
		})
	}
}

func TestWebPHeaderSizeReadsAllCanvasLayouts(t *testing.T) {
	for _, test := range []struct {
		chunk  string
		width  int
		height int
		write  func([]byte)
	}{
		{"VP8 ", 6000, 5000, func(header []byte) {
			copy(header[23:], "\x9d\x01\x2a")
			binary.LittleEndian.PutUint16(header[26:], 6000)
			binary.LittleEndian.PutUint16(header[28:], 5000)
		}},
		{"VP8L", 6000, 5000, func(header []byte) {
			header[20] = 0x2f
			binary.LittleEndian.PutUint32(header[21:], 5999|(4999<<14))
		}},
		{"VP8X", 70000, 480, func(header []byte) {
			binary.LittleEndian.PutUint32(header[23:], 69999<<8)
			binary.LittleEndian.PutUint32(header[26:], uint32(header[26])|(479<<8))
		}},
	} {
		t.Run(test.chunk, func(t *testing.T) {
			var header [30]byte
			copy(header[12:], test.chunk)
			test.write(header[:])
			if width, height := webpHeaderSize(header[:]); width != test.width || height != test.height {
				t.Fatalf("canvas = %d × %d, want %d × %d", width, height, test.width, test.height)
			}
		})
	}
}
