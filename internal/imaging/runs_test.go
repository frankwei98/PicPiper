package imaging

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestRunCleanupDoesNotExpireSessionOutputs(t *testing.T) {
	service := New(t.TempDir())
	t.Cleanup(service.Close)
	if err := os.MkdirAll(service.cacheDir, 0700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-8 * 24 * time.Hour)
	abandoned := filepath.Join(service.cacheDir, "run-abandoned")
	if err := os.Mkdir(abandoned, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(abandoned, old, old); err != nil {
		t.Fatal(err)
	}
	run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
	if _, err := os.Stat(abandoned); !os.IsNotExist(err) {
		t.Fatalf("abandoned output was not cleaned: %v", err)
	}
	output := filepath.Join(run["outputDir"], "queued.png")
	if err := os.WriteFile(output, []byte("session output"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(run["outputDir"], old, old); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() { call(t, service, "create_optimizer_run", request{}) })
	}
	group.Wait()
	if data, err := os.ReadFile(output); err != nil || string(data) != "session output" {
		t.Fatalf("creating a new run removed a queued output: %q %v", data, err)
	}
	if _, err := service.OutputPaths([]string{output}); err != nil {
		t.Fatalf("queued output cannot be exported: %v", err)
	}
}
