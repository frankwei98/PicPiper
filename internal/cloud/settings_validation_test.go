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

func TestSaveSettingsRejectsCaseEquivalentProfileIDs(t *testing.T) {
	s := New(t.TempDir())
	first := testProfile("https://s3.example.test")
	first.ID = "profile"
	second := first
	second.ID = "PROFILE"
	cfg := defaults()
	cfg.Profiles = []profile{first, second}
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": cfg}); err == nil {
		t.Fatal("case-equivalent credential IDs were accepted")
	}
}

func TestSaveSettingsRejectsUnusableNamingTemplate(t *testing.T) {
	for _, mode := range []struct{ name, scope string }{{"full", ""}, {"storage", "storage"}} {
		for _, template := range []string{"gallery/{slug}", "gallery//{slug}.{ext}"} {
			t.Run(mode.name+"/"+template, func(t *testing.T) {
				s := New(t.TempDir())
				base := defaults()
				if _, err := call(t, s, "save_app_settings", map[string]any{"settings": base, "scope": mode.scope}); err != nil {
					t.Fatal(err)
				}
				draft := base
				draft.NamingTemplate = template
				if _, err := call(t, s, "save_app_settings", map[string]any{"settings": draft, "scope": mode.scope}); err == nil {
					t.Errorf("unusable naming template %q was accepted", template)
				}
				value, err := call(t, s, "load_app_settings", map[string]any{})
				if err != nil {
					t.Fatal(err)
				}
				if got := value.(settings).NamingTemplate; got != base.NamingTemplate {
					t.Errorf("saved template changed to %q after validation failure", got)
				}
			})
		}
	}
}

func TestGeneralSettingsSaveWithLegacyNamingTemplate(t *testing.T) {
	s := New(t.TempDir())
	base := defaults()
	base.NamingTemplate = "gallery/{slug}"
	if err := s.saveSettings(base); err != nil {
		t.Fatal(err)
	}
	draft := base
	draft.CloseBehavior = CloseBackground
	value, err := call(t, s, "save_app_settings", map[string]any{"settings": draft, "scope": "general", "miniBase": base.Mini})
	if err != nil {
		t.Fatal(err)
	}
	if saved := value.(settings); saved.CloseBehavior != CloseBackground || saved.NamingTemplate != base.NamingTemplate {
		t.Fatalf("unexpected settings after editing a general preference: %+v", saved)
	}
}
