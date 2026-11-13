package cloud

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"time"
)

// Only these known S3 codes may cross the bridge. Provider messages, request IDs,
// canonical requests and signatures can contain credential material.
type r2ProbeError struct {
	status int
	code   string
	kind   string
	format string
}

func (e *r2ProbeError) Error() string {
	if e.status != 0 {
		if e.code == "UnrecognizedS3Error" && e.format != "" {
			return fmt.Sprintf("HTTP %d (%s; %s response)", e.status, e.code, e.format)
		}
		return fmt.Sprintf("HTTP %d (%s)", e.status, e.code)
	}
	return e.kind
}
func safeR2ProbeError(err error) *r2ProbeError {
	var response *statusError
	if errors.As(err, &response) {
		result := &r2ProbeError{status: response.status, code: "UnrecognizedS3Error"}
		body := strings.TrimSpace(response.body)
		result.format = "text"
		if body == "" {
			result.format = "empty"
		}
		var doc struct {
			XMLName xml.Name `xml:"Error"`
			Code    string   `xml:"Code"`
		}
		if xml.Unmarshal([]byte(body), &doc) == nil {
			result.format = "XML"
			if knownR2S3Code(doc.Code) {
				result.code = doc.Code
			}
		} else if json.Valid([]byte(body)) {
			result.format = "JSON"
			var document struct {
				Code   json.RawMessage `json:"code"`
				Error  string          `json:"error"`
				Errors []struct {
					Code json.RawMessage `json:"code"`
				} `json:"errors"`
			}
			if json.Unmarshal([]byte(body), &document) == nil {
				codes := []json.RawMessage{document.Code}
				for _, item := range document.Errors {
					codes = append(codes, item.Code)
				}
				for _, code := range codes {
					if string(code) == "10002" {
						result.code = "Unauthorized"
						break
					}
					var named string
					if json.Unmarshal(code, &named) == nil && knownR2S3Code(named) {
						result.code = named
						break
					}
				}
				if result.code == "UnrecognizedS3Error" && knownR2S3Code(document.Error) {
					result.code = document.Error
				}
			}
		} else if body == "Unauthorized" {
			result.code = "Unauthorized"
		}

		return result
	}
	if errors.Is(err, context.Canceled) {
		return &r2ProbeError{kind: "Connection test cancelled"}
	}
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &network) && network.Timeout()) {
		return &r2ProbeError{kind: "Connection test timed out"}
	}
	return &r2ProbeError{kind: "Network or TLS connection failed"}
}
func knownR2S3Code(code string) bool {
	switch code {
	case "Unauthorized", "AccessDenied", "InvalidAccessKeyId", "InvalidToken", "ExpiredToken", "SignatureDoesNotMatch", "AuthorizationHeaderMalformed", "RequestTimeTooSkewed", "RequestExpired", "ExpiredRequest", "NoSuchBucket", "PermanentRedirect", "IncorrectEndpoint", "SlowDown", "ServiceUnavailable", "InternalError", "InvalidRequest", "InvalidArgument", "AccountProblem", "NotEntitled":
		return true
	}
	return false
}
func (e *r2ProbeError) retryable() bool {
	if e.status == 429 || e.status == 500 || e.status == 502 || e.status == 503 || e.status == 504 {
		return true
	}
	// Some authentication failures have no S3 code at all. A bare 401 from
	// a newly minted credential still gets the same bounded activation window.
	if e.status == 401 && e.code == "UnrecognizedS3Error" {
		return true
	}
	return (e.status == 401 || e.status == 403) && (e.code == "Unauthorized" || e.code == "AccessDenied" || e.code == "InvalidAccessKeyId" || e.code == "InvalidToken")
}

// A newly minted token may not yet be recognized by the S3 endpoint. Retry the
// same credential for a bounded activation window; never mint another token to
// retry a probe. Permanent signature, endpoint and bucket errors fail immediately.
func (s *Service) probeR2Bucket(ctx context.Context, p profile, secret string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	delays := []time.Duration{0, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second}
	var last *r2ProbeError
	for _, delay := range delays {
		if delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return safeR2ProbeError(ctx.Err())
			}
		}
		if err := ctx.Err(); err != nil {
			return safeR2ProbeError(err)
		}
		response, err := s.doList(ctx, p, secret, url.Values{"list-type": {"2"}, "prefix": {""}, "max-keys": {"1"}})
		if err == nil {
			var doc listXML
			err = xml.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&doc)
			response.Body.Close()
			if err != nil {
				return &r2ProbeError{kind: "Invalid S3 listing response"}
			}
			return nil
		}
		last = safeR2ProbeError(err)
		if !last.retryable() {
			return last
		}
	}
	return last
}
