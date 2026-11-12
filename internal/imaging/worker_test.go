package imaging

import (
	"context"
	"encoding/json"
	"errors"
	"image"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 4 && os.Args[1] == "--image-worker" && os.Args[3] == "compress_image" {
		// A deterministic stand-in for a synchronous codec that never returns.
		// The real packaged smoke separately exercises the actual codecs.
		payload, _ := io.ReadAll(os.Stdin)
		var req request
		_ = json.Unmarshal(payload, &req)
		if req.SourcePath == "blocked-test-codec" {
			_ = os.WriteFile(filepath.Join(req.OutputDir, "partial.png"), []byte("partial"), 0600)
			for {
				time.Sleep(time.Second)
			}
		}
		var result any
		var err error
		result, err = New(os.Args[2]).Call(context.Background(), os.Args[3], payload)
		response := workerReply{}
		if err != nil {
			if !errors.As(err, &response.Error) {
				response.Error = apperror.New("imageProcessingFailed", "The test image worker failed.")
			}
		} else {
			response.Data, _ = json.Marshal(result)
		}
		_ = json.NewEncoder(os.Stdout).Encode(response)
		return
	}
	if RunWorker() {
		return
	}
	os.Exit(m.Run())
}

func TestCancelledCodecProcessIsTerminatedAndRemovesPartialOutput(t *testing.T) {
	service := NewIsolated(t.TempDir())
	t.Cleanup(service.Close)
	service.workers = make(chan struct{}, 1)
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
