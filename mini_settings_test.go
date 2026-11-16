package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/frankwei98/PicPiper/internal/cloud"
)

func TestMiniCompressionBridgePreservesLatestFields(t *testing.T) {
	backend := newBackend(t.TempDir())
	defer backend.images.Close()
	raw := backend.Call(context.Background(), "save_app_settings", `{"settings":{"profiles":[],"namingTemplate":"{hash}.{ext}","mini":{"enabled":true,"targetFormat":"avif","quality":90,"action":"clipboard","profileId":"kept-profile","linkFormat":"markdown"}}}`)
	var saved struct {
		Error *apperror.Error `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &saved); err != nil || saved.Error != nil {
		t.Fatalf("seed settings: %s %v", raw, err)
	}
	raw = backend.Call(context.Background(), "save_mini_compression_settings", `{"settings":{"quality":85}}`)
	var response struct {
		Data  cloud.MiniSettings `json:"data"`
		Error *apperror.Error    `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != nil || response.Data.TargetFormat != "avif" || response.Data.Quality != 85 || !response.Data.Enabled || response.Data.ProfileID != "kept-profile" || response.Data.LinkFormat != "markdown" {
		t.Fatalf("unexpected merged bridge response: %+v", response)
	}
	raw = backend.Call(context.Background(), "save_mini_compression_settings", `{"settings":{"quality":0}}`)
	if err := json.Unmarshal([]byte(raw), &response); err != nil || response.Error == nil || response.Error.Code != "invalidMiniSettings" {
		t.Fatalf("invalid patch accepted: %s %v", raw, err)
	}
}
