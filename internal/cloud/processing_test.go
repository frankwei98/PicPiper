package cloud

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"testing"
)

func TestProcessingPreferenceMigrationValidationAndPersistence(t *testing.T) {
	s := New(t.TempDir())
	// Existing preference files without the field must use automatic mode.
	if err := os.WriteFile(s.settingsPath(), []byte(`{"profiles":[],"namingTemplate":"{slug}.{ext}"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ProcessingConcurrency(); err != nil || got != 0 {
		t.Fatalf("legacy default: %d %v", got, err)
	}
	for _, count := range []int{1, runtime.NumCPU(), 0} {
		cfg, err := s.loadSettings()
		if err != nil {
			t.Fatal(err)
		}
		cfg.ProcessingConcurrency = count
		raw, _ := json.Marshal(map[string]any{"settings": cfg})
		if _, err = s.Call(context.Background(), "save_app_settings", raw); err != nil {
			t.Fatal(err)
		}
		if got, err := s.ProcessingConcurrency(); err != nil || got != count {
			t.Fatalf("roundtrip: %d %v", got, err)
		}
	}
	for _, count := range []int{-1, runtime.NumCPU() + 1} {
		cfg := defaults()
		cfg.ProcessingConcurrency = count
		raw, _ := json.Marshal(map[string]any{"settings": cfg})
		if _, err := s.Call(context.Background(), "save_app_settings", raw); err == nil {
			t.Fatal("invalid concurrency accepted", count)
		}
		if got, _ := s.ProcessingConcurrency(); got != 0 {
			t.Fatal("rejected preference changed saved settings")
		}
	}
}
