package cloud

import (
	"sync"
	"testing"
)

func TestMiniCompressionEditsMergeWithLatestSettings(t *testing.T) {
	service := New(t.TempDir())
	latest := defaults()
	latest.NamingTemplate = "kept/{hash}.{ext}"
	latest.Mini = &MiniSettings{Enabled: true, TargetFormat: "avif", Quality: 90, Action: "clipboard", ProfileID: "latest-profile", LinkFormat: "markdown"}
	if err := service.saveSettings(latest); err != nil {
		t.Fatal(err)
	}
	quality := 85
	result, err := service.SaveMiniCompressionSettings(MiniCompressionSettings{Quality: &quality})
	if err != nil {
		t.Fatal(err)
	}
	if result.TargetFormat != "avif" || result.Quality != 85 || !result.Enabled || result.ProfileID != "latest-profile" || result.LinkFormat != "markdown" {
		t.Fatalf("untouched Mini settings changed: %+v", result)
	}
	saved, err := service.loadSettings()
	if err != nil {
		t.Fatal(err)
	}
	if saved.NamingTemplate != latest.NamingTemplate || *saved.Mini != result {
		t.Fatalf("latest settings were not preserved: %+v", saved)
	}
	// A format-only edit must likewise retain a concurrent quality change.
	latest = saved
	latest.Mini.Quality = 77
	if err = service.saveSettings(latest); err != nil {
		t.Fatal(err)
	}
	format := "png"
	result, err = service.SaveMiniCompressionSettings(MiniCompressionSettings{TargetFormat: &format})
	if err != nil || result.TargetFormat != "png" || result.Quality != 77 {
		t.Fatalf("format-only edit replaced quality: %+v %v", result, err)
	}
}

func TestMiniCompressionRejectsInvalidEditsWithoutWriting(t *testing.T) {
	service := New(t.TempDir())
	before := defaults()
	if err := service.saveSettings(before); err != nil {
		t.Fatal(err)
	}
	zero := 0
	unsupported := "heic"
	for _, changes := range []MiniCompressionSettings{{Quality: &zero}, {TargetFormat: &unsupported}} {
		if _, err := service.SaveMiniCompressionSettings(changes); err == nil {
			t.Fatal("invalid compression changes accepted")
		}
	}
	after, err := service.loadSettings()
	if err != nil || *after.Mini != *before.Mini {
		t.Fatalf("invalid request changed settings: %+v %v", after, err)
	}
}

func TestConcurrentMiniCompressionEditsRetainBothFields(t *testing.T) {
	service := New(t.TempDir())
	if err := service.saveSettings(defaults()); err != nil {
		t.Fatal(err)
	}
	format := "avif"
	quality := 85
	var workers sync.WaitGroup
	for _, changes := range []MiniCompressionSettings{{TargetFormat: &format}, {Quality: &quality}} {
		workers.Go(func() {
			if _, err := service.SaveMiniCompressionSettings(changes); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	saved, err := service.loadSettings()
	if err != nil || saved.Mini.TargetFormat != "avif" || saved.Mini.Quality != 85 {
		t.Fatalf("concurrent compression changes lost: %+v %v", saved, err)
	}
}
