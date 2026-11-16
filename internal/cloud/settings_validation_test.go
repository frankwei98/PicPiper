package cloud

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveSettingsRejectsDuplicateProfileIDs(t *testing.T) {
	s := New(t.TempDir())
	first := testProfile("https://s3.example.test")
	second := first
	second.Name = "Second profile"
	settingsValue := settings{
		Profiles:       []profile{first, second},
		NamingTemplate: "{slug}.{ext}",
	}
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": settingsValue}); err == nil {
		t.Fatal("expected duplicate profile IDs to be rejected")
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "app-settings.json")); !os.IsNotExist(err) {
		t.Fatalf("invalid settings were written: %v", err)
	}
}

func TestSaveSettingsAllowsDistinctProfileIDsForSameBucket(t *testing.T) {
	s := New(t.TempDir())
	first := testProfile("https://s3.example.test")
	second := first
	second.ID = "profile-two"
	second.Name = "Second profile"
	settingsValue := settings{
		Profiles:       []profile{first, second},
		NamingTemplate: "{slug}.{ext}",
	}
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": settingsValue}); err != nil {
		t.Fatalf("different IDs for the same bucket should be allowed: %v", err)
	}
}
