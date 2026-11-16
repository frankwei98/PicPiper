package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadUploadRecordsRecoversIndividualInvalidRecords(t *testing.T) {
	s := New(t.TempDir())
	p := profile{Endpoint: "https://s3.example.test", Bucket: "bucket"}
	path := s.uploadRecordsPath(p)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	valid := uploadedImage{Key: "valid/photo.png", FileName: "photo.png", UploadedAt: "2026-11-16T00:00:00.000000000Z", Size: 12, UploadID: "id-valid"}
	encoded, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	input := `{"valid/photo.png":` + string(encoded) + `,"invalid/schema.png":{"key":"invalid/schema.png","fileName":"bad.png","uploadedAt":"not-a-date","size":-1,"uploadId":"id-bad"},"invalid/decode.png":"not an upload record"}`
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}

	records, err := s.loadUploadRecordsLocked(p)
	if err != nil {
		t.Fatalf("valid history should survive invalid records: %v", err)
	}
	if len(records) != 1 || records[valid.Key] != valid {
		t.Fatalf("recovered records = %#v", records)
	}
	if err := s.recordUpload(p, uploadedImage{Key: "new/photo.png", FileName: "new.png", UploadedAt: valid.UploadedAt, Size: 4, UploadID: "id-new"}); err != nil {
		t.Fatalf("new upload could not be recorded after recovery: %v", err)
	}

	backups, err := filepath.Glob(path + ".corrupt-*.json")
	if err != nil || len(backups) != 1 {
		t.Fatalf("recovery backup files = %v, %v", backups, err)
	}
	info, err := os.Stat(backups[0])
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("backup permissions = %v, %v", info, err)
	}
	backupData, err := os.ReadFile(backups[0])
	if err != nil || !strings.Contains(string(backupData), "invalid/schema.png") || !strings.Contains(string(backupData), "not-a-date") || !strings.Contains(string(backupData), "invalid/decode.png") {
		t.Fatalf("backup did not retain invalid record diagnostics: %s (%v)", backupData, err)
	}
}

func TestLoadUploadRecordsKeepsWholeFileJSONErrorsExplicit(t *testing.T) {
	s := New(t.TempDir())
	p := profile{Endpoint: "https://s3.example.test", Bucket: "bucket"}
	path := s.uploadRecordsPath(p)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"broken":`), 0600); err != nil {
		t.Fatal(err)
	}
	if records, err := s.loadUploadRecordsLocked(p); err == nil || records != nil {
		t.Fatalf("malformed whole file should remain an explicit error, got %#v, %v", records, err)
	}
}

func TestUploadRecoveryBackupFailureIsReturned(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(blocker, []byte("file"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeUploadRecoveryBackup(filepath.Join(blocker, "history.json"), []byte(`{"invalidRecords":[]}`)); err == nil {
		t.Fatal("expected recovery backup failure")
	}
}
