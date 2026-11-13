package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type r2Transport func(*http.Request) (*http.Response, error)

func (f r2Transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func r2Response(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

const fakeR2Account = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fakeR2TokenID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func beginR2(t *testing.T, s *Service) *r2Session {
	t.Helper()
	_, err := s.startR2OAuth()
	if err != nil {
		t.Fatal(err)
	}
	session := s.oauth
	t.Cleanup(func() { session.mu.Lock(); session.stopLocked(); session.mu.Unlock() })
	return session
}
func authorizeR2(t *testing.T, s *Service, session *r2Session) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, r2Redirect+"?state="+session.state+"&code=fake-code", nil)
	recorder := httptest.NewRecorder()
	s.r2Callback(session, recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("callback failed: %d", recorder.Code)
	}
}
func TestR2PKCECallbackAndCancellation(t *testing.T) {
	s := New(t.TempDir())
	var verifier string
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != r2TokenURL {
			t.Fatalf("unexpected endpoint: %s", r.URL)
		}
		_ = r.ParseForm()
		verifier = r.Form.Get("code_verifier")
		if r.Form.Get("client_secret") != "" || r.Form.Get("client_id") != r2ClientID || r.Form.Get("redirect_uri") != r2Redirect {
			t.Fatal("wrong public client exchange")
		}
		return r2Response(200, `{"access_token":"private-oauth-token","token_type":"Bearer"}`), nil
	})
	started, err := s.startR2OAuth()
	if err != nil {
		t.Fatal(err)
	}
	session := s.oauth
	t.Cleanup(func() { session.mu.Lock(); session.stopLocked(); session.mu.Unlock() })
	payload := started.(map[string]string)
	u, _ := url.Parse(payload["authorizationUrl"])
	expected := sha256.Sum256([]byte(session.verifier))
	if u.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(expected[:]) || u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("scope") != r2Scopes {
		t.Fatal("PKCE or scopes missing")
	}
	bad := httptest.NewRecorder()
	s.r2Callback(session, bad, httptest.NewRequest("GET", r2Redirect+"?state=wrong&code=fake", nil))
	if bad.Code != 400 || session.status != "pending" {
		t.Fatal("bad state consumed sign-in")
	}
	authorizeR2(t, s, session)
	if verifier == "" || session.status != "authorized" || session.verifier != "" {
		t.Fatal("exchange not completed")
	}
	replay := httptest.NewRecorder()
	s.r2Callback(session, replay, httptest.NewRequest("GET", r2Redirect+"?state="+session.state+"&code=fake", nil))
	if replay.Code != 400 {
		t.Fatal("callback replay accepted")
	}
	if _, err = s.r2Call(context.Background(), "cancel_r2_oauth", r2Request{SessionID: session.id}); err != nil {
		t.Fatal(err)
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.token != "" || session.status != "closed" {
		t.Fatal("cancellation retained token")
	}
}
func TestR2CallbackDenialDoesNotExposeProviderText(t *testing.T) {
	s := New(t.TempDir())
	session := beginR2(t, s)
	recorder := httptest.NewRecorder()
	s.r2Callback(session, recorder, httptest.NewRequest("GET", r2Redirect+"?state="+session.state+"&error=access_denied&error_description=private-secret", nil))
	if session.status != "failed" || strings.Contains(session.message, "private-secret") || strings.Contains(recorder.Body.String(), "private-secret") {
		t.Fatal("denial was not safely handled")
	}
}
func TestR2CreatesScopedProfilesAndPrivateCredentials(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	session := beginR2(t, s)
	session.mu.Lock()
	session.status = "authorized"
	session.token = "oauth-private"
	session.mu.Unlock()
	var created atomic.Int32
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Host, ".r2.cloudflarestorage.com") {
			if !strings.Contains(r.Header.Get("Authorization"), fakeR2TokenID) {
				t.Error("derived access key not signed")
			}
			return r2Response(200, `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`), nil
		}
		if r.Header.Get("Authorization") != "Bearer oauth-private" {
			t.Error("OAuth token missing")
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/r2/buckets"):
			if r.Header.Get("cf-r2-jurisdiction") != "eu" {
				t.Error("jurisdiction not forwarded")
			}
			if r.URL.Query().Get("cursor") == "" {
				return r2Response(200, `{"success":true,"result":{"buckets":[{"name":"photos"}]},"result_info":{"cursor":"next-page"}}`), nil
			}
			return r2Response(200, `{"success":true,"result":{"buckets":[{"name":"screenshots"}]}}`), nil
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/tokens"):
			created.Add(1)
			body, _ := io.ReadAll(r.Body)
			var request struct {
				Policies []struct {
					Resources map[string]string `json:"resources"`
					Groups    []struct {
						ID string `json:"id"`
					} `json:"permission_groups"`
				} `json:"policies"`
			}
			if json.Unmarshal(body, &request) != nil || len(request.Policies) != 1 {
				t.Fatal("invalid token policy")
			}
			policy := request.Policies[0]
			if len(policy.Resources) != 2 || policy.Resources["com.cloudflare.edge.r2.bucket."+fakeR2Account+"_eu_photos"] != "*" || len(policy.Groups) != 1 || policy.Groups[0].ID != r2ItemWritePermission {
				t.Fatalf("wrong scope: %s", body)
			}
			return r2Response(200, `{"success":true,"result":{"id":"`+fakeR2TokenID+`","value":"private-r2-token"}}`), nil
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL)
			return nil, nil
		}
	})
	selection := r2Request{SessionID: session.id, AccountID: fakeR2Account, Jurisdiction: "eu", Buckets: []string{"photos", "screenshots"}}
	result, err := s.r2Call(context.Background(), "list_r2_buckets", selection)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.([]r2Bucket)) != 2 {
		t.Fatal("bucket pagination missing")
	}
	// Simulate an unrelated settings save after discovery; it must survive import.
	original := defaults()
	original.NamingTemplate = "custom/{slug}.{ext}"
	if err = s.saveSettings(original); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal([]byte(`{"publicBaseUrls":{"photos":"https://photos.example.com"}}`), &selection); err != nil {
		t.Fatal(err)
	}
	result, err = s.r2Call(context.Background(), "connect_r2_buckets", selection)
	if err != nil {
		t.Fatal(err)
	}
	saved := result.(settings)
	if len(saved.Profiles) != 2 || saved.DefaultProfileID == nil || saved.NamingTemplate != original.NamingTemplate {
		t.Fatal("settings lost during import")
	}
	if saved.Profiles[0].PublicBaseURL == nil || *saved.Profiles[0].PublicBaseURL != "https://photos.example.com" || saved.Profiles[1].PublicBaseURL != nil {
		t.Fatal("per-bucket public URLs were not preserved")
	}
	digest := sha256.Sum256([]byte("private-r2-token"))
	for _, profile := range saved.Profiles {
		if profile.Endpoint != "https://"+fakeR2Account+".eu.r2.cloudflarestorage.com" || profile.Region != "auto" {
			t.Fatal("wrong R2 endpoint")
		}
		secret, err := os.ReadFile(s.secretPath(profile.ID))
		if err != nil || string(secret) != hex.EncodeToString(digest[:]) {
			t.Fatal("secret derivation wrong")
		}
		info, err := os.Stat(s.secretPath(profile.ID))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("credential permissions wrong")
		}
	}
	contents, _ := os.ReadFile(s.settingsPath())
	if strings.Contains(string(contents), "private-r2-token") || strings.Contains(string(contents), hex.EncodeToString(digest[:])) || strings.Contains(string(contents), "oauth-private") {
		t.Fatal("secret leaked into settings")
	}
	for _, invalid := range []string{"https://", "javascript:alert(1)", "https://user:secret@example.com", "https://example.com?q=1", "https://example.com#fragment"} {
		if err = json.Unmarshal([]byte(`{"publicBaseUrls":{"photos":`+strconv.Quote(invalid)+`}}`), &selection); err != nil {
			t.Fatal(err)
		}
		if _, err = s.r2Call(context.Background(), "connect_r2_buckets", selection); err == nil || created.Load() != 1 {
			t.Fatal("invalid public URL provisioned a token")
		}
	}
	selection.Buckets = []string{"not-discovered"}
	if _, err = s.r2Call(context.Background(), "connect_r2_buckets", selection); err == nil || created.Load() != 1 {
		t.Fatal("undiscovered bucket was provisioned")
	}
}
func TestR2RevokesTokenWhenS3ValidationFails(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.TempDir())
		session := &r2Session{id: "synthetic-session", ctx: context.Background(), buckets: map[string][]r2Bucket{}}
		s.oauth = session
		session.mu.Lock()
		session.status = "authorized"
		session.token = "oauth-private"
		session.buckets[fakeR2Account+":default"] = []r2Bucket{{Name: "photos"}}
		session.mu.Unlock()
		var revoked bool
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Host, ".r2.cloudflarestorage.com") {
				return r2Response(403, `<Error><Code>AccessDenied</Code><Message>private-token oauth-private SignedHeaders Authorization</Message><RequestId>private-request</RequestId></Error>`), nil
			}
			if r.Method == "DELETE" {
				revoked = true
				return r2Response(200, `{"success":true,"result":{"id":"`+fakeR2TokenID+`"}}`), nil
			}
			return r2Response(200, `{"success":true,"result":{"id":"`+fakeR2TokenID+`","value":"private-token"}}`), nil
		})
		_, err := s.r2Call(context.Background(), "connect_r2_buckets", r2Request{SessionID: session.id, AccountID: fakeR2Account, Jurisdiction: "default", Buckets: []string{"photos"}})
		if err == nil || !revoked {
			t.Fatal("failed import did not revoke new token")
		}
		if !strings.Contains(err.Error(), "HTTP 403") || !strings.Contains(err.Error(), "AccessDenied") {
			t.Fatalf("S3 failure lost its safe diagnostic: %s", err)
		}
		for _, private := range []string{"private-token", "oauth-private", "SignedHeaders", "Authorization", "private-request"} {
			if strings.Contains(err.Error(), private) {
				t.Fatal("private provider data leaked into failure")
			}
		}

		settings, _ := s.loadSettings()
		if len(settings.Profiles) != 0 {
			t.Fatal("failed import persisted profile")
		}
	})
}
func TestR2RejectsExpiredAndConcurrentImports(t *testing.T) {
	s := New(t.TempDir())
	session := beginR2(t, s)
	session.mu.Lock()
	session.status = "authorized"
	session.importing = true
	session.mu.Unlock()
	if _, err := s.r2Call(context.Background(), "connect_r2_buckets", r2Request{SessionID: session.id}); err == nil {
		t.Fatal("parallel import accepted")
	}
	session.mu.Lock()
	session.importing = false
	session.cancel()
	session.mu.Unlock()
	if _, err := s.r2Call(context.Background(), "list_r2_accounts", r2Request{SessionID: session.id}); err == nil {
		t.Fatal("expired session accepted")
	}
	// Wait for cancellation cleanup before asserting the sensitive token is erased.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		session.mu.Lock()
		cleared := session.token == ""
		session.mu.Unlock()
		if cleared {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("session cleanup did not erase token")
}

func TestR2WaitsForNewCredentialActivation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.TempDir())
		session := &r2Session{buckets: map[string][]r2Bucket{fakeR2Account + ":default": {{Name: "photos"}}}}
		requests, created, revoked := 0, 0, 0
		s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Host, ".r2.cloudflarestorage.com") {
				requests++
				if requests < 4 {
					return r2Response(401, `<Error><Code>Unauthorized</Code><Message>private-token</Message></Error>`), nil
				}
				return r2Response(200, `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`), nil
			}
			if r.Method == "DELETE" {
				revoked++
				return r2Response(200, `{"success":true,"result":{}}`), nil
			}
			created++
			return r2Response(200, `{"success":true,"result":{"id":"`+fakeR2TokenID+`","value":"private-token"}}`), nil
		})
		_, err := s.connectR2Buckets(context.Background(), session, r2Request{AccountID: fakeR2Account, Jurisdiction: "default", Buckets: []string{"photos"}}, "oauth-private")
		if err != nil {
			t.Fatalf("new credentials were revoked before activation: %s", err)
		}
		if requests != 4 || created != 1 || revoked != 0 {
			t.Fatalf("requests=%d created=%d revoked=%d", requests, created, revoked)
		}
	})
}

func TestR2CallbackServesPrivateMultilingualHTMLAndAppReturnLink(t *testing.T) {
	s := New(t.TempDir())
	session := beginR2(t, s)
	s.client.Transport = r2Transport(func(r *http.Request) (*http.Response, error) {
		return r2Response(200, `{"access_token":"private-test-token","token_type":"Bearer"}`), nil
	})
	recorder := httptest.NewRecorder()
	s.r2Callback(session, recorder, httptest.NewRequest("GET", r2Redirect+"?state="+session.state+"&code=private-test-code", nil))
	if recorder.Code != 200 || recorder.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatal("callback is not an HTML success page")
	}
	body := recorder.Body.String()
	for _, language := range []string{"en", "zh-CN", "es", "fr", "ja", "ko"} {
		if !strings.Contains(body, `lang="`+language+`"`) {
			t.Fatalf("missing language %s", language)
		}
	}
	for _, text := range []string{"Connected to Cloudflare. You can close this tab and return to Pic Piper to choose your R2 buckets.", `href="picpiper://oauth/cloudflare/connected"`, `window.location.assign("picpiper://oauth/cloudflare/connected")`, "history.replaceState"} {
		if !strings.Contains(body, text) {
			t.Fatalf("missing completion behavior %s", text)
		}
	}
	for _, secret := range []string{session.state, "private-test-token", "private-test-code"} {
		if strings.Contains(body, secret) {
			t.Fatal("callback leaked OAuth material")
		}
	}
	policy := recorder.Header().Get("Content-Security-Policy")
	for _, tag := range []string{"style", "script"} {
		_, rest, _ := strings.Cut(body, "<"+tag+">")
		content, _, _ := strings.Cut(rest, "</"+tag+">")
		hash := sha256.Sum256([]byte(content))
		if !strings.Contains(policy, "'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'") {
			t.Fatal("CSP blocks completion page assets")
		}
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Referrer-Policy") != "no-referrer" || !strings.Contains(policy, "default-src 'none'") {
		t.Fatal("callback page permits caching or external resources")
	}
}
