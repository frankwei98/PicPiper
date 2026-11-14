package cloud

import (
	"encoding/json"
	"os"
	"testing"
)

func TestDesktopPreferencesDefaultAndLegacySettings(t *testing.T) {
	s := New(t.TempDir())
	prefs, err := s.DesktopPreferences()
	if err != nil || prefs.CloseBehavior != CloseQuit || prefs.StatusIconEnabled {
		t.Fatalf("unexpected desktop defaults: %+v %v", prefs, err)
	}
	legacy := []byte(`{"profiles":[],"namingTemplate":"{slug}.{ext}","mini":{"enabled":true,"targetFormat":"webp","quality":90}}`)
	if err = os.WriteFile(s.settingsPath(), legacy, 0600); err != nil {
		t.Fatal(err)
	}
	prefs, err = s.DesktopPreferences()
	if err != nil || prefs.CloseBehavior != CloseQuit || !prefs.StatusIconEnabled {
		t.Fatalf("legacy settings lost their icon or default close preference: %+v %v", prefs, err)
	}
}

func TestClosePreferenceSurvivesStatusIconChanges(t *testing.T) {
	for _, behavior := range []CloseBehavior{CloseQuit, CloseBackground} {
		t.Run(string(behavior), func(t *testing.T) {
			s := New(t.TempDir())
			cfg := defaults()
			cfg.CloseBehavior = behavior
			if _, err := call(t, s, "save_app_settings", map[string]any{"settings": cfg}); err != nil {
				t.Fatal(err)
			}
			for _, enabled := range []bool{true, false} {
				mini := DefaultMiniSettings()
				mini.Enabled = enabled
				if err := s.SaveMiniSettings(mini); err != nil {
					t.Fatal(err)
				}
				prefs, err := New(s.dataDir).DesktopPreferences()
				if err != nil || prefs.CloseBehavior != behavior || prefs.StatusIconEnabled != enabled {
					t.Fatalf("icon change overwrote the close preference: %+v %v", prefs, err)
				}
			}
		})
	}
}

func TestInvalidClosePreferenceDoesNotReplaceSavedSettings(t *testing.T) {
	s := New(t.TempDir())
	cfg := defaults()
	cfg.CloseBehavior = CloseBackground
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": cfg}); err != nil {
		t.Fatal(err)
	}
	cfg.CloseBehavior = "unsupported"
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": cfg}); err == nil {
		t.Fatal("invalid close preference was saved")
	}
	v, err := s.Call(t.Context(), "load_app_settings", json.RawMessage(`{}`))
	if err != nil || v.(settings).CloseBehavior != CloseBackground {
		t.Fatalf("failed save changed the stored preference: %+v %v", v, err)
	}
}
