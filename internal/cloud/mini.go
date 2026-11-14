package cloud

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

// MiniSettings are independent of the full workbench's per-image controls.
type MiniSettings struct {
	Enabled      bool   `json:"enabled"`
	TargetFormat string `json:"targetFormat"`
	Quality      int    `json:"quality"`
	Action       string `json:"action"` // Legacy preference; persisted settings always copy images.
	ProfileID    string `json:"profileId"`
	LinkFormat   string `json:"linkFormat"`
}

func DefaultMiniSettings() MiniSettings {
	return MiniSettings{TargetFormat: "webp", Quality: 90, Action: "clipboard", LinkFormat: "url"}
}

func clipboardMiniSettings(previous *MiniSettings) *MiniSettings {
	cfg := DefaultMiniSettings()
	if previous != nil {
		cfg = *previous
	}
	cfg.Action = "clipboard"
	return &cfg
}

func validateMini(v MiniSettings, profiles []profile) error {
	switch v.TargetFormat {
	case "webp", "jpg", "png", "avif", "jxl":
	default:
		return appErr("invalidMiniSettings", "Choose a supported Mini output format.")
	}
	if v.Quality < 1 || v.Quality > 100 {
		return appErr("invalidMiniSettings", "Mini quality must be between 1 and 100.")
	}
	if v.Action != "clipboard" && v.Action != "upload" {
		return appErr("invalidMiniSettings", "Choose a Mini completion action.")
	}
	switch v.LinkFormat {
	case "url", "html", "bbcode", "markdown":
	default:
		return appErr("invalidMiniSettings", "Choose a supported link format.")
	}
	if v.Enabled && v.Action == "upload" {
		for _, p := range profiles {
			if p.ID == v.ProfileID && p.PublicBaseURL != nil && strings.TrimSpace(*p.PublicBaseURL) != "" {
				return validateProfile(p)
			}
		}
		return appErr("invalidMiniSettings", "Mini requires an S3 profile with a Public Base URL.")
	}
	return nil
}

// MiniPlan captures the destination and naming settings when work is queued.
type MiniPlan struct {
	Settings    MiniSettings
	destination profile
	template    string
}

func (s *Service) MiniPlan() (MiniPlan, error) {
	v, err := s.loadSettings()
	if err != nil {
		return MiniPlan{}, err
	}
	cfg := DefaultMiniSettings()
	if v.Mini != nil {
		cfg = *v.Mini
	}
	if err = validateMini(cfg, v.Profiles); err != nil {
		return MiniPlan{}, err
	}
	plan := MiniPlan{Settings: cfg, template: v.NamingTemplate}
	for _, p := range v.Profiles {
		if p.ID == cfg.ProfileID {
			plan.destination = p
			break
		}
	}
	return plan, nil
}

// MiniUploadPlan captures a manual upload destination without changing the
// automatic completion action or recompressing an existing result.
func (s *Service) MiniUploadPlan(profileID, linkFormat string) (MiniPlan, error) {
	v, err := s.loadSettings()
	if err != nil {
		return MiniPlan{}, err
	}
	cfg := DefaultMiniSettings()
	if v.Mini != nil {
		cfg = *v.Mini
	}
	if !cfg.Enabled {
		return MiniPlan{}, appErr("miniDisabled", "Enable Mini in Settings before uploading images.")
	}
	cfg.Action, cfg.ProfileID, cfg.LinkFormat = "upload", profileID, linkFormat
	if err = validateMini(cfg, v.Profiles); err != nil {
		return MiniPlan{}, err
	}
	for _, p := range v.Profiles {
		if p.ID == profileID {
			return MiniPlan{Settings: cfg, destination: p, template: v.NamingTemplate}, nil
		}
	}
	return MiniPlan{}, appErr("invalidMiniSettings", "Mini requires an S3 profile with a Public Base URL.")
}

// BucketKey identifies storage independently of profile aliases, credentials,
// naming templates and prefixes. Those settings must not cause a second PUT
// for an image that already exists in the selected bucket.
func (p MiniPlan) BucketKey() string {
	u, _ := url.Parse(p.destination.Endpoint)
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Path = strings.TrimRight(u.Path, "/")
	return fmt.Sprintf("%x", sha256.Sum256([]byte(u.String()+"\x00"+p.destination.Bucket)))
}

type MiniUploadTarget struct {
	ProfileID string `json:"profileId"`
	Name      string `json:"name"`
	Bucket    string `json:"bucket"`
	BucketKey string `json:"bucketKey"`
}

// MiniUploadTargets exposes only the public fields needed by the upload sheet.
func (s *Service) MiniUploadTargets() ([]MiniUploadTarget, error) {
	v, err := s.loadSettings()
	if err != nil {
		return nil, err
	}
	targets := []MiniUploadTarget{}
	for _, p := range v.Profiles {
		if p.PublicBaseURL == nil || strings.TrimSpace(*p.PublicBaseURL) == "" || validateProfile(p) != nil {
			continue
		}
		plan := MiniPlan{destination: p}
		targets = append(targets, MiniUploadTarget{ProfileID: p.ID, Name: p.Name, Bucket: p.Bucket, BucketKey: plan.BucketKey()})
	}
	return targets, nil
}

// SaveMiniSettings merges only Mini fields into the latest settings under lock.
func (s *Service) SaveMiniSettings(cfg MiniSettings) error {
	cfg.Action = "clipboard"
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.loadSettingsLocked()
	if err != nil {
		return err
	}
	if err = validateMini(cfg, v.Profiles); err != nil {
		return err
	}
	v.Mini = &cfg
	return s.saveSettingsLocked(v)
}

func (s *Service) UploadMini(ctx context.Context, plan MiniPlan, path, name string) (string, error) {
	plan.Settings.Action = "upload"
	// An older cached result can differ from the current compression preference.
	plan.Settings.TargetFormat = strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	if err := validateMini(plan.Settings, []profile{plan.destination}); err != nil {
		return "", err
	}
	if plan.destination.PublicBaseURL == nil {
		return "", appErr("invalidMiniSettings", "Mini requires a Public Base URL.")
	}
	call := func(op string, p any) (any, error) {
		raw, err := json.Marshal(p)
		if err != nil {
			return nil, err
		}
		return s.Call(ctx, op, raw)
	}
	named, err := call("generate_object_key", map[string]any{"sourcePath": path, "outputFileName": name, "prefix": plan.destination.DefaultPrefix, "namingTemplate": plan.template, "ext": plan.Settings.TargetFormat})
	if err != nil {
		return "", err
	}
	raw, _ := json.Marshal(named)
	var key struct {
		ObjectKey string `json:"objectKey"`
	}
	if err = json.Unmarshal(raw, &key); err != nil {
		return "", err
	}
	for attempt := 0; attempt < 2; attempt++ {
		_, err = call("upload_gallery_object", map[string]any{"profile": plan.destination, "sourcePath": path, "objectKey": key.ObjectKey, "outputFilename": name, "contentType": miniContentType(plan.Settings.TargetFormat)})
		if err == nil {
			break
		}
		var business *apperror.Error
		if attempt != 0 || !errors.As(err, &business) || (business.Code != "objectAlreadyExists" && business.Code != "s3UploadConflictRetryable") {
			return "", err
		}
		// The key suffix validator permits hex, but not base64url underscores.
		var random [6]byte
		if _, err = rand.Read(random[:]); err != nil {
			return "", err
		}
		key.ObjectKey, err = appendSuffix(key.ObjectKey, "mini-"+hex.EncodeToString(random[:]))
		if err != nil {
			return "", err
		}
	}
	base, err := url.Parse(strings.TrimRight(*plan.destination.PublicBaseURL, "/") + "/")
	if err != nil {
		return "", err
	}
	// Preserve escaped object-key segments and the public base path.
	parts := strings.Split(key.ObjectKey, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return base.String() + strings.Join(parts, "/"), nil
}

func miniContentType(format string) string {
	if format == "jpg" {
		return "image/jpeg"
	}
	return "image/" + format
}
