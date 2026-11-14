package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const galleryVerificationConcurrency = 8

type uploadedImage struct {
	Key        string `json:"key"`
	FileName   string `json:"fileName"`
	UploadedAt string `json:"uploadedAt"`
	Size       int64  `json:"size"`
	ETag       string `json:"etag"`
	UploadID   string `json:"uploadId"`
}

type galleryRequest struct {
	Profile  profile `json:"profile"`
	Prefix   string  `json:"prefix"`
	Token    *string `json:"continuationToken"`
	PageSize *int    `json:"pageSize"`
	Sort     string  `json:"sort"`
}

func uploadBucketID(p profile) string {
	data, _ := json.Marshal([]string{strings.TrimRight(p.Endpoint, "/"), p.Bucket})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func (s *Service) uploadRecordsPath(p profile) string {
	return filepath.Join(s.dataDir, "uploads", uploadBucketID(p)+".json")
}
func (s *Service) loadUploadRecordsLocked(p profile) (map[string]uploadedImage, error) {
	records := map[string]uploadedImage{}
	data, err := os.ReadFile(s.uploadRecordsPath(p))
	if os.IsNotExist(err) {
		return records, nil
	}
	if err != nil || json.Unmarshal(data, &records) != nil || records == nil {
		return nil, appErr("uploadHistoryReadFailed", "Could not read local upload records.")
	}
	for key, record := range records {
		_, dateErr := time.Parse(time.RFC3339Nano, record.UploadedAt)
		if dateErr != nil || record.Size < 0 || key != record.Key || validateKey(key) != nil || record.FileName == "" || record.UploadID == "" {
			return nil, appErr("uploadHistoryReadFailed", "Local upload records are invalid.")
		}
	}
	return records, nil
}
func (s *Service) recordUpload(p profile, record uploadedImage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadUploadRecordsLocked(p)
	if err != nil {
		return err
	}
	records[record.Key] = record
	dir := filepath.Dir(s.uploadRecordsPath(p))
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err = os.Chmod(dir, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(records)
	if err != nil {
		return err
	}
	return atomicWrite(s.uploadRecordsPath(p), data, 0600, "uploadHistoryWriteFailed")
}
func (s *Service) forgetUpload(p profile, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadUploadRecordsLocked(p)
	if err != nil {
		return err
	}
	if _, exists := records[key]; !exists {
		return nil
	}
	delete(records, key)
	data, err := json.Marshal(records)
	if err != nil {
		return err
	}
	return atomicWrite(s.uploadRecordsPath(p), data, 0600, "uploadHistoryWriteFailed")
}

func (s *Service) forgetInvalidUploads(p profile, invalid []uploadedImage) error {
	if len(invalid) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadUploadRecordsLocked(p)
	if err != nil {
		return err
	}
	changed := false
	for _, observed := range invalid {
		// A HEAD checked an earlier snapshot. Do not remove a newer upload of
		// the same key or overwrite records added while verification ran.
		if current, exists := records[observed.Key]; exists && current == observed {
			delete(records, observed.Key)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	data, err := json.Marshal(records)
	if err != nil {
		return err
	}
	return atomicWrite(s.uploadRecordsPath(p), data, 0600, "uploadHistoryWriteFailed")
}

func (s *Service) verifyUpload(ctx context.Context, p profile, secret string, record uploadedImage) (bool, error) {
	// Verify only known app uploads, never enumerate unrelated bucket contents.
	resp, err := s.doS3(ctx, p, secret, http.MethodHead, record.Key, nil, "", nil)
	if err != nil {
		var status *statusError
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return false, nil
		}
		return false, err
	}
	defer resp.Body.Close()
	return resp.Header.Get("X-Amz-Meta-Picpiper-Upload-Id") == record.UploadID &&
		(record.ETag == "" || resp.Header.Get("ETag") == record.ETag), nil
}

func compareUpload(a, b uploadedImage, order string) int {
	var result int
	switch order {
	case "name-asc", "name-desc":
		result = strings.Compare(strings.ToLower(a.FileName), strings.ToLower(b.FileName))
		if order == "name-desc" {
			result = -result
		}
	default:
		result = strings.Compare(a.UploadedAt, b.UploadedAt)
		if order == "time-desc" {
			result = -result
		}
	}
	if result == 0 {
		result = strings.Compare(a.Key, b.Key)
	}
	return result
}

func (s *Service) listUploads(ctx context.Context, request galleryRequest, secret string) (listResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	order := request.Sort
	if order == "" {
		order = "time-desc"
	}
	switch order {
	case "time-desc", "time-asc", "name-asc", "name-desc":
	default:
		return listResponse{}, appErr("invalidSort", "Choose a valid gallery sort order.")
	}
	s.mu.Lock()
	records, err := s.loadUploadRecordsLocked(request.Profile)
	s.mu.Unlock()
	if err != nil {
		return listResponse{}, err
	}
	candidates := []uploadedImage{}
	for _, record := range records {
		if isImage(record.Key) && strings.HasPrefix(record.Key, request.Prefix) {
			candidates = append(candidates, record)
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return compareUpload(candidates[i], candidates[j], order) < 0 })
	scopeData, _ := json.Marshal([]string{uploadBucketID(request.Profile), request.Prefix, order})
	scopeHash := sha256.Sum256(scopeData)
	scope := hex.EncodeToString(scopeHash[:])
	type cursor struct {
		Scope string        `json:"scope"`
		After uploadedImage `json:"after"`
	}
	var after *uploadedImage
	if request.Token != nil {
		if len(*request.Token) > 8192 {
			return listResponse{}, appErr("invalidGalleryCursor", "Reload this gallery before loading more images.")
		}
		var token cursor
		raw, decodeErr := base64.RawURLEncoding.DecodeString(*request.Token)
		if decodeErr != nil || json.Unmarshal(raw, &token) != nil || token.Scope != scope || token.After.Key == "" {
			return listResponse{}, appErr("invalidGalleryCursor", "Reload this gallery before loading more images.")
		}
		after = &token.After
	}
	if after != nil {
		start := sort.Search(len(candidates), func(index int) bool { return compareUpload(candidates[index], *after, order) > 0 })
		candidates = candidates[start:]
	}
	size := 100
	if request.PageSize != nil {
		size = min(100, max(1, *request.PageSize))
	}
	out := listResponse{Objects: []galleryObject{}}
	var invalid []uploadedImage
	defer func() {
		// Cleanup is best effort: a local write failure must not discard a
		// remotely verified page. Never forget records on transient errors.
		_ = s.forgetInvalidUploads(request.Profile, invalid)
	}()
	index := 0
	for index < len(candidates) && len(out.Objects) < size {
		count := min(galleryVerificationConcurrency, size-len(out.Objects), len(candidates)-index)
		batch := candidates[index : index+count]
		checks := make([]struct {
			valid bool
			err   error
		}, count)
		var workers sync.WaitGroup
		for offset, record := range batch {
			workers.Go(func() {
				checks[offset].valid, checks[offset].err = s.verifyUpload(ctx, request.Profile, secret, record)
			})
		}
		workers.Wait()
		for offset, check := range checks {
			if check.err == nil && !check.valid {
				invalid = append(invalid, batch[offset])
			}
		}
		// Assemble in candidate order, independent of HEAD completion order.
		// The next batch fills gaps left by deleted or replaced objects.
		for offset, check := range checks {
			if check.err != nil {
				return listResponse{}, appErr("s3ListFailed", "Could not check uploaded images in this bucket.")
			}
			if !check.valid {
				continue
			}
			record := batch[offset]
			modified := record.UploadedAt
			object := makeObject(request.Profile, record.Key, record.Size, &modified)
			object.ETag = record.ETag
			object.FileName, object.UploadedAt = record.FileName, record.UploadedAt
			out.Objects = append(out.Objects, object)
		}
		index += count
	}
	if index < len(candidates) {
		raw, _ := json.Marshal(cursor{Scope: scope, After: candidates[index-1]})
		next := base64.RawURLEncoding.EncodeToString(raw)
		out.NextContinuationToken = &next
	}
	return out, nil
}

func uploadTimestamp(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000000000Z") }
