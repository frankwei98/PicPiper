package cloud

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestR2ProbeRejectsPermanentFailuresWithoutRetry(t *testing.T) {
	for _, code := range []string{"SignatureDoesNotMatch", "NoSuchBucket", "AuthorizationHeaderMalformed"} {
		t.Run(code, func(t *testing.T) {
			attempts := 0
			s := New(t.TempDir())
			s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
				attempts++
				return r2Response(403, `<Error><Code>`+code+`</Code><Message>private-signature</Message></Error>`), nil
			})
			err := s.probeR2Bucket(context.Background(), testProfile("https://s3.example.test"), "private-secret")
			if err == nil || !strings.Contains(err.Error(), code) || strings.Contains(err.Error(), "private-") || attempts != 1 {
				t.Fatalf("incorrect permanent failure: attempts=%d err=%v", attempts, err)
			}
		})
	}
}
func TestR2ProbeBoundsActivationRetries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.TempDir())
		attempts := 0
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			attempts++
			return r2Response(403, `<Error><Code>AccessDenied</Code></Error>`), nil
		})
		start := time.Now()
		err := s.probeR2Bucket(context.Background(), testProfile("https://s3.example.test"), "private-secret")
		if err == nil || attempts != 5 || time.Since(start) != 15*time.Second {
			t.Fatalf("unbounded probe: attempts=%d duration=%s err=%v", attempts, time.Since(start), err)
		}
	})
}
func TestR2ProbeCancellationStopsActivationWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.TempDir())
		attempts := 0
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			attempts++
			cancel()
			return r2Response(403, `<Error><Code>InvalidAccessKeyId</Code></Error>`), nil
		})
		err := s.probeR2Bucket(ctx, testProfile("https://s3.example.test"), "private-secret")
		if err == nil || !strings.Contains(err.Error(), "cancelled") || attempts != 1 {
			t.Fatalf("cancellation ignored: attempts=%d err=%v", attempts, err)
		}
	})
}
func TestR2ProbeNeverExposesArbitraryProviderContent(t *testing.T) {
	for _, body := range []string{
		`<Error><Code>private-secret</Code><Message>Authorization signature secret</Message></Error>`,
		`<html>private-secret Authorization signature</html>`,
		`<Error><Code>AccessDenied</Code><CanonicalRequest>private-secret</CanonicalRequest><RequestId>private-request</RequestId></Error>`,
	} {
		err := safeR2ProbeError(&statusError{403, body})
		if !strings.Contains(err.Error(), "HTTP 403") || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "signature") {
			t.Fatal("unsafe provider content reached diagnostic")
		}
	}
	err := safeR2ProbeError(errors.New("private-secret Authorization signed URL"))
	if err.Error() != "Network or TLS connection failed" {
		t.Fatal("network error leaked private request data")
	}
}

func TestR2ProbeRecognizesUnauthorizedFormats(t *testing.T) {
	for _, body := range []string{
		`<Error><Code>Unauthorized</Code><Message>private-token</Message></Error>`,
		`{"code":10002,"message":"Unauthorized","private":"private-token"}`,
		`{"success":false,"errors":[{"code":10002,"message":"Unauthorized"}]}`,
		`Unauthorized`,
	} {
		err := safeR2ProbeError(&statusError{401, body})
		if err.code != "Unauthorized" || !err.retryable() {
			t.Fatalf("401 credential activation bypassed retry: %s", err)
		}
	}
}

func TestR2ProbeRetriesBare401WithoutExposingResponse(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.TempDir())
		attempts := 0
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			attempts++
			if attempts < 4 {
				return r2Response(401, "private-token Authorization opaque-response"), nil
			}
			return r2Response(200, `<ListBucketResult/>`), nil
		})
		if err := s.probeR2Bucket(context.Background(), testProfile("https://s3.example.test"), "private-secret"); err != nil {
			t.Fatal(err)
		}
		if attempts != 4 {
			t.Fatalf("bare 401 was not retried: %d attempts", attempts)
		}
	})
}
func TestR2ProbePersistent401RemainsBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.TempDir())
		attempts := 0
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			attempts++
			return r2Response(401, "private-token Authorization opaque-response"), nil
		})
		err := s.probeR2Bucket(context.Background(), testProfile("https://s3.example.test"), "private-secret")
		if err == nil || attempts != 5 || err.Error() != "HTTP 401 (UnrecognizedS3Error; text response)" {
			t.Fatalf("unsafe or unbounded 401: attempts=%d err=%v", attempts, err)
		}
	})
}
