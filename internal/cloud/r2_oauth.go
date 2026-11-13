package cloud

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/frankwei98/PicPiper/internal/apperror"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const r2ClientID = "90db16462df34b1052e5e6c76880e456"
const r2Redirect = "http://127.0.0.1:19827/oauth/cloudflare/callback"
const r2Scopes = "workers-r2-bucket-item.read workers-r2-bucket-item.write workers-r2.read account-api-tokens.write"
const r2API = "https://api.cloudflare.com/client/v4"
const r2TokenURL = "https://dash.cloudflare.com/oauth2/token"
const r2ItemWritePermission = "2efd5506f9c8494dacb1fa10a3e7d5b6"

type r2Session struct {
	mu                                          sync.Mutex
	id, state, verifier, token, status, message string
	ctx                                         context.Context
	cancel                                      context.CancelFunc
	server                                      *http.Server
	importing                                   bool
	// Only buckets obtained from the provider may be provisioned.
	buckets map[string][]r2Bucket
}
type r2Bucket struct {
	Name         string `json:"name"`
	Jurisdiction string `json:"jurisdiction"`
}
type r2Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type r2Request struct {
	SessionID      string            `json:"sessionId"`
	AccountID      string            `json:"accountId"`
	Jurisdiction   string            `json:"jurisdiction"`
	Buckets        []string          `json:"buckets"`
	PublicBaseURLs map[string]string `json:"publicBaseUrls"`
}

func randomR2ID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *Service) startR2OAuth() (any, error) {
	s.oauthMu.Lock()
	defer s.oauthMu.Unlock()
	if s.oauth != nil {
		s.oauth.mu.Lock()
		if s.oauth.importing {
			s.oauth.mu.Unlock()
			return nil, appErr("r2Busy", "R2 configuration is still being saved.")
		}
		s.oauth.stopLocked()
		s.oauth.mu.Unlock()
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:19827")
	if err != nil {
		return nil, appErr("r2CallbackUnavailable", "The R2 sign-in callback port 19827 is in use. Close the other sign-in attempt and retry.")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	session := &r2Session{id: randomR2ID(), state: randomR2ID(), verifier: randomR2ID(), status: "pending", ctx: ctx, cancel: cancel, buckets: map[string][]r2Bucket{}}
	session.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.r2Callback(session, w, r) })}
	s.oauth = session
	go func() { _ = session.server.Serve(listener) }()
	go func() {
		<-ctx.Done()
		session.mu.Lock()
		defer session.mu.Unlock()
		session.token = ""
		if session.status != "closed" {
			session.status = "expired"
		}
		_ = session.server.Close()
	}()
	challenge := sha256.Sum256([]byte(session.verifier))
	query := url.Values{"client_id": {r2ClientID}, "redirect_uri": {r2Redirect}, "response_type": {"code"}, "scope": {r2Scopes}, "state": {session.state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
	return map[string]string{"sessionId": session.id, "authorizationUrl": "https://dash.cloudflare.com/oauth2/auth?" + query.Encode()}, nil
}
func (session *r2Session) stopLocked() {
	session.status, session.token = "closed", ""
	session.cancel()
	_ = session.server.Close()
}
func (s *Service) r2Callback(session *r2Session, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	if r.Method != http.MethodGet || r.URL.Path != "/oauth/cloudflare/callback" || r.Host != "127.0.0.1:19827" {
		http.Error(w, "Invalid callback.", http.StatusBadRequest)
		return
	}
	session.mu.Lock()
	if session.status != "pending" || session.ctx.Err() != nil || subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("state")), []byte(session.state)) != 1 {
		session.mu.Unlock()
		http.Error(w, "Invalid or expired sign-in attempt.", http.StatusBadRequest)
		return
	}
	session.status = "exchanging"
	verifier := session.verifier
	session.verifier = ""
	session.mu.Unlock()
	defer func() { go session.server.Close() }()
	fail := func(message string) {
		session.mu.Lock()
		defer session.mu.Unlock()
		if session.ctx.Err() == nil {
			session.status, session.message = "failed", message
		}
		http.Error(w, "Sign-in could not be completed. Return to Pic Piper to retry.", http.StatusBadRequest)
	}
	if r.URL.Query().Get("error") != "" {
		fail("Cloudflare sign-in was declined. You can retry or configure S3 later.")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail("Cloudflare did not return an authorization code.")
		return
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {r2ClientID}, "redirect_uri": {r2Redirect}, "code": {code}, "code_verifier": {verifier}}
	ctx, cancel := context.WithTimeout(session.ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r2TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		fail("Could not start the Cloudflare token exchange.")
		return
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.client.Do(request)
	if err != nil {
		fail("Could not reach Cloudflare. Please retry sign-in.")
		return
	}
	defer response.Body.Close()
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&token) != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "bearer") {
		fail("Cloudflare rejected the token exchange. Check the client ID, PKCE configuration, redirect URL and configured scopes.")
		return
	}
	session.mu.Lock()
	authorized := session.ctx.Err() == nil
	if authorized {
		session.token, session.status = token.AccessToken, "authorized"
	}
	session.mu.Unlock()
	if !authorized {
		http.Error(w, "Sign-in was cancelled. Return to Pic Piper to retry.", http.StatusBadRequest)
		return
	}
	writeR2ConnectedPage(w)
}

func validR2Account(id string) bool {
	b, err := hex.DecodeString(id)
	return err == nil && len(b) == 16
}
func validR2Jurisdiction(j string) bool {
	return j == "default" || j == "eu" || j == "fedramp" || j == "us"
}
func (s *Service) r2Call(ctx context.Context, operation string, p r2Request) (any, error) {
	s.oauthMu.Lock()
	session := s.oauth
	s.oauthMu.Unlock()
	if session == nil || session.id != p.SessionID {
		return nil, appErr("r2SessionMissing", "Start Cloudflare sign-in again.")
	}
	session.mu.Lock()
	if operation == "cancel_r2_oauth" {
		session.stopLocked()
		session.mu.Unlock()
		return nil, nil
	}
	if operation == "poll_r2_oauth" {
		result := map[string]string{"status": session.status, "message": session.message}
		session.mu.Unlock()
		return result, nil
	}
	if session.status != "authorized" || session.ctx.Err() != nil {
		session.mu.Unlock()
		return nil, appErr("r2NotAuthorized", "Complete Cloudflare sign-in or start a new attempt.")
	}
	if session.importing {
		session.mu.Unlock()
		return nil, appErr("r2Busy", "R2 configuration is still being saved.")
	}
	token := session.token
	if operation == "connect_r2_buckets" {
		session.importing = true
	}
	session.mu.Unlock()
	opCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(session.ctx, cancel)
	defer stop()
	if operation == "list_r2_accounts" {
		accounts := []r2Account{}
		for page := 1; page <= 100; page++ {
			var batch []r2Account
			if err := s.r2JSON(opCtx, http.MethodGet, fmt.Sprintf("/accounts?per_page=50&page=%d", page), token, nil, nil, &batch); err != nil {
				return nil, err
			}
			accounts = append(accounts, batch...)
			if len(batch) < 50 {
				return accounts, nil
			}
		}
		return nil, appErr("r2TooManyAccounts", "Too many Cloudflare accounts. Enter the account ID instead.")
	}
	if !validR2Account(p.AccountID) || !validR2Jurisdiction(p.Jurisdiction) {
		if operation == "connect_r2_buckets" {
			session.mu.Lock()
			session.importing = false
			session.mu.Unlock()
		}
		return nil, appErr("r2InvalidSelection", "Choose a valid Cloudflare account and jurisdiction.")
	}
	if operation == "list_r2_buckets" {
		var result struct {
			Buckets []r2Bucket `json:"buckets"`
		}
		headers := map[string]string{}
		if p.Jurisdiction != "default" {
			headers["cf-r2-jurisdiction"] = p.Jurisdiction
		}
		buckets := []r2Bucket{}
		cursor := ""
		cursors := map[string]bool{}
		for page := 0; page < 100; page++ {
			var info r2PageInfo
			path := "/accounts/" + p.AccountID + "/r2/buckets?per_page=1000"
			if cursor != "" {
				path += "&cursor=" + url.QueryEscape(cursor)
			}
			if err := s.r2JSON(opCtx, http.MethodGet, path, token, nil, headers, &result, &info); err != nil {
				return nil, err
			}
			buckets = append(buckets, result.Buckets...)
			cursor = info.Cursor
			if cursor == "" {
				break
			}
			if cursors[cursor] || page == 99 {
				return nil, appErr("r2PaginationFailed", "Could not load all R2 buckets. Please retry.")
			}
			cursors[cursor] = true
		}
		result.Buckets = buckets
		session.mu.Lock()
		session.buckets[p.AccountID+":"+p.Jurisdiction] = result.Buckets
		session.mu.Unlock()
		return result.Buckets, nil
	}
	defer func() { session.mu.Lock(); session.importing = false; session.mu.Unlock() }()
	return s.connectR2Buckets(opCtx, session, p, token)
}

// Never return raw provider error bodies: these endpoints handle live credentials.
type r2PageInfo struct {
	Cursor string `json:"cursor"`
}

func (s *Service) r2JSON(ctx context.Context, method, path, token string, body any, headers map[string]string, out any, pageInfo ...*r2PageInfo) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequestWithContext(ctx, method, r2API+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		request.Header.Set(k, v)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return appErr("r2NetworkFailed", "Could not reach Cloudflare. Check your connection and try again.")
	}
	defer response.Body.Close()
	var envelope struct {
		Success bool            `json:"success"`
		Info    r2PageInfo      `json:"result_info"`
		Result  json.RawMessage `json:"result"`
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&envelope) != nil || !envelope.Success {
		return appErr("r2APIFailed", fmt.Sprintf("Cloudflare rejected the request (HTTP %d). Check the granted OAuth scopes and account role. Automatic credential creation may require the account_api_tokens:create scope in addition to account-api-tokens.write.", response.StatusCode))
	}
	if len(pageInfo) > 0 {
		*pageInfo[0] = envelope.Info
	}
	if out != nil {
		if err = json.Unmarshal(envelope.Result, out); err != nil {
			return appErr("r2ResponseInvalid", "Cloudflare returned an unreadable response.")
		}
	}
	return nil
}

func (s *Service) connectR2Buckets(ctx context.Context, session *r2Session, p r2Request, oauthToken string) (result any, retErr error) {
	if len(p.Buckets) == 0 || len(p.Buckets) > 50 {
		return nil, appErr("r2InvalidSelection", "Select between one and 50 buckets.")
	}
	session.mu.Lock()
	available := append([]r2Bucket(nil), session.buckets[p.AccountID+":"+p.Jurisdiction]...)
	session.mu.Unlock()
	resources := map[string]string{}
	seen := map[string]bool{}
	for _, name := range p.Buckets {
		found := false
		for _, bucket := range available {
			if bucket.Name == name {
				found = true
				break
			}
		}
		if !found || seen[name] {
			return nil, appErr("r2InvalidSelection", "Reload the bucket list and select each bucket once.")
		}
		if value := strings.TrimSpace(p.PublicBaseURLs[name]); value != "" {
			u, err := url.Parse(value)
			if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
				return nil, appErr("invalidSettings", "Public Base URL must be a valid HTTP or HTTPS URL without credentials, query, or fragment.")
			}
		}
		seen[name] = true
		resources["com.cloudflare.edge.r2.bucket."+p.AccountID+"_"+p.Jurisdiction+"_"+name] = "*"
	}
	body := map[string]any{"name": "Pic Piper R2 " + time.Now().UTC().Format("2006-01-02 15:04:05"), "policies": []any{map[string]any{"effect": "allow", "resources": resources, "permission_groups": []any{map[string]string{"id": r2ItemWritePermission}}}}}
	var created struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	}
	if err := s.r2JSON(ctx, http.MethodPost, "/accounts/"+p.AccountID+"/tokens", oauthToken, body, nil, &created); err != nil {
		return nil, err
	}
	if !validR2Account(created.ID) {
		return nil, appErr("r2TokenInvalid", "Cloudflare did not return usable S3 credentials. Check for a newly created Pic Piper token in the Cloudflare dashboard before retrying.")
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if cleanupErr := s.r2JSON(cleanupCtx, http.MethodDelete, "/accounts/"+p.AccountID+"/tokens/"+created.ID, oauthToken, nil, nil, nil); cleanupErr != nil {
			retErr = appErr("r2CleanupFailed", fmt.Sprintf("%v The newly created API token could not be revoked. Revoke the unused Pic Piper token in the Cloudflare dashboard before retrying.", retErr))
		} else {
			var failure *apperror.Error
			if errors.As(retErr, &failure) {
				retErr = appErr(failure.Code, failure.Message+" The newly created API token was revoked.")
			}
		}
	}()
	if created.Value == "" {
		return nil, appErr("r2TokenInvalid", "Cloudflare did not return a usable token value. Please retry.")
	}
	digest := sha256.Sum256([]byte(created.Value))
	secret := hex.EncodeToString(digest[:])
	suffix := ""
	if p.Jurisdiction != "default" {
		suffix = "." + p.Jurisdiction
	}
	profiles := []profile{}
	for _, bucket := range p.Buckets {
		id := "r2-" + randomR2ID()
		ref := "s3:" + id
		pr := profile{ID: id, Name: "R2 · " + bucket, Endpoint: "https://" + p.AccountID + suffix + ".r2.cloudflarestorage.com", Region: "auto", Bucket: bucket, AccessKeyID: created.ID, CredentialRef: &ref, PathStyle: true}
		if value := strings.TrimSpace(p.PublicBaseURLs[bucket]); value != "" {
			pr.PublicBaseURL = &value
		}
		if err := validateProfile(pr); err != nil {
			return nil, err
		}
		// Validate the actual S3 credentials before committing any local profile.
		if err := s.probeR2Bucket(ctx, pr, secret); err != nil {
			return nil, appErr("r2ConnectionFailed", fmt.Sprintf("The generated R2 credentials could not list the selected bucket: %v. Check bucket permissions, account and jurisdiction, then retry.", err))
		}
		profiles = append(profiles, pr)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadSettingsLocked()
	if err != nil {
		return nil, err
	}
	// Commit against the latest settings so unrelated edits are preserved.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Join(s.dataDir, "credentials"), 0700); err != nil {
		return nil, appErr("r2SaveFailed", "Could not create the local credential directory. Revoke any unused Pic Piper token in Cloudflare.")
	}
	if err = os.Chmod(filepath.Join(s.dataDir, "credentials"), 0700); err != nil {
		return nil, err
	}
	written := []string{}
	defer func() {
		if !committed {
			for _, id := range written {
				_ = os.Remove(s.secretPath(id))
			}
		}
	}()
	for _, pr := range profiles {
		if err = atomicWrite(s.secretPath(pr.ID), []byte(secret), 0600, "credentialWriteFailed"); err != nil {
			return nil, err
		}
		written = append(written, pr.ID)
		current.Profiles = append(current.Profiles, pr)
	}
	if current.DefaultProfileID == nil {
		current.DefaultProfileID = &profiles[0].ID
	}
	if err = validateSettings(current); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = s.saveSettingsLocked(current); err != nil {
		return nil, err
	}
	committed = true
	return current, nil
}
