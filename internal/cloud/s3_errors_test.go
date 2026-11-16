package cloud

import (
	"context"
	"errors"
	"github.com/frankwei98/PicPiper/internal/apperror"
	"net/http"
	"strings"
	"testing"
)

func TestS3ErrorsRetainCancellationAndTimeout(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		if err := s3error("s3DownloadFailed", cause); !errors.Is(err, cause) {
			t.Errorf("lost context error: %v", err)
		}
	}
}

func TestS3ErrorsRedactProviderAndNetworkDetails(t *testing.T) {
	for _, cause := range []error{
		&statusError{status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code><StringToSign>private-material</StringToSign></Error>"},
		&statusError{status: 403, body: "<Error><Code>private-material</Code></Error>"},
		errors.New("Get https://private-material.example.test: failed"),
	} {
		err := s3error("s3DownloadFailed", cause)
		var app *apperror.Error
		if !errors.As(err, &app) || app.Code != "s3DownloadFailed" || strings.Contains(err.Error(), "private-material") {
			t.Errorf("unsafe S3 error: %v", err)
		}
	}
}

type cancelledDownloadBody struct{}

func (cancelledDownloadBody) Read([]byte) (int, error) { return 0, context.Canceled }
func (cancelledDownloadBody) Close() error             { return nil }
func TestDownloadBodyCancellationRemainsCancelled(t *testing.T) {
	s := New(t.TempDir())
	p := testProfile("https://s3.example.test")
	if _, err := s.saveSecret(p.ID, "fake-secret"); err != nil {
		t.Fatal(err)
	}
	s.client.Transport = r2Transport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: cancelledDownloadBody{}}, nil
	})
	_, err := call(t, s, "download_gallery_object", map[string]any{"profile": p, "key": "image.png", "outputDir": t.TempDir()})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("body cancellation changed: %v", err)
	}
}
