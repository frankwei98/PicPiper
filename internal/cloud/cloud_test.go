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
	"time"
)

func testProfile(endpoint string) profile {
	return profile{ID: "profile", Name: "Profile", Endpoint: endpoint, Region: "us-east-1", Bucket: "images", AccessKeyID: "access", PathStyle: true, DefaultPrefix: ""}
}
func call(t *testing.T, s *Service, op string, v any) (any, error) {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return s.Call(context.Background(), op, b)
}

func TestSigV4CanonicalRequestDeterminism(t *testing.T) {
	u, _ := http.NewRequest("GET", "https://s3.example.test/bucket/a%20b.jpg?prefix=x+y&list-type=2", nil)
	u.Header.Set("If-None-Match", "*")
	timestamp := time.Date(2026, 11, 11, 12, 34, 56, 0, time.UTC)
	sign(u, "auto", "AKID", "SECRET", strings.Repeat("0", 64), timestamp)
	want := "AWS4-HMAC-SHA256 Credential=AKID/20261111/auto/s3/aws4_request, SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=c31ad36acf49a94ee827eb3d6b55ff75fe0c8a92c27a9cecbabedab3c34d261b"
	if got := u.Header.Get("Authorization"); got != want {
		t.Fatalf("signature mismatch: %s", got)
	}
	first := u.Header.Get("Authorization")
	sign(u, "auto", "AKID", "SECRET", strings.Repeat("0", 64), timestamp)
	if got := u.Header.Get("Authorization"); got != first {
		t.Fatal("signature changed for identical request")
	}
}

func TestSettingsAndSecretPersistence(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	v, e := s.Call(context.Background(), "load_app_settings", json.RawMessage(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	settingsValue := v.(settings)
	if len(settingsValue.Profiles) != 0 || settingsValue.Profiles == nil || settingsValue.NamingTemplate != "{yyyy}/{mm}/{slug}-{hash}.{ext}" {
		t.Fatalf("unexpected defaults: %#v", settingsValue)
	}
	p := testProfile("https://s3.example.test/base/images")
	_, e = call(t, s, "save_app_settings", map[string]any{"settings": settings{Profiles: []profile{p}, NamingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}"}})
	if e != nil {
		t.Fatal(e)
	}
	_, e = call(t, s, "save_s3_secret", map[string]string{"profileId": "profile", "secretAccessKey": "private-secret"})
	if e != nil {
		t.Fatal(e)
	}
	if got, e := os.ReadFile(filepath.Join(dir, "credentials", "profile.secret")); e != nil || string(got) != "private-secret" {
		t.Fatalf("secret not saved: %q %v", got, e)
	}
	// Windows inherits the profile directory ACL; Go file modes cannot express ACLs.
	if st, e := os.Stat(filepath.Join(dir, "credentials")); e != nil {
		t.Fatalf("credential directory missing: %v", e)
	} else if runtime.GOOS != "windows" && st.Mode().Perm() != 0700 {
		t.Fatalf("credential directory mode: %v", st.Mode().Perm())
	}
	if st, e := os.Stat(filepath.Join(dir, "credentials", "profile.secret")); e != nil {
		t.Fatalf("secret file missing: %v", e)
	} else if runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
		t.Fatalf("secret file mode: %v", st.Mode().Perm())
	}
}

func TestListPaginationConditionalUploadConflictAndDownload(t *testing.T) {
	var page int
	var uploads int
	var uploaded string
	var conditional string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2" {
			page++
			if page == 1 {
				if r.URL.Query().Get("max-keys") != "2" || r.URL.Query().Get("prefix") != "pics/" {
					t.Errorf("unexpected list query: %s", r.URL.RawQuery)
				}
				io.WriteString(w, `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents><Key>pics/a.jpg</Key><Size>12</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>`)
			} else {
				if r.URL.Query().Get("continuation-token") != "next" {
					t.Errorf("missing token: %s", r.URL.RawQuery)
				}
				io.WriteString(w, `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>pics/b.txt</Key><Size>7</Size></Contents></ListBucketResult>`)
			}
			return
		}
		if r.Method == http.MethodPut {
			if r.URL.EscapedPath() != "/images/pics/new.webp" {
				t.Errorf("unexpected upload path: %q", r.URL.EscapedPath())
			}
			conditional = r.Header.Get("If-None-Match")
			b, _ := io.ReadAll(r.Body)
			uploaded = string(b)
			uploads++
			if uploads == 1 {
				w.WriteHeader(http.StatusConflict)
			} else {
				w.WriteHeader(http.StatusPreconditionFailed)
			}
			return
		}
		if r.Method == http.MethodGet {
			w.Write([]byte("image-bytes"))
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(204)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	dir := t.TempDir()
	s := New(dir)
	p := testProfile(srv.URL)
	_, e := call(t, s, "save_s3_secret", map[string]string{"profileId": "profile", "secretAccessKey": "secret"})
	if e != nil {
		t.Fatal(e)
	}
	for _, tok := range []any{nil, "next"} {
		var cursor *string
		if tok != nil {
			value := tok.(string)
			cursor = &value
		}
		res, e := s.list(context.Background(), p, "secret", "pics/", cursor, 2)
		if e != nil {
			t.Fatal(e)
		}
		if len(res.Objects) != 1 {
			t.Fatalf("objects: %#v", res)
		}
		if tok == nil && (*res.NextContinuationToken) != "next" {
			t.Fatalf("token: %#v", res.NextContinuationToken)
		}
		if tok != nil && res.NextContinuationToken != nil {
			t.Fatalf("unexpected next token: %#v", res.NextContinuationToken)
		}
	}
	source := filepath.Join(dir, "source.webp")
	os.WriteFile(source, []byte("upload-data"), 0600)
	_, e = call(t, s, "upload_gallery_object", map[string]any{"profile": p, "sourcePath": source, "objectKey": "pics/new.webp", "contentType": "image/webp"})
	if e == nil || !strings.Contains(e.Error(), "conflicted") {
		t.Fatalf("expected retryable conflict error, got %v", e)
	}
	if conditional != "*" || uploaded != "upload-data" {
		t.Fatalf("upload lost body/precondition %q %q", conditional, uploaded)
	}
	_, e = call(t, s, "upload_gallery_object", map[string]any{"profile": p, "sourcePath": source, "objectKey": "pics/new.webp", "contentType": "image/webp"})
	if e == nil || !strings.Contains(e.Error(), "already exists") {
		t.Fatalf("expected existing-object error, got %v", e)
	}
	v, e := call(t, s, "download_gallery_object", map[string]any{"profile": p, "key": "pics/a.jpg", "outputDir": dir})
	if e != nil {
		t.Fatal(e)
	}
	saved := v.(string)
	b, e := os.ReadFile(saved)
	if e != nil || string(b) != "image-bytes" {
		t.Fatalf("download result %q %v", b, e)
	}
}

func TestEndpointBucketNormalizationAndObjectKeyEncoding(t *testing.T) {
	p := testProfile("https://s3.example.test/base/images/")
	u, e := endpoint(p)
	if e != nil {
		t.Fatal(e)
	}
	if u.Path != "/base/images" {
		t.Fatalf("endpoint path unexpectedly stripped: %q", u.Path)
	}
	if got := encodeKey("a b/c+#.jpg"); got != "a%20b/c%2B%23.jpg" {
		t.Fatalf("encoded key %q", got)
	}
}

func TestNamingMatchesTemplateHashAndSuffix(t *testing.T) {
	now := time.Date(2026, 6, 26, 1, 0, 0, 0, time.UTC)
	key, e := renderKey("{yyyy}/{mm}/{slug}-{hash}.{ext}", "My Summer Photo.JPG", "webp", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", now)
	if e != nil {
		t.Fatal(e)
	}
	key, e = appendSuffix(key, "retry-1")
	if e != nil {
		t.Fatal(e)
	}
	if key != "2026/06/my-summer-photo-ba7816bf-retry-1.webp" {
		t.Fatalf("key %q", key)
	}
}

func TestDefaultPrefixValidationMatchesGeneratedKeys(t *testing.T) {
	for _, prefix := range []string{`images\2026`, "images//2026", "images/./2026", "images/../2026", "images/\x1f2026"} {
		t.Run("invalid/"+prefix, func(t *testing.T) {
			s := New(t.TempDir())
			p := testProfile("https://s3.example.test")
			p.DefaultPrefix = prefix
			_, err := call(t, s, "save_app_settings", map[string]any{"settings": settings{Profiles: []profile{p}, NamingTemplate: "{slug}.{ext}"}})
			if err == nil || !strings.Contains(err.Error(), "Default prefix") {
				t.Fatalf("expected a prefix validation error for %q, got %v", prefix, err)
			}
		})
	}
	for _, prefix := range []string{"", "images/2026", "/images/2026/", "///", "photos/旅行"} {
		t.Run("valid/"+prefix, func(t *testing.T) {
			s := New(t.TempDir())
			p := testProfile("https://s3.example.test")
			p.DefaultPrefix = prefix
			if _, err := call(t, s, "save_app_settings", map[string]any{"settings": settings{Profiles: []profile{p}, NamingTemplate: "{slug}.{ext}"}}); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(t.TempDir(), "photo.jpg")
			if err := os.WriteFile(source, []byte("synthetic-image"), 0600); err != nil {
				t.Fatal(err)
			}
			value, err := call(t, s, "generate_object_key", map[string]any{"sourcePath": source, "outputFileName": "photo.jpg", "prefix": prefix, "namingTemplate": "{slug}.{ext}", "ext": "jpg"})
			if err != nil {
				t.Fatalf("saved prefix %q cannot generate a key: %v", prefix, err)
			}
			want := "photo.jpg"
			if normalized := strings.Trim(prefix, "/"); normalized != "" {
				want = normalized + "/" + want
			}
			if got := value.(map[string]string)["objectKey"]; got != want {
				t.Fatalf("generated key %q, want %q", got, want)
			}
		})
	}
}

func TestSafeFilenameAndExclusiveDownloads(t *testing.T) {
	for _, name := range []string{"CON.jpg", "photo.", "photo?x", "sub/photo.jpg", "COM¹.txt"} {
		if safeFilename(name) {
			t.Errorf("accepted unsafe filename %q", name)
		}
	}
	dir := t.TempDir()
	first, err := saveUnique(dir, "photo.jpg", strings.NewReader("first"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := saveUnique(dir, "photo.jpg", strings.NewReader("second"))
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("download paths collided: %q", first)
	}
	if b, _ := os.ReadFile(first); string(b) != "first" {
		t.Fatalf("original download overwritten: %q", b)
	}
	if b, _ := os.ReadFile(second); string(b) != "second" {
		t.Fatalf("second download missing: %q", b)
	}
}

func TestOnboardingCompletionSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	_, err := call(t, s, "save_app_settings", map[string]any{"settings": settings{
		Profiles: []profile{}, NamingTemplate: "{slug}.{ext}",
		OnboardingCompleted: true, Features: &features{Compression: true, S3: false},
	}})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := New(dir).loadSettings()
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.OnboardingCompleted || loaded.Features == nil || !loaded.Features.Compression || loaded.Features.S3 {
		t.Fatalf("onboarding preferences lost: %#v", loaded)
	}
}
