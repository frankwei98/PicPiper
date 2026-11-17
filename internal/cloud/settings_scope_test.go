package cloud

import "testing"

func TestScopedSettingsKeepConcurrentMiniChanges(t *testing.T) {
	s := New(t.TempDir())
	base := defaults()
	base.Profiles = []profile{testProfile("https://s3.example.test")}
	if err := s.saveSettings(base); err != nil {
		t.Fatal(err)
	}
	format, quality := "avif", 77
	if _, err := s.SaveMiniCompressionSettings(MiniCompressionSettings{TargetFormat: &format, Quality: &quality}); err != nil {
		t.Fatal(err)
	}
	draft := base
	draft.Profiles = append([]profile(nil), base.Profiles...)
	draft.Profiles[0].Name = "Edited profile"
	for _, storage := range []settings{draft, base} { // Profile save, then rollback.
		value, err := call(t, s, "save_app_settings", map[string]any{"settings": storage, "scope": "storage"})
		if err != nil {
			t.Fatal(err)
		}
		if saved, ok := value.(settings); !ok || saved.Mini.TargetFormat != format || saved.Mini.Quality != quality {
			t.Fatalf("storage reply contains stale Mini settings: %v", value)
		}
		current, err := s.loadSettings()
		if err != nil || current.Mini.TargetFormat != format || current.Mini.Quality != quality {
			t.Fatalf("storage save reverted Mini: %+v %v", current.Mini, err)
		}
	}
	general := base
	mini := *base.Mini
	mini.Enabled = true
	general.Mini = &mini
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": general, "scope": "general", "miniBase": base.Mini}); err != nil {
		t.Fatal(err)
	}
	current, err := s.loadSettings()
	if err != nil || !current.Mini.Enabled || current.Mini.TargetFormat != format || current.Mini.Quality != quality {
		t.Fatalf("unchanged general fields reverted Mini: %+v %v", current.Mini, err)
	}
}
