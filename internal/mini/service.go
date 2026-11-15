// Package mini owns drop-time settings and bounded background work independently
// of the short-lived tray WebView. Closing a panel never cancels these jobs.
package mini

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"maps"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

type imageCaller interface {
	Call(context.Context, string, json.RawMessage) (any, error)
}
type Item struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Status        string            `json:"status"`
	OutputName    string            `json:"outputName"`
	OriginalBytes int64             `json:"originalBytes"`
	OutputBytes   int64             `json:"outputBytes"`
	Thumbnail     string            `json:"thumbnail"`
	URL           string            `json:"url"`
	Links         map[string]string `json:"links,omitempty"`
	Error         string            `json:"error"`
	Warning       string            `json:"warning"`
	UploadStatus  string            `json:"uploadStatus,omitempty"`
	UploadError   string            `json:"uploadError,omitempty"`
	Uploads       map[string]string `json:"uploads,omitempty"`
	LinkFormat    string            `json:"linkFormat,omitempty"`
	CompletedAt   time.Time         `json:"completedAt"`
	hidden        bool
	pending       bool
	outputPath    string
}
type State struct {
	Items        []Item `json:"items"`
	Busy         bool   `json:"busy"`
	Copied       string `json:"copied"`
	Error        string `json:"error"`
	CanUndoClear bool   `json:"canUndoClear"`
	CopySequence uint64 `json:"copySequence"`
}
type batch struct {
	ids        []string
	paths      []string
	plan       cloud.MiniPlan
	uploadOnly bool
}
type Service struct {
	images            imageCaller
	cloud             *cloud.Service
	copyImage         func([]byte) error
	copyText          func(string) error
	ctx               context.Context
	cancel            context.CancelFunc
	done              chan struct{}
	queue             chan batch
	mu                sync.Mutex
	items             []Item
	copied, lastError string
	seq               uint64
	working           bool
	now               func() time.Time
	lastHidden        map[string]bool
	copySequence      uint64
}

const resultLifetime = 12 * time.Hour

func New(images imageCaller, storage *cloud.Service, copyImage func([]byte) error, copyText func(string) error) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{images: images, cloud: storage, copyImage: copyImage, copyText: copyText, ctx: ctx, cancel: cancel, done: make(chan struct{}), queue: make(chan batch, 32), items: []Item{}, now: time.Now}
	go s.work()
	return s
}
func (s *Service) Close() { s.cancel(); <-s.done }

// Stop is nonblocking because native quit handlers run on the UI thread.
func (s *Service) Stop()            { s.cancel() }
func (s *Service) Report(err error) { s.mu.Lock(); s.lastError = safeError(err); s.mu.Unlock() }
func (s *Service) Snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	v := State{Items: []Item{}, Copied: s.copied, Error: s.lastError, Busy: s.working, CopySequence: s.copySequence}
	for _, i := range s.items {
		if activeItem(i) {
			v.Busy = true
		}
		if !i.hidden {
			v.Items = append(v.Items, cloneItem(i))
		} else if s.lastHidden[i.ID] {
			v.CanUndoClear = true
		}
	}
	return v
}

func cloneItem(i Item) Item {
	i.Links = maps.Clone(i.Links)
	i.Uploads = maps.Clone(i.Uploads)
	return i
}

func (s *Service) pruneLocked() {
	current := s.now()
	kept := s.items[:0]
	for _, i := range s.items {
		if !activeItem(i) && !i.CompletedAt.IsZero() && current.Sub(i.CompletedAt) >= resultLifetime {
			continue
		}
		kept = append(kept, i)
	}
	clear(s.items[len(kept):])
	s.items = kept
}

// Clear only hides Drawer records. Cached files, queued work and the S3 gallery
// stay owned by their existing services and are never deleted here.
func (s *Service) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	s.lastHidden = map[string]bool{}
	for n := range s.items {
		if !s.items[n].hidden {
			s.items[n].hidden = true
			s.lastHidden[s.items[n].ID] = true
		}
	}
	s.copied, s.lastError = "", ""
}

func (s *Service) Restore() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	for n := range s.items {
		if s.lastHidden[s.items[n].ID] {
			s.items[n].hidden = false
		}
	}
	s.lastHidden = nil
}
func (s *Service) Add(paths []string) error {
	if len(paths) == 0 || len(paths) > 20 {
		return apperror.New("invalidMiniDrop", "Drop between 1 and 20 images at a time.")
	}
	plan, err := s.cloud.MiniPlan()
	if err != nil {
		return err
	}
	if !plan.Settings.Enabled {
		return apperror.New("miniDisabled", "Enable Mini in Settings before dropping images.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	s.pruneLocked()
	active := 0
	for _, i := range s.items {
		if activeItem(i) {
			active++
		}
	}
	if active+len(paths) > 32 {
		return apperror.New("miniQueueFull", "Mini is busy. Wait for the current images to finish.")
	}
	// Active work is bounded independently of the twelve-hour result history.
	b := batch{paths: append([]string{}, paths...), plan: plan}
	for _, path := range paths {
		s.seq++
		id := fmt.Sprintf("mini-%d", s.seq)
		b.ids = append(b.ids, id)
		s.items = append(s.items, Item{ID: id, Name: filepath.Base(path), Status: "queued", pending: true})
	}
	s.copied = ""
	s.lastError = ""
	s.queue <- b
	return nil
}
func activeItem(i Item) bool {
	return i.pending || i.Status == "queued" || i.Status == "compressing" || i.Status == "uploading" || i.UploadStatus == "queued" || i.UploadStatus == "uploading"
}

// Upload queues cached outputs, independently of the drop-time completion action.
// Validate the entire selection before changing any item so invalid requests
// cannot leave a partially queued batch behind.
func (s *Service) Upload(ids []string, profileID, format string) error {
	if len(ids) == 0 {
		return apperror.New("invalidMiniUpload", "Choose compressed images to upload.")
	}
	plan, err := s.cloud.MiniUploadPlan(profileID, format)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	s.pruneLocked()
	if len(ids) > len(s.items) {
		return apperror.New("miniItemMissing", "This Mini result is no longer available.")
	}
	indices := make([]int, 0, len(ids))
	seen := map[string]bool{}
	positions := make(map[string]int, len(s.items))
	for n, i := range s.items {
		positions[i.ID] = n
	}
	for _, id := range ids {
		if seen[id] {
			return apperror.New("invalidMiniUpload", "Choose each image only once.")
		}
		seen[id] = true
		found, ok := positions[id]
		if !ok {
			return apperror.New("miniItemMissing", "This Mini result is no longer available.")
		}
		i := s.items[found]
		if i.hidden || i.Status != "completed" || i.outputPath == "" || activeItem(i) {
			return apperror.New("miniNotReady", "Wait for this image to finish before uploading.")
		}
		indices = append(indices, found)
	}
	// A history can contain more than 32 completed results. Bound queued batches
	// without blocking while holding the mutex needed by the worker.
	if len(s.queue) == cap(s.queue) {
		return apperror.New("miniQueueFull", "Mini is busy. Wait for the current images to finish.")
	}
	for _, n := range indices {
		s.items[n].pending = true
		s.items[n].UploadStatus = "queued"
		s.items[n].UploadError = ""
	}
	s.copied, s.lastError = "", ""
	s.queue <- batch{ids: append([]string{}, ids...), plan: plan, uploadOnly: true}
	return nil
}

// Export copies completed Mini results from the private optimizer cache into a
// user-selected directory. The private paths never leave this service.
func (s *Service) Export(ctx context.Context, ids []string, targetDir string) ([]string, error) {
	if len(ids) == 0 {
		return nil, apperror.New("invalidMiniExport", "Choose compressed images to save.")
	}
	if strings.TrimSpace(targetDir) == "" {
		return nil, apperror.New("invalidTargetDir", "Choose an output folder.")
	}
	s.mu.Lock()
	s.pruneLocked()
	positions := make(map[string]Item, len(s.items))
	for _, item := range s.items {
		positions[item.ID] = item
	}
	paths := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		item, ok := positions[id]
		if seen[id] {
			s.mu.Unlock()
			return nil, apperror.New("invalidMiniExport", "Choose each image only once.")
		}
		seen[id] = true
		if !ok {
			s.mu.Unlock()
			return nil, apperror.New("miniItemMissing", "This Mini result is no longer available.")
		}
		if item.hidden || item.Status != "completed" || item.outputPath == "" || activeItem(item) {
			s.mu.Unlock()
			return nil, apperror.New("miniNotReady", "Wait for this image to finish before saving it.")
		}
		paths = append(paths, item.outputPath)
	}
	s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var copied []string
	if err := s.imageCallContext(ctx, "copy_outputs_to_dir", map[string]any{"outputPaths": paths, "targetDir": targetDir}, &copied); err != nil {
		return nil, err
	}
	return copied, nil
}

func (s *Service) update(id string, fn func(*Item)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for n := range s.items {
		if s.items[n].ID == id {
			fn(&s.items[n])
			return
		}
	}
}
func (s *Service) work() {
	defer close(s.done)
	for {
		select {
		case <-s.ctx.Done():
			return
		case b := <-s.queue:
			s.mu.Lock()
			s.working = true
			s.mu.Unlock()
			last := ""
			links := []string{}
			for n, id := range b.ids {
				if s.ctx.Err() != nil {
					return
				}
				if !b.uploadOnly {
					if err := s.process(id, b.paths[n], b.plan); err != nil {
						s.update(id, func(i *Item) { i.Status = "failed"; i.Error = safeError(err); i.CompletedAt = s.now() })
						continue
					}
				}
				last = id
				if b.uploadOnly {
					if err := s.upload(id, b.plan); err != nil {
						s.update(id, func(i *Item) { i.UploadStatus = "failed"; i.UploadError = safeError(err) })
						continue
					}
					i, _ := s.item(id)
					links = append(links, FormatLink(i.URL, i.OutputName, b.plan.Settings.LinkFormat))
				}
			}
			var err error
			if len(links) > 0 {
				err = s.copyText(strings.Join(links, "\n"))
				if err == nil {
					s.setCopied("links")
				}
			} else if last != "" && !b.uploadOnly {
				err = s.CopyImage(last)
			}
			s.mu.Lock()
			if err != nil {
				s.lastError = safeError(err)
			}
			s.working = false
			for n := range s.items {
				for _, id := range b.ids {
					if s.items[n].ID == id {
						s.items[n].pending = false
						break
					}
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Service) upload(id string, plan cloud.MiniPlan) error {
	i, err := s.item(id)
	if err != nil {
		return err
	}
	key := plan.BucketKey()
	url := i.Uploads[key]
	if url == "" {
		s.update(id, func(i *Item) { i.UploadStatus = "uploading" })
		url, err = s.cloud.UploadMini(s.ctx, plan, i.outputPath, i.OutputName)
		if err != nil {
			return err
		}
	}
	links := map[string]string{}
	for _, format := range []string{"url", "html", "bbcode", "markdown"} {
		links[format] = FormatLink(url, i.OutputName, format)
	}
	s.update(id, func(i *Item) {
		i.URL = url
		i.Links = links
		if i.Uploads == nil {
			i.Uploads = map[string]string{}
		}
		i.Uploads[key] = url
		i.LinkFormat = plan.Settings.LinkFormat
		i.UploadStatus = "completed"
		i.UploadError = ""
	})
	return nil
}

func (s *Service) process(id, path string, plan cloud.MiniPlan) error {
	s.update(id, func(i *Item) { i.Status = "compressing" })
	var run struct {
		OutputDir string `json:"outputDir"`
	}
	if err := s.imageCall("create_optimizer_run", map[string]any{}, &run); err != nil {
		return err
	}
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)) + "." + plan.Settings.TargetFormat
	var result imaging.Result
	if err := s.imageCall("compress_image", map[string]any{"taskId": id, "sourcePath": path, "outputDir": run.OutputDir, "outputFileName": name, "settings": map[string]any{"targetFormat": plan.Settings.TargetFormat, "quality": plan.Settings.Quality, "animationMode": "preserve"}}, &result); err != nil {
		return err
	}
	thumb, _ := s.images.Call(s.ctx, "read_thumbnail", mustJSON(map[string]any{"path": result.OutputPath, "maxSize": 96}))
	var preview struct {
		DataURL string `json:"dataUrl"`
	}
	raw, _ := json.Marshal(thumb)
	_ = json.Unmarshal(raw, &preview)
	s.update(id, func(i *Item) {
		i.OutputName = result.OutputFileName
		i.outputPath = result.OutputPath
		i.OriginalBytes = result.OriginalBytes
		i.OutputBytes = result.OutputBytes
		i.Thumbnail = preview.DataURL
		i.Warning = strings.TrimSpace(strings.ReplaceAll(result.Warning, "Metadata, including GPS, was removed.", ""))
	})
	s.update(id, func(i *Item) { i.Status = "completed"; i.CompletedAt = s.now() })
	return nil
}
func (s *Service) imageCall(op string, req any, dst any) error {
	return s.imageCallContext(s.ctx, op, req, dst)
}
func (s *Service) imageCallContext(ctx context.Context, op string, req any, dst any) error {
	v, err := s.images.Call(ctx, op, mustJSON(req))
	if err != nil {
		return err
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}
func mustJSON(v any) json.RawMessage { raw, _ := json.Marshal(v); return raw }
func safeError(err error) string {
	var app *apperror.Error
	if errors.As(err, &app) {
		return app.Message
	}
	if errors.Is(err, context.Canceled) {
		return "Image processing was cancelled."
	}
	return "Mini could not finish this action. Check the image and your storage settings."
}
func (s *Service) item(id string) (Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, i := range s.items {
		if i.ID == id {
			return cloneItem(i), nil
		}
	}
	return Item{}, apperror.New("miniItemMissing", "This Mini result is no longer available.")
}
func (s *Service) setCopied(kind string) {
	s.mu.Lock()
	s.copied = kind
	s.copySequence++
	s.lastError = ""
	s.mu.Unlock()
}
func (s *Service) Copy(id, format string) error {
	i, err := s.item(id)
	if err != nil {
		return err
	}
	if i.Status != "completed" {
		return apperror.New("miniNotReady", "This image has not finished processing.")
	}
	if !ValidLinkFormat(format) {
		return apperror.New("invalidMiniSettings", "Choose a supported link format.")
	}
	if i.URL != "" {
		if err = s.copyText(FormatLink(i.URL, i.OutputName, format)); err == nil {
			s.setCopied("links")
		}
		return err
	}
	return s.CopyImage(id)
}

// CopyImage always copies pixels, including after the result has been uploaded.
func (s *Service) CopyImage(id string) error {
	i, err := s.item(id)
	if err != nil {
		return err
	}
	if i.Status != "completed" {
		return apperror.New("miniNotReady", "This image has not finished processing.")
	}
	var png struct {
		DataURL string `json:"dataUrl"`
	}
	if err = s.imageCall("read_comparison_image", map[string]any{"path": i.outputPath, "taskId": "copy-" + id}, &png); err != nil {
		return err
	}
	encoded, ok := strings.CutPrefix(png.DataURL, "data:image/png;base64,")
	if !ok {
		return apperror.New("clipboardFailed", "Could not prepare the clipboard image.")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	if err = s.copyImage(data); err == nil {
		s.setCopied("image")
	}
	return err
}

func (s *Service) CopyAll(format string) error {
	if !ValidLinkFormat(format) {
		return apperror.New("invalidMiniSettings", "Choose a supported link format.")
	}
	links := []string{}
	for _, i := range s.Snapshot().Items {
		if i.Status == "completed" && i.URL != "" {
			links = append(links, FormatLink(i.URL, i.OutputName, format))
		}
	}
	if len(links) == 0 {
		return apperror.New("miniNotReady", "No uploaded links are available yet.")
	}
	if err := s.copyText(strings.Join(links, "\n")); err != nil {
		return err
	}
	s.setCopied("links")
	return nil
}
func ValidLinkFormat(format string) bool {
	return format == "url" || format == "html" || format == "bbcode" || format == "markdown"
}
func FormatLink(url, name, format string) string {
	alt := strings.TrimSuffix(name, filepath.Ext(name))
	switch format {
	case "html":
		return `<img src="` + html.EscapeString(url) + `" alt="` + html.EscapeString(alt) + `">`
	case "bbcode":
		return "[img]" + strings.ReplaceAll(url, "]", "%5D") + "[/img]"
	case "markdown":
		alt = strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "\n", " ", "\r", " ").Replace(alt)
		return "![" + alt + "](" + strings.NewReplacer("(", "%28", ")", "%29").Replace(url) + ")"
	default:
		return url
	}
}
