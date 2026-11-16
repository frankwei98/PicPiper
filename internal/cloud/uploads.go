package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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
	path := s.uploadRecordsPath(p)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]uploadedImage{}, nil
	}
	if err != nil {
		return nil, appErr("uploadHistoryReadFailed", "Could not read local upload records.")
	}
	var rawRecords map[string]json.RawMessage
	if json.Unmarshal(data, &rawRecords) != nil || rawRecords == nil {
		return nil, appErr("uploadHistoryReadFailed", "Could not read local upload records.")
	}
	records := make(map[string]uploadedImage, len(rawRecords))
	invalid := make([]uploadRecoveryRecord, 0)
	for key, raw := range rawRecords {
		var record uploadedImage
		if decodeErr := json.Unmarshal(raw, &record); decodeErr != nil {
			invalid = append(invalid, uploadRecoveryRecord{Key: key, Error: decodeErr.Error(), Record: raw})
			continue
		}
		if reason := validateUploadedImage(key, record); reason != "" {
			invalid = append(invalid, uploadRecoveryRecord{Key: key, Error: reason, Record: raw})
			continue
		}
		records[key] = record
	}
	if len(invalid) != 0 {
		backup, marshalErr := json.Marshal(uploadRecoveryBackup{Records: invalid})
		if marshalErr != nil {
			return nil, appErr("uploadHistoryRecoveryFailed", marshalErr.Error())
		}
		if err := writeUploadRecoveryBackup(path, backup); err != nil {
			return nil, appErr("uploadHistoryRecoveryFailed", err.Error())
		}
		clean, marshalErr := json.Marshal(records)
		if marshalErr != nil {
			return nil, appErr("uploadHistoryRecoveryFailed", marshalErr.Error())
		}
		if err := atomicWrite(path, clean, 0600, "uploadHistoryRecoveryFailed"); err != nil {
			return nil, err
		}
	}
	return records, nil
}

func validateUploadedImage(key string, record uploadedImage) string {
	if _, err := time.Parse(time.RFC3339Nano, record.UploadedAt); err != nil {
		return "invalid uploadedAt: " + err.Error()
	}
	if record.Size < 0 {
		return "size must not be negative"
	}
	if key != record.Key {
		return "record key does not match map key"
	}
	if err := validateKey(key); err != nil {
		return "invalid key: " + err.Error()
	}
	if record.FileName == "" {
		return "fileName is empty"
	}
	if record.UploadID == "" {
		return "uploadId is empty"
	}
	return ""
}

type uploadRecoveryRecord struct {
	Key    string          `json:"key"`
	Error  string          `json:"error"`
	Record json.RawMessage `json:"record"`
}

type uploadRecoveryBackup struct {
	Records []uploadRecoveryRecord `json:"invalidRecords"`
}

func writeUploadRecoveryBackup(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	base := path + ".corrupt-" + time.Now().UTC().Format("20060102T150405.000000000Z")
	for attempt := 0; attempt < 100; attempt++ {
		backup := base + ".json"
		if attempt != 0 {
			backup = base + "-" + strconv.Itoa(attempt) + ".json"
		}
		file, err := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		written, writeErr := file.Write(data)
		if writeErr == nil && written != len(data) {
			writeErr = io.ErrShortWrite
		}
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr == nil {
			writeErr = closeErr
		}
		if writeErr != nil {
			_ = os.Remove(backup)
			return writeErr
		}
		return nil
	}
	return errors.New("could not reserve a unique upload recovery backup name")
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
	uploadID, etag := resp.Header.Get("X-Amz-Meta-Picpiper-Upload-Id"), resp.Header.Get("ETag")
	if uploadID == "" || (uploadID == record.UploadID && record.ETag != "" && etag == "") {
		return false, appErr("s3ObjectUnverified", "The provider did not return enough metadata to verify this upload.")
	}
	return uploadID == record.UploadID && (record.ETag == "" || etag == record.ETag), nil
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
		if err := ctx.Err(); err != nil {
			return listResponse{}, err
		}
		for offset, check := range checks {
			if check.err == nil && !check.valid {
				invalid = append(invalid, batch[offset])
			}
		}
		// Assemble in candidate order, independent of HEAD completion order.
		// The next batch fills gaps left by deleted or replaced objects.
		for offset, check := range checks {
			if check.err != nil {
				out.UnverifiedCount++
				continue
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
