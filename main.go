package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
	"github.com/frankwei98/PicPiper/internal/mini"
	"github.com/frankwei98/PicPiper/internal/nativelocale"
)

var ImagesOpened = mygo.NewEvent[[]string]("images-opened")
var SettingsChanged = mygo.NewEvent[bool]("settings-changed")

type Backend struct {
	mini        *mini.Service
	updates     *updateController
	desktop     *desktopController
	images      *imaging.Service
	cloud       *cloud.Service
	settingsMu  sync.Mutex
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
	backend := &Backend{images: images, cloud: cloud.NewWithThumbnails(dataDir, func(ctx context.Context, path string) (string, error) {
		return images.ThumbnailDataURL(ctx, path, 384)
	})}
	if configured, err := backend.cloud.ProcessingConcurrency(); err == nil {
		images.SetConcurrency(configured)
	}
	return backend
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
	if b.updates != nil && !strings.HasPrefix(operation, "update_") {
		var done func()
		done, err = b.updates.begin()
		if err == nil {
			defer done()
		}
	}
	if err != nil {
		// The quit sequence already owns the app's resources.
	} else if !json.Valid([]byte(payload)) {
		err = apperror.New("invalidRequest", "This request is not valid JSON.")
	} else {
		switch operation {
		case "save_app_settings":
			b.settingsMu.Lock()
			value, err = b.cloud.Call(ctx, operation, json.RawMessage(payload))
			if err == nil {
				var configured int
				configured, err = b.cloud.ProcessingConcurrency()
				if err == nil {
					b.images.SetConcurrency(configured)
				}
			}
			b.settingsMu.Unlock()
		case "image_processing_limits":
			value = b.images.ProcessingLimits()
		case "update_state", "update_check", "update_preferences", "update_locale", "update_activity":
			if b.updates == nil {
				err = apperror.New("updatesDisabled", "Updates are unavailable in this build.")
			} else {
				value, err = b.updates.call(operation, []byte(payload))
			}
		case "mini_state":
			value = b.mini.Snapshot()
		case "mini_upload_targets":
			value, err = b.cloud.MiniUploadTargets()
		case "mini_clear":
			b.mini.Clear()
			value = b.mini.Snapshot()
		case "mini_restore":
			b.mini.Restore()
			value = b.mini.Snapshot()
		case "mini_add":
			var req struct {
				Paths []string `json:"paths"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				err = b.mini.Add(req.Paths)
			}
			value = b.mini.Snapshot()
		case "mini_upload":
			var req struct {
				IDs        []string `json:"ids"`
				ProfileID  string   `json:"profileId"`
				LinkFormat string   `json:"linkFormat"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				err = b.mini.Upload(req.IDs, req.ProfileID, req.LinkFormat)
			}
			value = b.mini.Snapshot()
		case "copy_compressed_images":
			var req struct {
				OutputPaths []string `json:"outputPaths"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				var paths []string
				paths, err = b.images.OutputPaths(req.OutputPaths)
				if err == nil && len(paths) == 0 {
					err = apperror.New("invalidRequest", "Choose at least one compressed image.")
				}
				if err == nil {
					if len(paths) == 1 {
						var png []byte
						png, err = b.images.ClipboardPNG(ctx, paths[0])
						if err == nil {
							err = mygo.Clipboard.WriteImage(png)
						}
					} else {
						err = mygo.Clipboard.WriteFiles(paths...)
					}
				}
			}
		case "mini_export":
			var req struct {
				IDs       []string `json:"ids"`
				TargetDir string   `json:"targetDir"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				value, err = b.mini.Export(ctx, req.IDs, req.TargetDir)
			}
		case "mini_copy_image":
			var req struct {
				ID string `json:"id"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				err = b.mini.CopyImage(req.ID)
			}
		case "mini_copy":
			var req struct {
				ID         string `json:"id"`
				LinkFormat string `json:"linkFormat"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				err = b.mini.Copy(req.ID, req.LinkFormat)
			}
		case "mini_copy_all":
			var req struct {
				LinkFormat string `json:"linkFormat"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				err = b.mini.CopyAll(req.LinkFormat)
			}
		case "save_mini_settings":
			var req struct {
				Settings cloud.MiniSettings `json:"settings"`
			}
			if err = json.Unmarshal([]byte(payload), &req); err == nil {
				err = b.cloud.SaveMiniSettings(req.Settings)
			}
		case "inspect_image", "create_optimizer_run", "compress_image", "copy_outputs_to_dir", "read_thumbnail", "read_comparison_image", "cancel_image_task":
			value, err = b.images.Call(ctx, operation, json.RawMessage(payload))
		default:
			value, err = b.cloud.Call(ctx, operation, json.RawMessage(payload))
		}
		if err == nil && (operation == "save_app_settings" || operation == "save_mini_settings") && b.desktop != nil {
			mygo.RunOnMain(b.desktop.refresh)
			SettingsChanged.Broadcast(true)
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
	if runUpdateSmokeMode() {
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
	backend.mini = mini.New(backend.images, backend.cloud, mygo.Clipboard.WriteImage, func(text string) error { mygo.Clipboard.WriteText(text); return nil })
	backend.desktop = &desktopController{backend: backend}
	backend.setupUpdates(smokeDir != "")
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { backend.desktop.removeTray(); backend.mini.Stop(); backend.images.Close() })
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
		options := appWindowOptions(smokeDir != "")
		win := mygo.NewWindow(options)
		backend.desktop.page = options.Page
		window = win
		backend.desktop.main = win
		backend.desktop.refresh()
		win.OnClose(backend.desktop.closeMain)
		if smokeDir != "" {
			var start sync.Once
			win.Page().OnDOMReady(func() { start.Do(func() { go runSmoke(win, smokeDir, backend) }) })
		}
	})
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
		if !backend.updates.prepareQuit(backend.mini.Snapshot().Busy, e.SessionEnding) {
			e.PreventDefault()
			backend.desktop.openMain()
			UpdatesChanged.Broadcast(true)
			_, _ = mygo.Dialog.Message(mygo.MessageOptions{Parent: backend.desktop.main, Title: "Pic Piper", Message: nativelocale.UpdateRestartDeferred()})
			return
		}
		backend.desktop.quitting = true
	})
	mygo.App.OnQuitCanceled(func() {
		backend.desktop.quitting = false
		backend.updates.mu.Lock()
		backend.updates.closing = false
		backend.updates.mu.Unlock()
	})
	mygo.App.OnActivate(func(visible bool) {
		if !visible && window != nil {
			backend.desktop.openMain()
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func (b *Backend) MiniWindow(action string) {
	if b.desktop == nil {
		return
	}
	mygo.RunOnMain(func() {
		switch action {
		case "close":
			b.desktop.closePanel()
		case "main":
			b.desktop.openMain()
		case "open":
			b.desktop.showPanel()
		}
	})
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
