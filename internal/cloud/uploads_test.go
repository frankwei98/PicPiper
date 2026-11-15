package cloud

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type uploadFixture struct {
	mu       sync.Mutex
	ids      map[string]string
	etags    map[string]string
	keysRead []string
}

func (f *uploadFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.TrimPrefix(r.URL.Path, "/images/")
	switch r.Method {
	case http.MethodPut:
		if f.ids[key] != "" {
			w.WriteHeader(412)
			return
		}
		if r.Header.Get("X-Amz-Meta-Picpiper-Upload-Id") == "" || !strings.Contains(r.Header.Get("Authorization"), "x-amz-meta-picpiper-upload-id") {
			w.WriteHeader(400)
			return
		}
		data, _ := io.ReadAll(r.Body)
		f.ids[key] = r.Header.Get("X-Amz-Meta-Picpiper-Upload-Id")
		f.etags[key] = fmt.Sprintf(`"%x"`, sha256.Sum256(data))
		w.Header().Set("ETag", f.etags[key])
	case http.MethodHead:
		f.keysRead = append(f.keysRead, key)
		if f.ids[key] == "" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("X-Amz-Meta-Picpiper-Upload-Id", f.ids[key])
		w.Header().Set("ETag", f.etags[key])
	case http.MethodDelete:
		delete(f.ids, key)
		w.WriteHeader(204)
	default:
		t := "Bucket enumeration must not be used for the app gallery"
		http.Error(w, t, 400)
	}
}
func newUploadFixture(t *testing.T) (*Service, profile, *uploadFixture, string) {
	t.Helper()
	fixture := &uploadFixture{ids: map[string]string{"unrelated.jpg": "external"}, etags: map[string]string{}}
	server := httptest.NewServer(fixture)
	t.Cleanup(server.Close)
	s := New(t.TempDir())
	p := testProfile(server.URL)
	if _, err := s.saveSecret(p.ID, "fake"); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "source.png")
	if err := os.WriteFile(source, []byte("synthetic-image"), 0600); err != nil {
		t.Fatal(err)
	}
	return s, p, fixture, source
}
func uploadRecorded(t *testing.T, s *Service, p profile, path, key, name string) galleryObject {
	t.Helper()
	result, err := call(t, s, "upload_gallery_object", map[string]any{"profile": p, "sourcePath": path, "objectKey": key, "outputFilename": name})
	if err != nil {
		t.Fatal(err)
	}
	object := result.(galleryObject)
	if object.UploadRecordWarning {
		t.Fatal("upload record was not persisted")
	}
	return object
}
func TestGalleryOnlyListsLocalUploadsAndSortsBeforePagination(t *testing.T) {
	s, p, fixture, source := newUploadFixture(t)
	response, err := call(t, s, "list_gallery_objects", map[string]any{"profile": p, "prefix": ""})
	if err != nil || len(response.(listResponse).Objects) != 0 {
		t.Fatal("unrelated bucket object appeared")
	}
	for index, name := range []string{"Zulu.png", "alpha.png", "Middle.png"} {
		current := time.Date(2026, 1, 1, 0, 0, index, 0, time.UTC)
		s.now = func() time.Time { return current }
		uploadRecorded(t, s, p, source, fmt.Sprintf("images/%d.png", index), name)
	}
	// A fresh service and a renamed profile still identify this bucket's records.
	s = New(s.dataDir)
	p.ID = "renamed-profile"
	if _, err := s.saveSecret(p.ID, "fake"); err != nil {
		t.Fatal(err)
	}
	other := p
	other.Bucket = "different"
	outside, err := call(t, s, "list_gallery_objects", map[string]any{"profile": other, "prefix": ""})
	if err != nil || len(outside.(listResponse).Objects) != 0 {
		t.Fatal("upload history leaked between buckets")
	}
	for order, expected := range map[string][]string{
		"time-desc": {"Middle.png", "alpha.png", "Zulu.png"},
		"time-asc":  {"Zulu.png", "alpha.png", "Middle.png"},
		"name-asc":  {"alpha.png", "Middle.png", "Zulu.png"},
		"name-desc": {"Zulu.png", "Middle.png", "alpha.png"},
	} {
		var token *string
		names := []string{}
		for {
			result, err := call(t, s, "list_gallery_objects", map[string]any{"profile": p, "prefix": "images/", "sort": order, "pageSize": 1, "continuationToken": token})
			if err != nil {
				t.Fatal(err)
			}
			page := result.(listResponse)
			for _, object := range page.Objects {
				names = append(names, object.FileName)
			}
			token = page.NextContinuationToken
			if token == nil {
				break
			}
		}
		if fmt.Sprint(names) != fmt.Sprint(expected) {
			t.Fatalf("%s: got %v want %v", order, names, expected)
		}
	}
	for _, key := range fixture.keysRead {
		if key == "unrelated.jpg" {
			t.Fatal("unrelated object was checked")
		}
	}
	info, err := os.Stat(s.uploadRecordsPath(p))
	if err != nil {
		t.Fatalf("upload records missing: %v", err)
	}
	// Windows inherits the profile directory ACL; Go file modes cannot express ACLs.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("upload records are not private")
	}
	data, _ := os.ReadFile(s.uploadRecordsPath(p))
	if strings.Contains(string(data), "fake") || strings.Contains(string(data), "accessKey") {
		t.Fatal("credentials stored in upload records")
	}
}
func TestGalleryHidesDeletedOrReplacedUploadsAndRejectsCrossScopeCursor(t *testing.T) {
	s, p, fixture, source := newUploadFixture(t)
	uploadRecorded(t, s, p, source, "images/a.png", "a.png")
	uploadRecorded(t, s, p, source, "images/b.png", "b.png")
	result, err := call(t, s, "list_gallery_objects", map[string]any{"profile": p, "prefix": "images/", "pageSize": 1})
	if err != nil {
		t.Fatal(err)
	}
	token := result.(listResponse).NextContinuationToken
	if token == nil {
		t.Fatal("pagination cursor missing")
	}
	if _, err = call(t, s, "list_gallery_objects", map[string]any{"profile": p, "prefix": "other/", "continuationToken": token}); err == nil {
		t.Fatal("cross-prefix cursor accepted")
	}
	fixture.mu.Lock()
	fixture.ids["images/a.png"] = "external-replacement"
	delete(fixture.ids, "images/b.png")
	fixture.mu.Unlock()
	result, err = call(t, s, "list_gallery_objects", map[string]any{"profile": p, "prefix": "images/"})
	if err != nil || len(result.(listResponse).Objects) != 0 {
		t.Fatal("replaced or deleted image appeared")
	}
}
func TestUploadRecordFailureDoesNotTurnSuccessfulRemoteUploadIntoRetryableFailure(t *testing.T) {
	s, p, _, source := newUploadFixture(t)
	if err := os.WriteFile(filepath.Join(s.dataDir, "uploads"), []byte("block directory"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := call(t, s, "upload_gallery_object", map[string]any{"profile": p, "sourcePath": source, "objectKey": "a.png"})
	if err != nil || !result.(galleryObject).UploadRecordWarning {
		t.Fatal("successful upload must report a local-record warning, not a retryable upload failure")
	}
}
func TestConcurrentUploadsPreserveAllLocalRecords(t *testing.T) {
	s, p, _, source := newUploadFixture(t)
	var group sync.WaitGroup
	for index := range 12 {
		group.Go(func() {
			uploadRecorded(t, s, p, source, fmt.Sprintf("images/%d.png", index), fmt.Sprintf("%d.png", index))
		})
	}
	group.Wait()
	s.mu.Lock()
	records, err := s.loadUploadRecordsLocked(p)
	s.mu.Unlock()
	if err != nil || len(records) != 12 {
		t.Fatalf("concurrent upload records lost: %d %v", len(records), err)
	}
	// App deletion removes the record as well as the remote object.
	if _, err = call(t, s, "delete_gallery_object", map[string]any{"profile": p, "key": "images/0.png"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(s.uploadRecordsPath(p))
	var saved map[string]uploadedImage
	if json.Unmarshal(raw, &saved) != nil || len(saved) != 11 {
		t.Fatal("deleted upload retained in local history")
	}
}
