package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMiniDefaultsAndMergePreservePrivateStorage(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	plan, err := s.MiniPlan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Settings.Enabled || plan.Settings.TargetFormat != "webp" || plan.Settings.Quality != 90 || plan.Settings.Action != "clipboard" {
		t.Fatalf("defaults: %+v", plan.Settings)
	}
	original := defaults()
	original.NamingTemplate = "custom/{hash}.{ext}"
	if err = s.saveSettings(original); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultMiniSettings()
	cfg.Enabled = true
	if err = s.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	got, err := s.loadSettings()
	if err != nil || got.NamingTemplate != original.NamingTemplate || got.Mini == nil || !got.Mini.Enabled {
		t.Fatalf("merge: %+v %v", got, err)
	}
	info, statErr := os.Stat(s.settingsPath())
	if statErr != nil {
		t.Fatalf("settings file missing: %v", statErr)
	}
	// Windows inherits the profile directory ACL; Go file modes cannot express ACLs.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("settings permissions changed")
	}
	cfg.Action = "upload"
	if err = s.SaveMiniSettings(cfg); err != nil {
		t.Fatal("legacy upload preference must become clipboard without requiring S3")
	}
	cfg.Action = "clipboard"
	cfg.Quality = 0
	if err = s.SaveMiniSettings(cfg); err == nil {
		t.Fatal("invalid quality accepted")
	}
}

func TestMiniUploadCapturesProfileEscapesURLAndNeverOverwrites(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("unexpected method %s", r.Method)
			w.WriteHeader(400)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/images/old/") {
			t.Errorf("destination changed: %s", r.URL.Path)
		}
		if r.Header.Get("If-None-Match") != "*" {
			t.Error("missing conflict protection")
		}
		if r.Header.Get("Authorization") == "" {
			t.Error("missing signing")
		}
		_, _ = io.Copy(io.Discard, r.Body)
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		w.Header().Set("ETag", `"synthetic"`)
		w.WriteHeader(200)
	}))
	defer server.Close()
	s := New(t.TempDir())
	p := testProfile(server.URL)
	base := "https://images.example.test/public"
	p.PublicBaseURL = &base
	p.DefaultPrefix = "old"
	_, err := s.saveSecret(p.ID, "fake-mini-secret")
	if err != nil {
		t.Fatal(err)
	}
	v := defaults()
	cfg := DefaultMiniSettings()
	cfg.Enabled = true
	cfg.Action = "upload"
	cfg.ProfileID = p.ID
	v.Mini = &cfg
	v.Profiles = []profile{p}
	v.NamingTemplate = "folder with space/{slug}.{ext}"
	if err = s.saveSettings(v); err != nil {
		t.Fatal(err)
	}
	plan, err := s.MiniPlan()
	if err != nil {
		t.Fatal(err)
	}
	v.Profiles[0].Bucket = "changed"
	v.Profiles[0].DefaultPrefix = "changed"
	if err = s.saveSettings(v); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "image.webp")
	if err = os.WriteFile(path, []byte("synthetic image"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := s.UploadMini(context.Background(), plan, path, "a & b.webp")
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || !strings.HasPrefix(result, base+"/old/folder%20with%20space/") || !strings.Contains(result, "-mini-") {
		t.Fatalf("unexpected result %q, attempts %d", result, attempts)
	}
}

func TestMiniUploadRetryWithExtensionOnlyKeyStaysInGallery(t *testing.T) {
	s, p, _, source := newUploadFixture(t)
	baseURL := "https://images.example.test/public"
	p.PublicBaseURL = &baseURL
	cfg := defaults()
	cfg.Profiles = []profile{p}
	cfg.Mini.Enabled = true
	cfg.NamingTemplate = ".{ext}"
	if _, err := call(t, s, "save_app_settings", map[string]any{"settings": cfg}); err != nil {
		t.Fatal(err)
	}
	uploadRecorded(t, s, p, source, ".png", "existing.png")
	plan, err := s.MiniUploadPlan(p.ID, "url")
	if err != nil {
		t.Fatal(err)
	}
	const name = "📷.png"
	link, err := s.UploadMini(context.Background(), plan, source, name)
	if err != nil {
		t.Fatal(err)
	}
	value, err := call(t, s, "list_gallery_objects", map[string]any{"profile": p})
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range value.(listResponse).Objects {
		if object.FileName == name && strings.HasSuffix(object.Key, ".png") && object.PublicURL != nil && *object.PublicURL == link {
			return
		}
	}
	t.Fatalf("Mini retry uploaded %q but did not create a visible PNG: %+v", link, value)
}

func TestMiniLegacyUploadPreferenceBecomesClipboardWithoutS3(t *testing.T) {
	s := New(t.TempDir())
	v := defaults()
	cfg := DefaultMiniSettings()
	cfg.Enabled = true
	cfg.Action = "upload"
	cfg.ProfileID = "removed-target"
	cfg.LinkFormat = "markdown"
	v.Mini = &cfg
	// Seed a settings file from the previous automatic-upload design.
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(s.settingsPath(), raw, 0600); err != nil {
		t.Fatal(err)
	}
	plan, err := s.MiniPlan()
	if err != nil {
		t.Fatalf("legacy upload setting must not block image copying: %v", err)
	}
	if plan.Settings.Action != "clipboard" || plan.Settings.LinkFormat != "markdown" {
		t.Fatalf("legacy automatic upload was not normalized: %+v", plan.Settings)
	}
	loaded, err := s.loadSettings()
	if err != nil || loaded.Mini.Action != "clipboard" {
		t.Fatal("settings UI would still see automatic upload")
	}
	// An older UI saving upload must not re-enable automatic network writes.
	if err = s.SaveMiniSettings(cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err = s.loadSettings()
	if err != nil || loaded.Mini.Action != "clipboard" {
		t.Fatal("saving legacy settings restored automatic upload")
	}
	if _, err = s.Call(context.Background(), "save_app_settings", mustMiniJSON(t, map[string]any{"settings": v})); err != nil {
		t.Fatalf("saving app settings retained the removed upload requirement: %v", err)
	}
	loaded, err = s.loadSettings()
	if err != nil || loaded.Mini.Action != "clipboard" {
		t.Fatal("app settings restored automatic upload")
	}
}

func mustMiniJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
