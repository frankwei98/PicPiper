package cloud

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newUploadVerificationService(t *testing.T, count int, onHead func(http.ResponseWriter, *http.Request, int)) (*Service, profile, []uploadedImage) {
	t.Helper()
	records := make([]uploadedImage, count)
	byKey := make(map[string]int, count)
	for index := range records {
		key := fmt.Sprintf("%03d.png", index)
		records[index] = uploadedImage{Key: key, FileName: key, Size: int64(1024 + index), UploadedAt: uploadTimestamp(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(index) * time.Second)), ETag: fmt.Sprintf(`"etag-%d"`, index), UploadID: fmt.Sprintf("upload-%d", index)}
		byKey[key] = index
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index, known := byKey[strings.TrimPrefix(r.URL.Path, "/images/")]
		if r.Method != http.MethodHead || !known {
			http.Error(w, "Only recorded image HEAD requests are allowed", http.StatusBadRequest)
			return
		}
		w.Header().Set("X-Amz-Meta-Picpiper-Upload-Id", records[index].UploadID)
		w.Header().Set("ETag", records[index].ETag)
		onHead(w, r, index)
	}))
	t.Cleanup(server.Close)
	s := New(t.TempDir())
	p := testProfile(server.URL)
	for _, record := range records {
		if err := s.recordUpload(p, record); err != nil {
			t.Fatal(err)
		}
	}
	return s, p, records
}

func recordedUploads(t *testing.T, s *Service, p profile) map[string]uploadedImage {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadUploadRecordsLocked(p)
	if err != nil {
		t.Fatal(err)
	}
	return records
}

func TestGalleryVerifiesDefaultPageWithBoundedConcurrency(t *testing.T) {
	var active, peak atomic.Int64
	s, p, records := newUploadVerificationService(t, 100, func(w http.ResponseWriter, r *http.Request, _ int) {
		current := active.Add(1)
		defer active.Add(-1)
		for previous := peak.Load(); current > previous; previous = peak.Load() {
			if peak.CompareAndSwap(previous, current) {
				break
			}
		}
		timer := time.NewTimer(20 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-r.Context().Done():
		case <-timer.C:
			w.WriteHeader(http.StatusOK)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	start := time.Now()
	page, err := s.listUploads(ctx, galleryRequest{Profile: p, Sort: "name-asc"}, "synthetic-secret")
	if err != nil || len(page.Objects) != 100 {
		t.Fatalf("100 valid delayed HEADs should fit the page budget: count=%d error=%v", len(page.Objects), err)
	}
	if peak.Load() <= 1 || peak.Load() > 8 {
		t.Fatalf("expected concurrent verification bounded at 8 requests, peak=%d", peak.Load())
	}
	for index, object := range page.Objects {
		if object.Key != records[index].Key {
			t.Fatalf("response order changed at %d: %s", index, object.Key)
		}
	}
	t.Logf("100 delayed HEADs loaded in %s, peak concurrency=%d", time.Since(start).Round(time.Millisecond), peak.Load())
}

func TestGalleryRefillsPagesInOrderAndPrunesConfirmedInvalidRecords(t *testing.T) {
	for _, order := range []string{"name-asc", "name-desc", "time-asc", "time-desc"} {
		t.Run(order, func(t *testing.T) {
			var invalidChecks atomic.Int64
			s, p, records := newUploadVerificationService(t, 14, func(w http.ResponseWriter, r *http.Request, index int) {
				timer := time.NewTimer(time.Duration(14-index) * time.Millisecond)
				defer timer.Stop()
				select {
				case <-r.Context().Done():
					return
				case <-timer.C:
				}
				switch index {
				case 0, 4:
					invalidChecks.Add(1)
					w.WriteHeader(http.StatusNotFound)
				case 1:
					invalidChecks.Add(1)
					w.Header().Set("X-Amz-Meta-Picpiper-Upload-Id", "external-replacement")
				case 2:
					invalidChecks.Add(1)
					w.Header().Set("ETag", `"external-etag"`)
				}
			})
			want := []string{}
			for _, index := range []int{3, 5, 6, 7, 8, 9, 10, 11, 12, 13} {
				want = append(want, records[index].Key)
			}
			if strings.HasSuffix(order, "desc") {
				slices.Reverse(want)
			}
			size := 3
			request := galleryRequest{Profile: p, Sort: order, PageSize: &size}
			got := []string{}
			for pageNumber := 0; ; pageNumber++ {
				if pageNumber > 14 {
					t.Fatal("pagination did not advance")
				}
				page, err := s.listUploads(context.Background(), request, "synthetic-secret")
				if err != nil {
					t.Fatal(err)
				}
				if len(page.Objects) > size || (page.NextContinuationToken != nil && len(page.Objects) != size) {
					t.Fatalf("page was not filled from later valid records: %+v", page)
				}
				for _, object := range page.Objects {
					got = append(got, object.Key)
				}
				request.Token = page.NextContinuationToken
				if request.Token == nil {
					break
				}
			}
			if !slices.Equal(got, want) {
				t.Fatalf("pagination changed sorted results: got %v want %v", got, want)
			}
			if remaining := recordedUploads(t, s, p); len(remaining) != len(want) {
				t.Fatalf("confirmed invalid records remained in local history: %d", len(remaining))
			}
			if _, err := s.listUploads(context.Background(), galleryRequest{Profile: p, Sort: order}, "synthetic-secret"); err != nil {
				t.Fatal(err)
			}
			if invalidChecks.Load() != 4 {
				t.Fatalf("refresh rechecked confirmed invalid records: %d HEADs", invalidChecks.Load())
			}
		})
	}
}

func TestGalleryPruningPreservesUploadsChangedDuringVerification(t *testing.T) {
	started, proceed := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(proceed) })
	defer release()
	s, p, records := newUploadVerificationService(t, 2, func(w http.ResponseWriter, r *http.Request, index int) {
		if index == 0 {
			close(started)
			select {
			case <-proceed:
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := s.listUploads(ctx, galleryRequest{Profile: p, Sort: "name-asc"}, "synthetic-secret")
		done <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("verification did not start")
	}
	replacement := records[0]
	replacement.UploadID, replacement.ETag = "new-upload", `"new-etag"`
	if err := s.recordUpload(p, replacement); err != nil {
		t.Fatal(err)
	}
	additional := replacement
	additional.Key, additional.FileName = "later.png", "later.png"
	if err := s.recordUpload(p, additional); err != nil {
		t.Fatal(err)
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	remaining := recordedUploads(t, s, p)
	if len(remaining) != 2 || remaining[replacement.Key] != replacement || remaining[additional.Key] != additional {
		t.Fatalf("pruning lost concurrent upload records: %+v", remaining)
	}
}

func TestGalleryVerificationErrorsDoNotForgetUnconfirmedRecords(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, p, records := newUploadVerificationService(t, 3, func(w http.ResponseWriter, _ *http.Request, index int) {
				switch index {
				case 0:
					w.WriteHeader(http.StatusNotFound)
				case 1:
					w.WriteHeader(status)
				}
			})
			if _, err := s.listUploads(context.Background(), galleryRequest{Profile: p, Sort: "name-asc"}, "synthetic-secret"); err == nil {
				t.Fatal("provider failure was hidden")
			}
			remaining := recordedUploads(t, s, p)
			if len(remaining) != 2 || remaining[records[1].Key] != records[1] || remaining[records[2].Key] != records[2] {
				t.Fatalf("cleanup erased unconfirmed records or retained a confirmed deletion: %+v", remaining)
			}
		})
	}
}

func TestGalleryDoesNotVerifyBeyondTheRequestedPage(t *testing.T) {
	var heads atomic.Int64
	s, p, records := newUploadVerificationService(t, 10, func(w http.ResponseWriter, _ *http.Request, index int) {
		heads.Add(1)
		if index != 0 {
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	size := 1
	page, err := s.listUploads(context.Background(), galleryRequest{Profile: p, Sort: "name-asc", PageSize: &size}, "synthetic-secret")
	if err != nil || len(page.Objects) != 1 || page.Objects[0].Key != records[0].Key || page.NextContinuationToken == nil || heads.Load() != 1 {
		t.Fatalf("unneeded objects were checked: page=%+v heads=%d error=%v", page, heads.Load(), err)
	}
}

func TestGalleryCancellationStopsInFlightVerificationWithoutPruning(t *testing.T) {
	started := make(chan struct{})
	notify := sync.OnceFunc(func() { close(started) })
	var active atomic.Int64
	s, p, records := newUploadVerificationService(t, 20, func(_ http.ResponseWriter, r *http.Request, _ int) {
		active.Add(1)
		defer active.Add(-1)
		notify()
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := s.listUploads(ctx, galleryRequest{Profile: p}, "synthetic-secret")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("verification did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancellation did not stop the page request")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation left verification workers blocked")
	}
	deadline := time.Now().Add(time.Second)
	for active.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if active.Load() != 0 {
		t.Fatal("canceled HEAD requests remain active")
	}
	if remaining := recordedUploads(t, s, p); len(remaining) != len(records) {
		t.Fatalf("cancellation removed unverified records: %d", len(remaining))
	}
}
