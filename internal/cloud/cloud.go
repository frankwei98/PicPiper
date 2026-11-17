package cloud

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type Service struct {
	renderThumbnail  func(context.Context, string) (string, error)
	thumbnailSlot    chan struct{}
	thumbnailCacheMu sync.Mutex
	thumbnailEpoch   uint64
	dataDir          string
	oauthMu          sync.Mutex
	oauth            *r2Session
	mu               sync.Mutex
	client           *http.Client
	now              func() time.Time
}

func New(dataDir string) *Service {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.ResponseHeaderTimeout = 30 * time.Second
	client := &http.Client{
		Timeout: 30 * time.Minute, Transport: transport,
		// Redirected requests need a new signature; surface the endpoint issue.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Service{thumbnailSlot: make(chan struct{}, 1), dataDir: dataDir, client: client, now: time.Now}
}

type profile struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Endpoint      string  `json:"endpoint"`
	Region        string  `json:"region"`
	Bucket        string  `json:"bucket"`
	AccessKeyID   string  `json:"accessKeyId"`
	CredentialRef *string `json:"credentialRef"`
	PathStyle     bool    `json:"pathStyle"`
	PublicBaseURL *string `json:"publicBaseUrl"`
	DefaultPrefix string  `json:"defaultPrefix"`
}
type features struct {
	Compression bool `json:"compression"`
	S3          bool `json:"s3"`
}
type settings struct {
	ProcessingConcurrency int           `json:"processingConcurrency"`
	CloseBehavior         CloseBehavior `json:"closeBehavior"`
	Mini                  *MiniSettings `json:"mini,omitempty"`
	OnboardingCompleted   bool          `json:"onboardingCompleted,omitempty"`
	Features              *features     `json:"features,omitempty"`
	Profiles              []profile     `json:"profiles"`
	NamingTemplate        string        `json:"namingTemplate"`
	DefaultOutputDir      *string       `json:"defaultOutputDir"`
	DefaultProfileID      *string       `json:"defaultProfileId"`
}
type galleryObject struct {
	FileName            string  `json:"fileName,omitempty"`
	UploadedAt          string  `json:"uploadedAt,omitempty"`
	UploadRecordWarning bool    `json:"uploadRecordWarning,omitempty"`
	ETag                string  `json:"etag,omitempty"`
	Key                 string  `json:"key"`
	Size                int64   `json:"size"`
	LastModified        *string `json:"lastModified"`
	PublicURL           *string `json:"publicUrl"`
	IsImage             bool    `json:"isImage"`
}
type listResponse struct {
	UnverifiedCount       int             `json:"unverifiedCount,omitempty"`
	Objects               []galleryObject `json:"objects"`
	NextContinuationToken *string         `json:"nextContinuationToken"`
}
type s3Cred struct {
	profile
	Secret string `json:"secretAccessKey"`
}

func (s *Service) Call(ctx context.Context, operation string, raw json.RawMessage) (any, error) {
	var request map[string]json.RawMessage
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, appErr("invalidRequest", "Request must be a JSON object.")
	}
	if nested, ok := request["request"]; ok {
		request = nil
		_ = json.Unmarshal(nested, &request)
	}
	decode := func(_ string, dst any) error {
		b, err := json.Marshal(request)
		if err != nil {
			return appErr("invalidRequest", "Invalid request payload.")
		}
		if err = json.Unmarshal(b, dst); err != nil {
			return appErr("invalidRequest", "Invalid request payload.")
		}
		return nil
	}
	switch operation {
	case "start_r2_oauth":
		return s.startR2OAuth()
	case "poll_r2_oauth", "cancel_r2_oauth", "list_r2_accounts", "list_r2_buckets", "connect_r2_buckets":
		var p r2Request
		if err := decode("sessionId", &p); err != nil {
			return nil, err
		}
		return s.r2Call(ctx, operation, p)

	case "delete_s3_profile":
		var p struct {
			ProfileID string `json:"profileId"`
		}
		if err := decode("profileId", &p); err != nil {
			return nil, err
		}
		return s.deleteProfile(p.ProfileID)
	case "load_app_settings":
		return s.loadSettings()
	case "save_app_settings":
		var p struct {
			Settings settings      `json:"settings"`
			Scope    string        `json:"scope"`
			MiniBase *MiniSettings `json:"miniBase"`
		}
		if err := decode("settings", &p); err != nil {
			return nil, err
		}
		if p.Scope != "" {
			return s.saveScopedSettings(p.Settings, p.Scope, p.MiniBase)
		}
		p.Settings.Mini = clipboardMiniSettings(p.Settings.Mini)
		if err := validateSettings(p.Settings); err != nil {
			return nil, err
		}
		return nil, s.saveSettings(p.Settings)
	case "save_s3_secret":
		var p struct {
			ProfileID string `json:"profileId"`
			Secret    string `json:"secretAccessKey"`
		}
		if err := decode("profileId", &p); err != nil {
			return nil, err
		}
		if p.Secret == "" {
			return nil, appErr("invalidCredential", "Secret access key is required.")
		}
		if !validID(p.ProfileID) {
			return nil, appErr("invalidProfileId", "Profile ID contains invalid characters.")
		}
		return s.saveSecret(p.ProfileID, p.Secret)
	case "test_s3_connection":
		var p struct {
			Profile profile `json:"profile"`
			Secret  *string `json:"secretAccessKey"`
		}
		if err := decode("profile", &p); err != nil {
			return nil, err
		}
		secret, err := s.getSecret(p.Profile, p.Secret)
		if err != nil {
			return nil, err
		}
		testCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		_, err = s.list(testCtx, p.Profile, secret, p.Profile.DefaultPrefix, nil, 1)
		if errors.Is(testCtx.Err(), context.DeadlineExceeded) {
			return nil, appErr("s3TestTimedOut", "Connection test timed out after 30 seconds.")
		}
		return nil, err
	case "read_gallery_thumbnail":
		var p thumbnailRequest
		if err := decode("profile", &p); err != nil {
			return nil, err
		}
		return s.readGalleryThumbnail(ctx, p)
	case "list_gallery_objects":
		var p galleryRequest
		if err := decode("profile", &p); err != nil {
			return nil, err
		}
		secret, err := s.getSecret(p.Profile, nil)
		if err != nil {
			return nil, err
		}
		return s.listUploads(ctx, p, secret)
	case "delete_gallery_object":
		var p struct {
			Profile profile `json:"profile"`
			Key     string  `json:"key"`
		}
		if err := decode("profile", &p); err != nil {
			return nil, err
		}
		if err := validateKey(p.Key); err != nil {
			return nil, err
		}
		secret, err := s.getSecret(p.Profile, nil)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		records, historyErr := s.loadUploadRecordsLocked(p.Profile)
		observed, recorded := records[p.Key]
		s.mu.Unlock()
		resp, err := s.doS3(ctx, p.Profile, secret, http.MethodDelete, p.Key, nil, "", nil)
		if err != nil {
			return nil, s3error("s3DeleteFailed", err)
		}
		resp.Body.Close()
		s.removeGalleryThumbnails(ctx, p.Profile, p.Key)
		// Remote deletion already succeeded; a stale local record is also
		// hidden by the next HEAD check if its cleanup cannot be persisted.
		if historyErr == nil && recorded {
			_ = s.forgetInvalidUploads(p.Profile, []uploadedImage{observed})
		}
		return nil, nil
	case "download_gallery_object":
		var p struct {
			Profile   profile `json:"profile"`
			Key       string  `json:"key"`
			OutputDir string  `json:"outputDir"`
		}
		if err := decode("profile", &p); err != nil {
			return nil, err
		}
		if err := validateKey(p.Key); err != nil {
			return nil, err
		}
		name := filepath.Base(p.Key)
		if !safeFilename(name) {
			return nil, appErr("invalidDownloadFileName", "Object key has an unsafe filename.")
		}
		secret, err := s.getSecret(p.Profile, nil)
		if err != nil {
			return nil, err
		}
		resp, err := s.doS3(ctx, p.Profile, secret, http.MethodGet, p.Key, nil, "", nil)
		if err != nil {
			return nil, s3error("s3DownloadFailed", err)
		}
		defer resp.Body.Close()
		path, err := saveUnique(p.OutputDir, name, resp.Body)
		if err != nil {
			if cause := requestContextError(err); cause != nil {
				return nil, cause
			}
			if errors.Is(err, errors.ErrUnsupported) {
				return nil, appErr("downloadWriteUnsupported", "This volume cannot safely publish a complete download without replacing existing files. Choose another destination.")
			}
			return nil, appErr("downloadWriteFailed", "Could not save the downloaded image. Check folder permissions and disk space.")
		}
		return path, nil
	case "upload_gallery_object":
		var p struct {
			Profile     profile `json:"profile"`
			SourcePath  string  `json:"sourcePath"`
			ObjectKey   string  `json:"objectKey"`
			ContentType *string `json:"contentType"`
			FileName    string  `json:"outputFilename"`
		}
		if err := decode("profile", &p); err != nil {
			return nil, err
		}
		if err := validateKey(p.ObjectKey); err != nil {
			return nil, err
		}
		f, err := os.Open(p.SourcePath)
		if err != nil {
			return nil, appErr("uploadReadFailed", err.Error())
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return nil, appErr("uploadReadFailed", err.Error())
		}
		sum, err := hashSeek(f)
		if err != nil {
			return nil, appErr("uploadReadFailed", err.Error())
		}
		secret, err := s.getSecret(p.Profile, nil)
		if err != nil {
			return nil, err
		}
		uploadID := randomR2ID()
		headers := http.Header{"If-None-Match": []string{"*"}}
		headers.Set("X-Amz-Meta-Picpiper-Upload-Id", uploadID)
		if p.ContentType != nil {
			headers.Set("Content-Type", *p.ContentType)
		}
		resp, err := s.doS3(ctx, p.Profile, secret, http.MethodPut, p.ObjectKey, f, hex.EncodeToString(sum), headers)
		if err != nil {
			var se *statusError
			if errors.As(err, &se) {
				if se.status == 409 {
					return nil, appErr("s3UploadConflictRetryable", "The upload conflicted with another write. Retry the upload.")
				}
				if se.status == 412 {
					return nil, appErr("objectAlreadyExists", "An object with this key already exists. Choose a different key or remove the existing object before retrying.")
				}
			}
			return nil, s3error("s3UploadFailed", err)
		}
		resp.Body.Close()
		obj := makeObject(p.Profile, p.ObjectKey, info.Size(), nil)
		obj.ETag = resp.Header.Get("ETag")
		obj.FileName = p.FileName
		if obj.FileName == "" {
			obj.FileName = filepath.Base(p.ObjectKey)
		}
		obj.UploadedAt = uploadTimestamp(s.now())
		modified := obj.UploadedAt
		obj.LastModified = &modified
		record := uploadedImage{Key: obj.Key, FileName: obj.FileName, UploadedAt: obj.UploadedAt, Size: obj.Size, ETag: obj.ETag, UploadID: uploadID}
		if isImage(obj.Key) {
			obj.UploadRecordWarning = s.recordUpload(p.Profile, record) != nil
		}
		return obj, nil
	case "generate_object_key":
		var p struct {
			SourcePath     string `json:"sourcePath"`
			OutputFileName string `json:"outputFileName"`
			Prefix         string `json:"prefix"`
			Template       string `json:"namingTemplate"`
			Ext            string `json:"ext"`
			Suffix         string `json:"collisionSuffix"`
		}
		if err := decode("sourcePath", &p); err != nil {
			return nil, err
		}
		f, err := os.Open(p.SourcePath)
		if err != nil {
			return nil, appErr("readFileFailed", err.Error())
		}
		defer f.Close()
		h := sha256.New()
		if _, err = io.Copy(h, f); err != nil {
			return nil, appErr("readFileFailed", err.Error())
		}
		key, err := renderKey(p.Template, p.OutputFileName, p.Ext, hex.EncodeToString(h.Sum(nil)), s.now().UTC())
		if err != nil {
			return nil, err
		}
		prefix := strings.Trim(p.Prefix, "/")
		if prefix != "" && !hasPrefix(key, prefix) {
			key = prefix + "/" + key
		}
		if p.Suffix != "" {
			key, err = appendSuffix(key, p.Suffix)
			if err != nil {
				return nil, err
			}
		}
		if err = validateKey(key); err != nil {
			return nil, err
		}
		return map[string]string{"objectKey": key}, nil
	default:
		return nil, appErr("unsupportedOperation", "Unsupported cloud operation: "+operation)
	}
}

func appErr(code, msg string) error { return apperror.New(code, msg) }
func validID(v string) bool {
	if v == "" {
		return false
	}
	for _, r := range v {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}
func (s *Service) settingsPath() string { return filepath.Join(s.dataDir, "app-settings.json") }
func (s *Service) secretPath(id string) string {
	return filepath.Join(s.dataDir, "credentials", id+".secret")
}
func defaults() settings {
	mini := DefaultMiniSettings()
	return settings{CloseBehavior: CloseQuit, Mini: &mini, Profiles: []profile{}, NamingTemplate: "{yyyy}/{mm}/{slug}-{hash}.{ext}"}
}
func (s *Service) loadSettings() (settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadSettingsLocked()
}
func (s *Service) loadSettingsLocked() (settings, error) {
	b, e := os.ReadFile(s.settingsPath())
	if os.IsNotExist(e) {
		return defaults(), nil
	}
	if e != nil {
		return settings{}, appErr("settingsReadFailed", e.Error())
	}
	var v settings
	if e = json.Unmarshal(b, &v); e != nil {
		return settings{}, appErr("settingsParseFailed", e.Error())
	}
	if v.Profiles == nil {
		v.Profiles = []profile{}
	}
	v.Mini = clipboardMiniSettings(v.Mini)
	v.CloseBehavior = normalizedCloseBehavior(v.CloseBehavior)
	v.ProcessingConcurrency = max(0, min(v.ProcessingConcurrency, runtime.NumCPU()))
	return v, nil
}
func (s *Service) saveSettings(v settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveSettingsLocked(v)
}
func (s *Service) saveSettingsLocked(v settings) error {
	v.Mini = clipboardMiniSettings(v.Mini)
	v.CloseBehavior = normalizedCloseBehavior(v.CloseBehavior)
	if e := os.MkdirAll(s.dataDir, 0700); e != nil {
		return appErr("settingsDirFailed", e.Error())
	}
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return appErr("settingsSerializeFailed", e.Error())
	}
	return atomicWrite(s.settingsPath(), b, 0600, "settingsWriteFailed")
}
func atomicWrite(path string, b []byte, mode os.FileMode, code string) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".picpiper-*.tmp")
	if e != nil {
		return appErr(code, e.Error())
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = os.Rename(tmp, path)
	}
	if e != nil {
		return appErr(code, e.Error())
	}
	return nil
}
func (s *Service) saveSecret(id, secret string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dataDir, "credentials")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, appErr("credentialDirFailed", e.Error())
	}
	if e := os.Chmod(dir, 0700); e != nil {
		return nil, appErr("credentialDirFailed", e.Error())
	}
	if e := atomicWrite(s.secretPath(id), []byte(secret), 0600, "credentialWriteFailed"); e != nil {
		return nil, e
	}
	return map[string]string{"credentialRef": "s3:" + id}, nil
}
func (s *Service) getSecret(p profile, draft *string) (string, error) {
	if e := validateProfile(p); e != nil {
		return "", e
	}
	if draft != nil && *draft != "" {
		return *draft, nil
	}
	if !validID(p.ID) {
		return "", appErr("invalidProfileId", "Profile ID contains invalid characters.")
	}
	b, e := os.ReadFile(s.secretPath(p.ID))
	if e != nil {
		return "", appErr("credentialMissing", "No saved credential found for profile.")
	}
	return string(b), nil
}
func validateSettings(v settings) error {
	if v.ProcessingConcurrency < 0 || v.ProcessingConcurrency > runtime.NumCPU() {
		return appErr("invalidSettings", "Choose an image processing concurrency between 1 and the available CPU count, or Auto.")
	}
	if v.CloseBehavior != "" && v.CloseBehavior != CloseQuit && v.CloseBehavior != CloseBackground {
		return appErr("invalidSettings", "Choose a supported close-window behavior.")
	}
	if v.Mini != nil {
		if err := validateMini(*v.Mini, v.Profiles); err != nil {
			return err
		}
	}
	if strings.TrimSpace(v.NamingTemplate) == "" {
		return appErr("invalidSettings", "Naming template is required.")
	}
	found := false
	profileIDs := make(map[string]struct{}, len(v.Profiles))
	for _, p := range v.Profiles {
		if e := validateProfile(p); e != nil {
			return e
		}
		identity := strings.ToLower(p.ID)
		if _, exists := profileIDs[identity]; exists {
			return appErr("invalidSettings", "Profile IDs must be unique, ignoring case.")
		}
		profileIDs[identity] = struct{}{}
		if v.DefaultProfileID != nil && p.ID == *v.DefaultProfileID {
			found = true
		}
	}
	if v.DefaultProfileID != nil && !found {
		return appErr("invalidSettings", "Default profile must refer to an existing profile.")
	}
	return nil
}
func validateProfile(p profile) error {
	if !validID(p.ID) {
		return appErr("invalidProfileId", "Profile ID contains invalid characters.")
	}
	for _, v := range []string{p.ID, p.Name, p.Endpoint, p.Region, p.Bucket, p.AccessKeyID} {
		if strings.TrimSpace(v) == "" {
			return appErr("invalidSettings", "Profile fields are required.")
		}
	}
	u, e := url.Parse(p.Endpoint)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return appErr("invalidSettings", "Endpoint must be an HTTP or HTTPS URL without credentials, query, or fragment.")
	}
	if p.PublicBaseURL != nil {
		u, e = url.Parse(*p.PublicBaseURL)
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return appErr("invalidSettings", "Public Base URL must be a valid HTTP or HTTPS URL.")
		}
	}
	if hasControl(p.DefaultPrefix) || hasDotSegments(p.DefaultPrefix) {
		return appErr("invalidSettings", "Default prefix must not contain control characters or path traversal segments.")
	}
	if prefix := strings.Trim(p.DefaultPrefix, "/"); prefix != "" {
		if err := validateKey(prefix); err != nil {
			return appErr("invalidSettings", "Default prefix must not contain backslashes or empty path segments.")
		}
	}
	return nil
}
func hasControl(v string) bool {
	for _, r := range v {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}
func hasDotSegments(v string) bool {
	for _, p := range strings.Split(v, "/") {
		if p == "." || p == ".." {
			return true
		}
	}
	return false
}
func validateKey(k string) error {
	if k == "" || strings.HasPrefix(k, "/") || strings.ContainsRune(k, '\\') {
		return appErr("invalidObjectKey", "Object key is invalid.")
	}
	for _, r := range k {
		if unicode.IsControl(r) {
			return appErr("invalidObjectKey", "Object key must not contain control characters.")
		}
	}
	for _, v := range strings.Split(k, "/") {
		if v == "" || v == "." || v == ".." {
			return appErr("invalidObjectKey", "Object key must not contain empty or traversal path segments.")
		}
	}
	return nil
}
func safeFilename(n string) bool {
	if n == "" || n == "." || n == ".." || strings.ContainsAny(n, `/\\:*?"<>|`) || strings.TrimRight(n, " .") != n {
		return false
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return false
		}
	}
	base := strings.ToUpper(strings.SplitN(n, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³":
		return false
	}
	return true
}
func hashSeek(f *os.File) ([]byte, error) {
	h := sha256.New()
	if _, e := io.Copy(h, f); e != nil {
		return nil, e
	}
	if _, e := f.Seek(0, 0); e != nil {
		return nil, e
	}
	return h.Sum(nil), nil
}
func encodeSeg(v string) string {
	const hexchars = "0123456789ABCDEF"
	var b strings.Builder
	for _, c := range []byte(v) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.~", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hexchars[c>>4])
			b.WriteByte(hexchars[c&15])
		}
	}
	return b.String()
}
func encodeKey(v string) string {
	p := strings.Split(v, "/")
	for i := range p {
		p[i] = encodeSeg(p[i])
	}
	return strings.Join(p, "/")
}
func appendURLPath(u *url.URL, escaped string) {
	base := strings.TrimSuffix(u.EscapedPath(), "/")
	next := base + "/" + escaped
	decoded, err := url.PathUnescape(next)
	if err != nil {
		return
	}
	u.Path, u.RawPath = decoded, next
}

func endpoint(p profile) (*url.URL, error) {
	if e := validateProfile(p); e != nil {
		return nil, e
	}
	u, _ := url.Parse(p.Endpoint)
	path := strings.TrimSuffix(u.EscapedPath(), "/")
	suffix := "/" + strings.Trim(p.Bucket, "/")
	if path == suffix {
		path = ""
	}
	u.Path = ""
	u.RawPath = ""
	decoded, e := url.PathUnescape(path)
	if e != nil {
		return nil, e
	}
	u.Path = decoded
	u.RawPath = path
	return u, nil
}

type statusError struct {
	status int
	body   string
}

func (e *statusError) Error() string { return fmt.Sprintf("S3 returned HTTP %d: %s", e.status, e.body) }
func (s *Service) doS3(ctx context.Context, p profile, secret, method, key string, body io.Reader, payloadHash string, headers http.Header) (*http.Response, error) {
	u, e := endpoint(p)
	if e != nil {
		return nil, e
	}
	escapedBucket := encodeSeg(p.Bucket)
	if p.PathStyle {
		appendURLPath(u, escapedBucket)
	} else {
		u.Host = escapedBucket + "." + u.Host
	}
	if key != "" {
		appendURLPath(u, encodeKey(key))
	}
	if payloadHash == "" {
		payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	}
	req, e := http.NewRequestWithContext(ctx, method, u.String(), body)
	if e != nil {
		return nil, e
	}
	if headers != nil {
		req.Header = headers.Clone()
	}
	if f, ok := body.(*os.File); ok {
		if st, se := f.Stat(); se == nil {
			req.ContentLength = st.Size()
		}
	}
	sign(req, p.Region, p.AccessKeyID, secret, payloadHash, s.now().UTC())
	resp, e := s.client.Do(req)
	if e != nil {
		return nil, e
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, &statusError{resp.StatusCode, string(b)}
	}
	return resp, nil
}
func sign(req *http.Request, region, access, secret, payload string, t time.Time) {
	date := t.Format("20060102")
	stamp := t.Format("20060102T150405Z")
	req.Header.Set("x-amz-date", stamp)
	req.Header.Set("x-amz-content-sha256", payload)
	req.Header.Set("Host", req.URL.Host)
	canonHeaders := map[string]string{"host": req.URL.Host, "x-amz-content-sha256": payload, "x-amz-date": stamp}
	for k, v := range req.Header {
		lk := strings.ToLower(k)
		if lk == "content-type" || lk == "if-none-match" || lk == "range" || strings.HasPrefix(lk, "x-amz-") {
			canonHeaders[lk] = strings.Join(strings.Fields(strings.Join(v, ",")), " ")
		}
	}
	keys := make([]string, 0, len(canonHeaders))
	for k := range canonHeaders {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var ch, signed strings.Builder
	for _, k := range keys {
		ch.WriteString(k)
		ch.WriteByte(':')
		ch.WriteString(strings.TrimSpace(canonHeaders[k]))
		ch.WriteByte('\n')
		if signed.Len() > 0 {
			signed.WriteByte(';')
		}
		signed.WriteString(k)
	}
	uri := req.URL.EscapedPath()
	if uri == "" {
		uri = "/"
	}
	canonical := req.Method + "\n" + uri + "\n" + canonicalQuery(req.URL.Query()) + "\n" + ch.String() + "\n" + signed.String() + "\n" + payload
	sum := sha256.Sum256([]byte(canonical))
	scope := date + "/" + region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	kDate := hmacSum([]byte("AWS4"+secret), date)
	kRegion := hmacSum(kDate, region)
	kService := hmacSum(kRegion, "s3")
	kSigning := hmacSum(kService, "aws4_request")
	sig := hex.EncodeToString(hmacSum(kSigning, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+access+"/"+scope+", SignedHeaders="+signed.String()+", Signature="+sig)
}
func hmacSum(key []byte, v string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(v))
	return m.Sum(nil)
}
func canonicalQuery(q url.Values) string {
	pairs := []string{}
	for k, vs := range q {
		for _, v := range vs {
			pairs = append(pairs, encodeSeg(k)+"="+encodeSeg(v))
		}
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

type listXML struct {
	XMLName     xml.Name `xml:"ListBucketResult"`
	IsTruncated bool     `xml:"IsTruncated"`
	Next        string   `xml:"NextContinuationToken"`
	Contents    []struct {
		ETag         string `xml:"ETag"`
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
	} `xml:"Contents"`
}

func (s *Service) list(ctx context.Context, p profile, secret, prefix string, token *string, size int) (listResponse, error) {
	if size < 1 {
		size = 1
	}
	if size > 100 {
		size = 100
	}
	q := url.Values{"list-type": {"2"}, "prefix": {prefix}, "max-keys": {strconv.Itoa(size)}}
	if token != nil {
		q.Set("continuation-token", *token)
	}
	resp, e := s.doList(ctx, p, secret, q)
	if e != nil {
		return listResponse{}, s3error("s3ListFailed", e)
	}
	defer resp.Body.Close()
	var doc listXML
	if e = xml.NewDecoder(resp.Body).Decode(&doc); e != nil {
		return listResponse{}, appErr("s3ListFailed", e.Error())
	}
	out := listResponse{Objects: []galleryObject{}}
	for _, o := range doc.Contents {
		var lm *string
		if o.LastModified != "" {
			v := o.LastModified
			lm = &v
		}
		object := makeObject(p, o.Key, o.Size, lm)
		object.ETag = o.ETag
		out.Objects = append(out.Objects, object)
	}
	if doc.IsTruncated {
		if doc.Next == "" {
			return listResponse{}, appErr("s3PaginationFailed", "S3 response indicates more results but returned no continuation token.")
		}
		out.NextContinuationToken = &doc.Next
	}
	return out, nil
}
func (s *Service) doList(ctx context.Context, p profile, secret string, q url.Values) (*http.Response, error) {
	u, e := endpoint(p)
	if e != nil {
		return nil, e
	}
	bucket := encodeSeg(p.Bucket)
	if p.PathStyle {
		appendURLPath(u, bucket)
	} else {
		u.Host = bucket + "." + u.Host
	}
	u.RawQuery = canonicalQuery(q)
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		return nil, e
	}
	sign(req, p.Region, p.AccessKeyID, secret, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", s.now().UTC())
	resp, e := s.client.Do(req)
	if e != nil {
		return nil, e
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, &statusError{resp.StatusCode, string(b)}
	}
	return resp, nil
}
func requestContextError(err error) error {
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return context.DeadlineExceeded
	}
	return nil
}

func s3error(code string, err error) error {
	if cause := requestContextError(err); cause != nil {
		return cause
	}
	return appErr(code, safeR2ProbeError(err).Error())
}
func makeObject(p profile, key string, size int64, lm *string) galleryObject {
	o := galleryObject{Key: key, Size: size, LastModified: lm, IsImage: isImage(key)}
	if p.PublicBaseURL != nil {
		v := strings.TrimRight(*p.PublicBaseURL, "/") + "/" + encodeKey(strings.TrimLeft(key, "/"))
		o.PublicURL = &v
	}
	return o
}
func isImage(k string) bool {
	v := strings.ToLower(k)
	for _, e := range []string{".jpg", ".jpeg", ".png", ".webp", ".avif", ".jxl", ".heif", ".heic"} {
		if strings.HasSuffix(v, e) {
			return true
		}
	}
	return false
}

func slugify(v string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(v) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			dash = false
		} else {
			if b.Len() > 0 && !dash {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
func renderKey(template, name, ext, hash string, now time.Time) (string, error) {
	if !strings.Contains(template, "{ext}") {
		return "", appErr("invalidTemplate", "Naming template must include {ext}.")
	}
	stem := name
	if i := strings.LastIndex(stem, "."); i >= 0 {
		stem = stem[:i]
	}
	key := strings.NewReplacer("{yyyy}", now.Format("2006"), "{mm}", now.Format("01"), "{slug}", slugify(stem), "{hash}", hash[:8], "{ext}", strings.TrimLeft(ext, ".")).Replace(template)
	key = strings.ReplaceAll(key, "\\", "/")
	if e := validateKey(key); e != nil {
		return "", e
	}
	return key, nil
}
func hasPrefix(key, prefix string) bool {
	return prefix == "" || key == prefix || strings.HasPrefix(key, prefix+"/")
}
func appendSuffix(key, suffix string) (string, error) {
	if suffix == "" {
		return key, nil
	}
	for _, r := range suffix {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return "", appErr("invalidObjectKey", "Object key suffix must contain only ASCII letters, digits, or hyphens.")
		}
	}
	i := strings.LastIndex(key, "/")
	dir, file := key[:i+1], key[i+1:]
	dot := strings.LastIndex(file, ".")
	if dot > 0 && dot < len(file)-1 {
		file = file[:dot] + "-" + suffix + file[dot:]
	} else {
		file += "-" + suffix
	}
	out := dir + file
	return out, validateKey(out)
}
