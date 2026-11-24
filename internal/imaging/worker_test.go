package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"testing/iotest"
	"time"
)

func TestMain(m *testing.M) {
	stdout := os.Stdout
	if runWorker(func(dataDir string, input io.Reader, output io.Writer) {
		service := New(dataDir)
		defer service.Close()
		serveWorker(input, workerDiagnosticWriter{output, stdout}, func(ctx context.Context, operation string, payload json.RawMessage) (any, error) {
			// A deterministic stand-in for a synchronous codec that never returns.
			// The real packaged smoke separately exercises the actual codecs.
			var req request
			_ = json.Unmarshal(payload, &req)
			if req.Path == "worker-pid" {
				return map[string]int{"pid": os.Getpid()}, nil
			}
			if req.Path == "worker-exit" {
				os.Exit(7)
			}
			if operation == "render_preview_png" && filepath.Ext(req.Path) == ".blocked-comparison" {
				_ = os.WriteFile(req.Path+".started", []byte("started"), 0600)
				for {
					time.Sleep(time.Second)
				}
			}
			if req.SourcePath == "blocked-test-codec" {
				_ = os.WriteFile(filepath.Join(req.OutputDir, "partial.png"), []byte("partial"), 0600)
				for {
					time.Sleep(time.Second)
				}
			}
			return service.Call(ctx, operation, payload)
		})
	}) {
		return
	}
	os.Exit(m.Run())
}

type workerDiagnosticWriter struct {
	output, originalStdout io.Writer
}

func (w workerDiagnosticWriter) Write(data []byte) (int, error) {
	fmt.Fprintln(os.Stdout, "codec diagnostic")
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		fmt.Fprintln(w.originalStdout, "native codec diagnostic")
	}
	return w.output.Write(data)
}

func TestWorkerSurvivesBusinessErrorsAndIsReplacedAfterCrash(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	pid := workerPID(t, service)
	payload, _ := json.Marshal(request{Path: filepath.Join(service.dataDir, "missing.jpg")})
	if _, err := service.Call(context.Background(), "inspect_image", payload); err == nil {
		t.Fatal("missing input should return a business error")
	}
	if got := workerPID(t, service); got != pid {
		t.Fatal("a business error discarded a healthy codec process")
	}
	payload, _ = json.Marshal(request{Path: "worker-exit"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := service.Call(ctx, "inspect_image", payload); err == nil {
		t.Fatal("worker crash should return an error")
	}
	if got := workerPID(t, service); got == pid {
		t.Fatal("a crashed worker was reused")
	}
}

func TestWorkerProtocolProcessesMultipleRequestsAndRejectsInvalidOperations(t *testing.T) {
	var input, output bytes.Buffer
	encoder := json.NewEncoder(&input)
	for _, operation := range []string{"inspect_image", "not-an-image-operation", "read_thumbnail"} {
		if err := encoder.Encode(workerRequest{Operation: operation, Payload: json.RawMessage(`{}`)}); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	serveWorker(&input, &output, func(_ context.Context, operation string, _ json.RawMessage) (any, error) {
		calls++
		return operation, nil
	})
	decoder := json.NewDecoder(&output)
	for i, want := range []string{"inspect_image", "", "read_thumbnail"} {
		var response workerReply
		if err := decoder.Decode(&response); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			if response.Error == nil || response.Error.Code != "invalidRequest" {
				t.Fatalf("invalid operation was dispatched: %+v", response)
			}
			continue
		}
		var got string
		if err := json.Unmarshal(response.Data, &got); err != nil || got != want {
			t.Fatalf("protocol lost request order: got %s, want %s", response.Data, want)
		}
	}
	if calls != 2 {
		t.Fatalf("worker dispatched %d operations, want 2", calls)
	}
}

func TestWorkerConsumesJSONDelimiterBeforeClipboardFrames(t *testing.T) {
	worker := &imageWorker{input: discardWriteCloser{io.Discard}}
	stream := bytes.NewBufferString("{\"data\":null}\n")
	if _, err := (workerPNGWriter{stream}).Write([]byte("mock PNG")); err != nil {
		t.Fatal(err)
	}
	stream.WriteString("\x00\x00\x00\x00{\"data\":null}\n")
	// Force the JSON object and its terminating newline into separate reads.
	worker.output = io.NopCloser(iotest.OneByteReader(stream))
	if _, err := worker.call(context.Background(), workerRequest{Operation: "inspect_image"}); err != nil {
		t.Fatal(err)
	}
	response, err := worker.call(context.Background(), workerRequest{Operation: workerClipboardOperation})
	if err != nil || string(response.PNG) != "mock PNG" {
		t.Fatalf("read clipboard after JSON response: %q, %v", response.PNG, err)
	}
}

func TestWorkerKeepsCodecDiagnosticsOutOfReusedProtocol(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	service.SetConcurrency(1)
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	pid := workerPID(t, service)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	for _, fixture := range []string{"rotation.avif", "animated.jxl"} {
		data, err := os.ReadFile(filepath.Join("testdata", fixture))
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(run["outputDir"], fixture)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(request{Path: path, MaxSize: 48})
		if _, err := service.Call(ctx, "read_thumbnail", payload); err != nil {
			t.Fatalf("decode %s in worker: %v", fixture, err)
		}
		data, err = service.ClipboardPNG(ctx, path)
		if err != nil {
			t.Fatalf("clipboard %s: %v", fixture, err)
		}
		if _, err := png.Decode(bytes.NewReader(data)); err != nil {
			t.Fatalf("clipboard %s did not return a PNG: %v", fixture, err)
		}
	}
	if got := workerPID(t, service); got != pid {
		t.Fatalf("worker changed from %d to %d after diagnostics", pid, got)
	}
}

func TestWorkerRejectsOversizedClipboardFrameBeforeReading(t *testing.T) {
	var stream bytes.Buffer
	if err := binary.Write(&stream, binary.BigEndian, uint32(maxClipboardPNGBytes+1)); err != nil {
		t.Fatal(err)
	}
	if _, err := readWorkerPNG(&stream); err == nil || errors.Is(err, io.EOF) {
		t.Fatalf("oversized frame was not rejected at its length: %v", err)
	}
}

type discardWriteCloser struct{ io.Writer }

func (discardWriteCloser) Close() error { return nil }

func TestServiceCloseReapsIdleWorker(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	workerPID(t, service)
	worker := service.idleWorkers[0]
	service.Close()
	if worker.command.ProcessState == nil {
		t.Fatal("close did not wait for the idle codec process")
	}
	payload, _ := json.Marshal(request{Path: "worker-pid"})
	if _, err := service.Call(context.Background(), "inspect_image", payload); !errors.Is(err, context.Canceled) {
		t.Fatalf("closed service restarted a worker: %v", err)
	}
}

func TestIsolatedWorkerReusesProcess(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	pid := workerPID(t, service)
	for range 3 {
		if got := workerPID(t, service); got != pid {
			t.Fatalf("each request starts a new codec process: first PID %d, next PID %d", pid, got)
		}
	}
}

func workerPID(t *testing.T, service *Service) int {
	t.Helper()
	payload, err := json.Marshal(request{Path: "worker-pid"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	value, err := service.Call(ctx, "inspect_image", payload)
	if err != nil {
		t.Fatal(err)
	}
	return int(value.(map[string]any)["pid"].(float64))
}

func TestCancelledCodecProcessIsTerminatedAndRemovesPartialOutput(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	service.SetConcurrency(1)
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	runDir := run["outputDir"]
	payload, _ := json.Marshal(request{TaskID: "old", SourcePath: "blocked-test-codec", OutputDir: runDir, OutputFileName: "photo.png", Settings: settings{TargetFormat: "png"}})
	finished := make(chan error, 1)
	go func() {
		_, err := service.Call(context.Background(), "compress_image", payload)
		finished <- err
	}()
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		files, _ := filepath.Glob(filepath.Join(runDir, "job-*", "partial.png"))
		if len(files) == 1 {
			break
		}
		select {
		case err := <-finished:
			t.Fatalf("worker exited before cancellation: %v", err)
		case <-deadline:
			t.Fatal("worker did not begin encoding")
		case <-ticker.C:
		}
	}
	cancelled, _ := json.Marshal(request{TaskID: "old"})
	if _, err := service.Call(context.Background(), "cancel_image_task", cancelled); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected cancellation, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not terminate the synchronous worker")
	}
	entries, _ := os.ReadDir(runDir)
	if len(entries) != 0 {
		t.Fatalf("cancelled worker left output behind: %v", entries)
	}
	// A late request for the old task must not start the process again.
	if _, err := service.Call(context.Background(), "compress_image", payload); !errors.Is(err, context.Canceled) {
		t.Fatalf("late task restarted after cancellation: %v", err)
	}
	// A new version can use the released worker slot and export a complete image.
	source := fixture(t, image.NewNRGBA(image.Rect(0, 0, 16, 8)))
	payload, _ = json.Marshal(request{TaskID: "new", SourcePath: source, OutputDir: runDir, OutputFileName: "photo.png", Settings: settings{TargetFormat: "png"}})
	value, err := service.Call(context.Background(), "compress_image", payload)
	if err != nil {
		t.Fatal(err)
	}
	output := value.(map[string]any)["outputPath"].(string)
	if _, err := inspect(output); err != nil {
		t.Fatalf("retry did not produce a complete image: %v", err)
	}
}

func TestComparisonCancellationReleasesBothWorkerSlots(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	finished := make(chan error, 2)
	paths := []string{filepath.Join(service.dataDir, "original.blocked-comparison"), filepath.Join(service.dataDir, "compressed.blocked-comparison")}
	for _, path := range paths {
		payload, _ := json.Marshal(request{TaskID: "comparison:closed", Path: path})
		go func() {
			_, err := service.Call(context.Background(), "read_comparison_image", payload)
			finished <- err
		}()
	}
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		_, first := os.Stat(paths[0] + ".started")
		_, second := os.Stat(paths[1] + ".started")
		if first == nil && second == nil {
			break
		}
		select {
		case err := <-finished:
			t.Fatalf("comparison worker exited early: %v", err)
		case <-deadline:
			t.Fatal("both comparison workers did not start")
		case <-ticker.C:
		}
	}
	payload, _ := json.Marshal(request{TaskID: "comparison:closed"})
	if _, err := service.Call(context.Background(), "cancel_image_task", payload); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case err := <-finished:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("comparison was not cancelled: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("closed comparison kept a worker occupied")
		}
	}
	if service.workers.active != 0 {
		t.Fatal("comparison did not release both slots")
	}
	// Late bridge dispatch must not resurrect a closed comparison.
	payload, _ = json.Marshal(request{TaskID: "comparison:closed", Path: paths[0]})
	if _, err := service.Call(context.Background(), "read_comparison_image", payload); !errors.Is(err, context.Canceled) {
		t.Fatalf("late comparison restarted: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	source := fixture(t, image.NewNRGBA(image.Rect(0, 0, 16, 8)))
	payload, _ = json.Marshal(request{TaskID: "new-import", Path: source})
	if _, err := service.Call(ctx, "inspect_image", payload); err != nil {
		t.Fatalf("new import blocked by closed comparison: %v", err)
	}
}

func TestCancellationBeforeDispatchAndAcrossOverlappingStages(t *testing.T) {
	var jobs imageJobs
	if err := jobs.cancel("cancel-first"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := jobs.start(context.Background(), "cancel-first"); !errors.Is(err, context.Canceled) {
		t.Fatal("a bridge request started after its cancellation")
	}
	inspectContext, finishInspect, err := jobs.start(context.Background(), "shared")
	if err != nil {
		t.Fatal(err)
	}
	defer finishInspect()
	encodeContext, finishEncode, err := jobs.start(context.Background(), "shared")
	if err != nil {
		t.Fatal(err)
	}
	defer finishEncode()
	if err := jobs.cancel("shared"); err != nil {
		t.Fatal(err)
	}
	if inspectContext.Err() != context.Canceled || encodeContext.Err() != context.Canceled {
		t.Fatal("cancel must stop all overlapping stages for the image version")
	}
}
