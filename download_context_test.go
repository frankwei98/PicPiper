package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestDownloadBridgeRetainsContextErrorCodes(t *testing.T) {
	backend := newBackend(t.TempDir())
	defer backend.images.Close()
	backend.Call(context.Background(), "save_s3_secret", `{"profileId":"profile","secretAccessKey":"fake-secret"}`)
	payload, err := json.Marshal(map[string]any{
		"profile": map[string]any{
			"id": "profile", "name": "Profile", "endpoint": "https://s3.example.test",
			"region": "auto", "bucket": "images", "accessKeyId": "fake-access", "pathStyle": true,
		},
		"key": "photo.png", "outputDir": t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, timedOut := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		code := "cancelled"
		if timedOut {
			cancel()
			ctx, cancel = context.WithDeadline(context.Background(), time.Unix(0, 0))
			code = "timedOut"
		} else {
			cancel()
		}
		var response reply
		if err := json.Unmarshal([]byte(backend.Call(ctx, "download_gallery_object", string(payload))), &response); err != nil {
			t.Fatal(err)
		}
		cancel()
		if response.Error == nil || response.Error.Code != code {
			t.Fatalf("bridge error = %+v, want %s", response.Error, code)
		}
	}
}
