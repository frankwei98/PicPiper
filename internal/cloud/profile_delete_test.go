package cloud

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteProfileRemovesCredentialsAndReferences(t *testing.T) {
	s := New(t.TempDir())
	first := testProfile("https://s3.example.test")
	second := first
	second.ID = "other"
	cfg := defaults()
	cfg.Profiles = []profile{first, second}
	cfg.DefaultProfileID = &first.ID
	cfg.Mini.ProfileID = first.ID
	cfg.Mini.Enabled = true
	if err := s.saveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	for _, p := range cfg.Profiles {
		if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
			t.Fatal(err)
		}
	}
	history := uploadedImage{Key: "image.png", FileName: "image.png", UploadedAt: "2026-11-16T00:00:00Z", UploadID: "fake-upload"}
	if err := s.recordUpload(first, history); err != nil {
		t.Fatal(err)
	}
	result, err := call(t, s, "delete_s3_profile", map[string]string{"profileId": first.ID})
	if err != nil {
		t.Fatal(err)
	}
	next := result.(settings)
	if len(next.Profiles) != 1 || next.Profiles[0].ID != second.ID || next.DefaultProfileID != nil || next.Mini.ProfileID != "" || !next.Mini.Enabled {
		t.Fatalf("references not cleaned: %+v", next)
	}
	if _, err := os.Stat(s.secretPath(first.ID)); !os.IsNotExist(err) {
		t.Fatal("deleted credentials remain")
	}
	if _, err := os.Stat(s.secretPath(second.ID)); err != nil {
		t.Fatal("other profile credentials changed")
	}
	if _, err := os.Stat(s.uploadRecordsPath(first)); err != nil {
		t.Fatal("bucket upload history removed")
	}
	loaded, err := s.loadSettings()
	if err != nil || len(loaded.Profiles) != 1 {
		t.Fatalf("deletion not persisted: %+v %v", loaded, err)
	}
}

func TestDeleteProfileFailureRetainsSettings(t *testing.T) {
	s := New(t.TempDir())
	p := testProfile("https://s3.example.test")
	cfg := defaults()
	cfg.Profiles = []profile{p}
	cfg.DefaultProfileID = &p.ID
	if err := s.saveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	blocker := s.secretPath(p.ID)
	if err := os.MkdirAll(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(blocker, "child"), []byte("synthetic"), 0600)
	if _, err := call(t, s, "delete_s3_profile", map[string]string{"profileId": p.ID}); err == nil {
		t.Fatal("credential removal failure was hidden")
	}
	loaded, err := s.loadSettings()
	if err != nil || len(loaded.Profiles) != 1 || loaded.DefaultProfileID == nil {
		t.Fatalf("settings changed after deletion failure: %+v %v", loaded, err)
	}
}

func TestDeleteProfileHandlesMissingCredentialAndRejectsUnsafeIDs(t *testing.T) {
	s := New(t.TempDir())
	p := testProfile("https://s3.example.test")
	cfg := defaults()
	cfg.Profiles = []profile{p}
	if err := s.saveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := call(t, s, "delete_s3_profile", map[string]string{"profileId": "../escape"}); err == nil {
		t.Fatal("unsafe ID accepted")
	}
	if _, err := call(t, s, "delete_s3_profile", map[string]string{"profileId": p.ID}); err != nil {
		t.Fatal(err)
	}
}
