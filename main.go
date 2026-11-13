package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

var ImagesOpened = mygo.NewEvent[[]string]("images-opened")

type Backend struct {
	images      *imaging.Service
	cloud       *cloud.Service
	openMu      sync.Mutex
	openedFiles []string
	imagesReady bool
}

// TakeOpenedFiles hands launch-time files to the frontend after it subscribes.
func (b *Backend) TakeOpenedFiles() []string {
	b.openMu.Lock()
	defer b.openMu.Unlock()
	b.imagesReady = true
	paths := b.openedFiles
	b.openedFiles = nil
	if paths == nil {
		return []string{}
	}
	return paths
}

func newBackend(dataDir string) *Backend {
	images := imaging.NewIsolated(dataDir)
	return &Backend{images: images, cloud: cloud.NewWithThumbnails(dataDir, func(ctx context.Context, path string) (string, error) {
		return images.ThumbnailDataURL(ctx, path, 384)
	})}
}

type reply struct {
	Data  any             `json:"data"`
	Error *apperror.Error `json:"error,omitempty"`
}

// Call keeps business failures structured without relying on a framework's
// serialization of custom Go errors. Only these explicitly routed operations run.
func (b *Backend) Call(ctx context.Context, operation, payload string) string {
	var value any
	var err error
	if !json.Valid([]byte(payload)) {
		err = apperror.New("invalidRequest", "This request is not valid JSON.")
	} else {
		switch operation {
		case "inspect_image", "create_optimizer_run", "compress_image", "copy_outputs_to_dir", "read_thumbnail", "read_comparison_image", "cancel_image_task":
			value, err = b.images.Call(ctx, operation, json.RawMessage(payload))
		default:
			value, err = b.cloud.Call(ctx, operation, json.RawMessage(payload))
		}
	}
	response := reply{Data: value}
	if err != nil {
		response.Data = nil
		var appErr *apperror.Error
		switch {
		case errors.As(err, &appErr):
			response.Error = appErr
		case errors.Is(err, context.Canceled):
			response.Error = apperror.New("cancelled", "The operation was cancelled.")
		case errors.Is(err, context.DeadlineExceeded):
			response.Error = apperror.New("timedOut", "The request timed out. Check your connection and try again.")
		default:
			response.Error = apperror.New("operationFailed", "The operation could not be completed. Check file permissions, disk space, and connection settings.")
		}
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return `{"data":null,"error":{"code":"responseFailed","message":"The operation returned an unreadable response."}}`
	}
	return string(encoded)
}

type dialogOptions struct {
	Multiple  bool `json:"multiple"`
	Directory bool `json:"directory"`
	Filters   []struct {
		Name       string   `json:"name"`
		Extensions []string `json:"extensions"`
	} `json:"filters"`
}

func (b *Backend) Open(ctx context.Context, encoded string) ([]string, error) {
	var options dialogOptions
	if err := json.Unmarshal([]byte(encoded), &options); err != nil {
		return nil, errors.New("Could not read the file picker options.")
	}
	filters := make([]mygo.FileFilter, 0, len(options.Filters))
	for _, filter := range options.Filters {
		filters = append(filters, mygo.FileFilter{Name: filter.Name, Extensions: filter.Extensions})
	}
	return mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent: mygo.CallerWindow(ctx), Multiple: options.Multiple, Directory: options.Directory,
		Filters: filters, CreateDirectories: options.Directory,
	})
}

func (b *Backend) OpenUrl(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
		return errors.New("Choose a valid HTTP or HTTPS URL without embedded credentials.")
	}
	return mygo.Shell.OpenExternal(raw)
}

func (b *Backend) WriteClipboard(text string) {
	mygo.Clipboard.WriteText(text)
}

func main() {
	if imaging.RunWorker() {
		return
	}
	dataDir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Fatal("Could not locate the app's private data folder.")
	}
	var smokeDir string
	if len(os.Args) == 3 && os.Args[1] == "--smoke-test" {
		smokeDir, err = filepath.Abs(os.Args[2])
		if err != nil {
			log.Fatal(err)
		}
		dataDir = filepath.Join(smokeDir, "data")
	}
	backend := newBackend(dataDir)
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { backend.images.Close() })
	mygo.Bind(backend)
	var window *mygo.Window
	mygo.App.OnOpenURL(func(raw string) {
		if !isCloudflareReturnURL(raw) || window == nil {
			return
		}
		window.Restore()
		window.Show()
		window.Focus()
		mygo.App.Focus()
	})
	mygo.App.OnOpenFile(func(path string) {
		if smokeDir != "" {
			return
		}
		backend.openMu.Lock()
		if !backend.imagesReady {
			backend.openedFiles = append(backend.openedFiles, path)
			backend.openMu.Unlock()
			return
		}
		backend.openMu.Unlock()
		_ = ImagesOpened.Emit(window, []string{path})
	})
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(appWindowOptions(smokeDir != ""))
		window = win
		if smokeDir != "" {
			var start sync.Once
			win.Page().OnDOMReady(func() { start.Do(func() { go runSmoke(win, smokeDir) }) })
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func appWindowOptions(smoke bool) mygo.WindowOptions {
	var page mygo.PageOptions
	if smoke {
		// Backend fixtures alone do not isolate WebView localStorage or cookies.
		page.Session = mygo.NewEphemeralSession()
	}
	return mygo.WindowOptions{
		Page:  page,
		Title: "Pic Piper", URL: "/", Width: 1120, Height: 760,
		MinWidth: 920, MinHeight: 600, TitleBarStyle: mygo.TitleBarHidden,
		TrafficLightPosition: &mygo.Point{X: 16, Y: 18}, BackgroundColor: "#f2f2f5",
	}
}

// The scheme restores the existing window only. OAuth still finishes through
// the state- and PKCE-validated loopback callback; deep links grant no access.
func isCloudflareReturnURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "picpiper" && u.Host == "oauth" && u.Path == "/cloudflare/connected" && u.RawQuery == "" && u.Fragment == "" && u.User == nil
}
