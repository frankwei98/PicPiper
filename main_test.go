package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/frankwei98/PicPiper/internal/imaging"
	"testing"
)

func TestMain(m *testing.M) {
	if imaging.RunWorker() {
		return
	}
	os.Exit(m.Run())
}

func TestLaunchFilesAreDeliveredOnceAcrossConcurrentSubscriptions(t *testing.T) {
	backend := newBackend(t.TempDir())
	backend.openedFiles = []string{"/photos/one.jpg", "/photos/two.png"}
	results := make(chan []string, 8)
	var subscribers sync.WaitGroup
	for range 8 {
		subscribers.Go(func() { results <- backend.TakeOpenedFiles() })
	}
	subscribers.Wait()
	close(results)
	seen := map[string]int{}
	for paths := range results {
		if paths == nil {
			t.Fatal("empty file lists must serialize as arrays")
		}
		for _, path := range paths {
			seen[path]++
		}
	}
	if len(seen) != 2 || seen["/photos/one.jpg"] != 1 || seen["/photos/two.png"] != 1 {
		t.Fatalf("launch files were lost or duplicated: %v", seen)
	}
	if !backend.imagesReady {
		t.Fatal("native events must be enabled after the frontend subscribes")
	}
}

func TestBridgePreservesBusinessErrorCodes(t *testing.T) {
	backend := newBackend(t.TempDir())
	for _, test := range []struct{ operation, payload, code string }{
		{"inspect_image", "{", "invalidRequest"},
		{"inspect_image", `{"path":"/missing/pic-piper-test-image.jpg"}`, "imageOpenFailed"},
	} {
		var result reply
		if err := json.Unmarshal([]byte(backend.Call(context.Background(), test.operation, test.payload)), &result); err != nil {
			t.Fatal(err)
		}
		if result.Data != nil || result.Error == nil || result.Error.Code != test.code || result.Error.Message == "" {
			t.Fatalf("unexpected bridge error: %+v", result)
		}
	}
}

func TestSmokeWindowDoesNotPersistLanguageInUserSession(t *testing.T) {
	if appWindowOptions(false).Page.Session != nil {
		t.Fatal("normal windows must retain the user's default session")
	}
	first := appWindowOptions(true).Page.Session
	if first == nil || !first.IsEphemeral() {
		t.Fatal("smoke language changes would persist in the user's WebView session")
	}
	if second := appWindowOptions(true).Page.Session; second == nil || second == first {
		t.Fatal("each smoke run must have its own disposable WebView session")
	}
}

func TestGalleryThumbnailUsesIsolatedDecoderAndPreservesTransparencyAndOrientation(t *testing.T) {
	var pngSource bytes.Buffer
	transparent := image.NewNRGBA(image.Rect(0, 0, 512, 128))
	transparent.SetNRGBA(256, 64, color.NRGBA{R: 255, A: 128})
	if err := png.Encode(&pngSource, transparent); err != nil {
		t.Fatal(err)
	}
	var jpegSource bytes.Buffer
	if err := jpeg.Encode(&jpegSource, image.NewRGBA(image.Rect(0, 0, 4, 2)), nil); err != nil {
		t.Fatal(err)
	}
	exif := []byte{'E', 'x', 'i', 'f', 0, 0, 'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0}
	oriented := append([]byte{0xff, 0xd8, 0xff, 0xe1, 0, byte(len(exif) + 2)}, exif...)
	oriented = append(oriented, jpegSource.Bytes()[2:]...)
	for _, tc := range []struct {
		name          string
		data          []byte
		width, height int
		alpha         bool
	}{
		{"transparent.png", pngSource.Bytes(), 384, 96, true},
		{"rotated.jpg", oriented, 2, 4, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path != "/photos/"+tc.name || r.Header.Get("Authorization") == "" {
					t.Error("thumbnail used public URL or unsigned request")
				}
				_, _ = w.Write(tc.data)
			}))
			defer server.Close()
			dir := t.TempDir()
			backend := newBackend(dir)
			defer backend.images.Close()
			profile := map[string]any{"id": "a", "name": "test", "endpoint": server.URL, "region": "auto", "bucket": "photos", "accessKeyId": "fake", "pathStyle": true, "publicBaseUrl": server.URL + "/public"}
			backend.Call(context.Background(), "save_s3_secret", `{"profileId":"a","secretAccessKey":"fake-secret"}`)
			request, _ := json.Marshal(map[string]any{"profile": profile, "key": tc.name, "size": len(tc.data), "etag": "fake-v1"})
			var response struct {
				Data struct {
					DataURL string `json:"dataUrl"`
				} `json:"data"`
				Error any `json:"error"`
			}
			if err := json.Unmarshal([]byte(backend.Call(context.Background(), "read_gallery_thumbnail", string(request))), &response); err != nil || response.Error != nil {
				t.Fatalf("thumbnail failed: %v %+v", err, response)
			}
			parts := strings.SplitN(response.Data.DataURL, ",", 2)
			if len(parts) != 2 {
				t.Fatal("missing thumbnail data")
			}
			data, err := base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				t.Fatal(err)
			}
			img, _, err := image.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if img.Bounds().Dx() != tc.width || img.Bounds().Dy() != tc.height {
				t.Fatalf("wrong thumbnail dimensions: %v", img.Bounds())
			}
			if tc.alpha {
				_, _, _, a := img.At(0, 0).RGBA()
				if a != 0 {
					t.Fatal("thumbnail lost transparency")
				}
			}
			restarted := newBackend(dir)
			defer restarted.images.Close()
			if value := restarted.Call(context.Background(), "read_gallery_thumbnail", string(request)); !strings.Contains(value, response.Data.DataURL) {
				t.Fatal("restart did not return persisted thumbnail")
			}
			if requests.Load() != 1 {
				t.Fatal("cached thumbnail downloaded full image again")
			}
		})
	}
}

func TestCloudflareReturnLinksOnlyRestoreTheExpectedAppRoute(t *testing.T) {
	for _, raw := range []string{"https://oauth/cloudflare/connected", "picpiper://oauth/other", "picpiper://oauth/cloudflare/connected?token=fake", "picpiper://user@oauth/cloudflare/connected", "picpiper://oauth/cloudflare/connected#fragment"} {
		if isCloudflareReturnURL(raw) {
			t.Fatalf("unexpected app route accepted: %s", raw)
		}
	}
	if !isCloudflareReturnURL("picpiper://oauth/cloudflare/connected") {
		t.Fatal("valid return link rejected")
	}
	var config struct {
		URLSchemes []string `json:"urlSchemes"`
	}
	data, err := os.ReadFile("mygo.json")
	if err != nil || json.Unmarshal(data, &config) != nil || len(config.URLSchemes) != 1 || config.URLSchemes[0] != "picpiper" {
		t.Fatal("packaging does not register the return scheme")
	}
}
