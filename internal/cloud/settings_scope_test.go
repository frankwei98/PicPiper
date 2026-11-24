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

func TestStorageRollbackRestoresLegacyTemplateWithoutReplacingNewerEdits(t *testing.T) {
	s := New(t.TempDir())
	base := defaults()
	base.NamingTemplate = "gallery/{slug}"
	if err := s.saveSettings(base); err != nil {
		t.Fatal(err)
	}
	draft := defaults()
	draft.Profiles = []profile{testProfile("https://s3.example.test")}
	applied, err := call(t, s, "save_app_settings", map[string]any{"settings": draft, "scope": "storage"})
	if err != nil {
		t.Fatal(err)
	}
	quality := 77
	if _, err := s.SaveMiniCompressionSettings(MiniCompressionSettings{Quality: &quality}); err != nil {
		t.Fatal(err)
	}
	rollback := map[string]any{"settings": base, "scope": "storageRollback", "storageBase": applied}
	value, err := call(t, s, "save_app_settings", rollback)
	if err != nil {
		t.Fatal(err)
	}
	if saved := value.(settings); saved.NamingTemplate != base.NamingTemplate || len(saved.Profiles) != 0 || saved.Mini.Quality != quality {
		t.Fatalf("rollback should restore the old storage settings and preserve Mini edits: %+v", saved)
	}
	newer := draft
	newer.NamingTemplate = "later/{slug}.{ext}"
	if _, err = call(t, s, "save_app_settings", map[string]any{"settings": newer, "scope": "storage"}); err != nil {
		t.Fatal(err)
	}
	if _, err = call(t, s, "save_app_settings", rollback); err == nil {
		t.Fatal("rollback accepted after a newer storage edit")
	}
	loaded, err := s.loadSettings()
	if err != nil || loaded.NamingTemplate != newer.NamingTemplate {
		t.Fatalf("newer settings were lost: %+v, %v", loaded, err)
	}
}
