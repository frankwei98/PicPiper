package main

import (
	"context"
	"encoding/json"
	"os"
	"sync"

	"github.com/frankwei98/PicPiper/internal/imaging"
	"testing"
)

func TestMain(m *testing.M) {
	if imaging.RunWorker() {
		return
	}
	os.Exit(m.Run())
}

func TestLaunchFilesAreDeliveredOnceAcrossConcurrentSubscriptions(t *testing.T) {
	backend := newBackend(t.TempDir())
	backend.openedFiles = []string{"/photos/one.jpg", "/photos/two.png"}
	results := make(chan []string, 8)
	var subscribers sync.WaitGroup
	for range 8 {
		subscribers.Go(func() { results <- backend.TakeOpenedFiles() })
	}
	subscribers.Wait()
	close(results)
	seen := map[string]int{}
	for paths := range results {
		if paths == nil {
			t.Fatal("empty file lists must serialize as arrays")
		}
		for _, path := range paths {
			seen[path]++
		}
	}
	if len(seen) != 2 || seen["/photos/one.jpg"] != 1 || seen["/photos/two.png"] != 1 {
		t.Fatalf("launch files were lost or duplicated: %v", seen)
	}
	if !backend.imagesReady {
		t.Fatal("native events must be enabled after the frontend subscribes")
	}
}

func TestBridgePreservesBusinessErrorCodes(t *testing.T) {
	backend := newBackend(t.TempDir())
	for _, test := range []struct{ operation, payload, code string }{
		{"inspect_image", "{", "invalidRequest"},
		{"inspect_image", `{"path":"/missing/pic-piper-test-image.jpg"}`, "imageOpenFailed"},
	} {
		var result reply
		if err := json.Unmarshal([]byte(backend.Call(context.Background(), test.operation, test.payload)), &result); err != nil {
			t.Fatal(err)
		}
		if result.Data != nil || result.Error == nil || result.Error.Code != test.code || result.Error.Message == "" {
			t.Fatalf("unexpected bridge error: %+v", result)
		}
	}
}
