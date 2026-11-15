package imaging

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/frankwei98/PicPiper/internal/apperror"
	imagedraw "golang.org/x/image/draw"
)

const maxPixels = 40_000_000

// Service keeps expensive decoding bounded independently of the frontend queue.
type Service struct {
	dataDir       string
	cacheDir      string
	workers       chan struct{}
	jobs          imageJobs
	workerMu      sync.Mutex
	idleWorkers   []*imageWorker
	executable    string
	executableErr error
	lifetime      context.Context
	stop          context.CancelFunc
	closeOnce     sync.Once
}

func New(dataDir string) *Service {
	lifetime, stop := context.WithCancel(context.Background())
	return &Service{dataDir: dataDir, cacheDir: filepath.Join(dataDir, "optimizer-cache"), workers: make(chan struct{}, 2), lifetime: lifetime, stop: stop}
}

func (s *Service) Close() {
	s.closeOnce.Do(func() {
		s.stop()
		// Reap child processes before the application exits.
		for range cap(s.workers) {
			s.workers <- struct{}{}
		}
		s.closeIdleWorkers()
		for range cap(s.workers) {
			<-s.workers
		}
	})
}

type settings struct {
	TargetFormat  string `json:"targetFormat"`
	Quality       int    `json:"quality"`
	MaxDimension  int    `json:"maxDimension,omitempty"`
	AnimationMode string `json:"animationMode,omitempty"`
}

type request struct {
	TaskID         string   `json:"taskId,omitempty"`
	Path           string   `json:"path"`
	SourcePath     string   `json:"sourcePath"`
	OutputDir      string   `json:"outputDir"`
	OutputFileName string   `json:"outputFileName"`
	OutputPaths    []string `json:"outputPaths"`
	TargetDir      string   `json:"targetDir"`
	MaxSize        int      `json:"maxSize"`
	Settings       settings `json:"settings"`
}

type Inspection struct {
	Path           string  `json:"path"`
	FileName       string  `json:"fileName"`
	SourceFormat   string  `json:"sourceFormat"`
	OriginalBytes  int64   `json:"originalBytes"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	BitDepth       int     `json:"bitDepth"`
	FrameCount     int     `json:"frameCount"`
	Animated       bool    `json:"animated"`
	HDR            bool    `json:"hdr"`
	EstimatedBytes *int64  `json:"estimatedBytes"`
	Warning        *string `json:"warning"`
}

type Result struct {
	SourcePath     string `json:"sourcePath"`
	OutputPath     string `json:"outputPath"`
	OutputFileName string `json:"outputFileName"`
	OriginalBytes  int64  `json:"originalBytes"`
	OutputBytes    int64  `json:"outputBytes"`
	TargetFormat   string `json:"targetFormat"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	Warning        string `json:"warning,omitempty"`
}

func (s *Service) Call(ctx context.Context, operation string, payload json.RawMessage) (any, error) {
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, apperror.New("invalidRequest", "The image request could not be read.")
	}
	if operation == "cancel_image_task" {
		return nil, s.jobs.cancel(req.TaskID)
	}
	if workerOperation(operation) {
		workerContext, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(s.lifetime, cancel)
		defer func() { stop(); cancel() }()
		ctx = workerContext
		if err := s.lifetime.Err(); err != nil {
			return nil, err
		}
		var finish func()
		var err error
		ctx, finish, err = s.jobs.start(ctx, req.TaskID)
		if err != nil {
			return nil, err
		}
		defer finish()
	}
	switch operation {
	case "create_optimizer_run":
		return s.createRun()
	case "copy_outputs_to_dir":
		return s.copyOutputs(ctx, req)
	case "inspect_image", "compress_image", "read_thumbnail", "read_comparison_image":
		select {
		case s.workers <- struct{}{}:
			defer func() { <-s.workers }()
		case <-ctx.Done():
			return nil, apperror.New("cancelled", "Image processing was cancelled.")
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if s.executable != "" || s.executableErr != nil {
			return s.isolated(ctx, operation, req)
		}
		switch operation {
		case "inspect_image":
			return inspect(req.Path)
		case "compress_image":
			return s.compress(ctx, req)
		case "read_thumbnail":
			return thumbnail(ctx, req)
		default:
			return comparison(ctx, req.Path)
		}
	default:
		return nil, apperror.New("unknownOperation", "This image operation is unavailable.")
	}
}

func inspect(path string) (Inspection, error) {
	file, err := os.Open(path)
	if err != nil {
		return Inspection{}, apperror.New("imageOpenFailed", "Could not open the image. Choose a readable image file.")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Inspection{}, apperror.New("imageReadFailed", "Choose an image file, rather than a folder.")
	}
	if info.Size() > 256<<20 {
		return Inspection{}, apperror.New("imageTooLarge", "Images must be smaller than 256 MB.")
	}
	cfg, format, err := decodeConfig(file)
	if err != nil || !readableFormat(format) {
		return Inspection{}, apperror.New("unsupportedImage", "Choose a readable JPEG, PNG, WebP, AVIF, JPEG XL, or HEIF/HEIC image.")
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxPixels || cfg.Height > maxPixels || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return Inspection{}, apperror.New("imageTooLarge", "Images must contain at most 40 million pixels.")
	}
	width, height := cfg.Width, cfg.Height
	if orientationFromFile(file) >= 5 {
		width, height = height, width
	}
	switch format {
	case "jpeg":
		format = "jpg"
	case "heic":
		format = "heif"
	}
	metadata := properties(file)
	if err := validateColorProperties(metadata); err != nil {
		return Inspection{}, err
	}
	if cfg.ColorModel == color.RGBA64Model || cfg.ColorModel == color.NRGBA64Model || cfg.ColorModel == color.Gray16Model {
		metadata.bitDepth = 16
	}
	var notices []string
	if metadata.hdr {
		metadata.bitDepth = 16
		notices = append(notices, "HDR (PQ/HLG) is automatically tone-mapped to SDR/sRGB for preview and export. The HDR original stays untouched.")
	}
	if len(metadata.profile) > 0 && !metadata.hdr {
		notices = append(notices, "Embedded RGB colors are converted to sRGB before the profile is removed.")
	}
	if metadata.sequence {
		notices = append(notices, "Animated input: use WebP to retain supported WebP frames. The preview shows the first frame.")
	}
	if metadata.bitDepth > 8 {
		notices = append(notices, "High-bit-depth input: use PNG to retain 16-bit precision, including when resizing.")
	}
	var warning *string
	if len(notices) > 0 {
		text := strings.Join(notices, " ")
		warning = &text
	}
	return Inspection{Path: path, FileName: filepath.Base(path), SourceFormat: format, OriginalBytes: info.Size(), Width: width, Height: height, BitDepth: metadata.bitDepth, FrameCount: metadata.frames, Animated: metadata.sequence, HDR: metadata.hdr, Warning: warning}, nil
}

func decode(ctx context.Context, path string) (image.Image, Inspection, error) {
	info, err := inspect(path)
	if err != nil {
		return nil, info, err
	}
	if err := ctx.Err(); err != nil {
		return nil, info, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, info, apperror.New("imageOpenFailed", "The image is no longer available.")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || opened.Size() > 256<<20 {
		return nil, info, apperror.New("imageTooLarge", "Choose a regular image file smaller than 256 MB.")
	}
	info.OriginalBytes = opened.Size()
	// DecodeConfig and Decode share this handle so a replaced path cannot change
	// the decoder's pixel allocation after the size check.
	cfg, format, err := decodeConfig(file)
	if err != nil || !readableFormat(format) || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxPixels || cfg.Height > maxPixels || int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return nil, info, apperror.New("imageTooLarge", "This image could not be decoded within the pixel limit.")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, info, err
	}
	metadata := properties(file)
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, info, err
	}
	var img image.Image
	if format == "png" && metadata.sequence {
		img, err = decodeAPNGFirst(ctx, file, cfg)
	} else {
		img, err = decodePixels(file, format)
	}
	if err != nil {
		return nil, info, apperror.New("imageDecodeFailed", "The image is damaged or uses an unsupported encoding.")
	}
	if err := ctx.Err(); err != nil {
		return nil, info, err
	}
	if err := validateColorProperties(metadata); err != nil {
		return nil, info, err
	}
	if metadata.hdr {
		img, err = toneMapHDR(ctx, img, metadata)
		if err != nil {
			return nil, info, err
		}
	} else if len(metadata.profile) > 0 {
		img, err = normalizeProfile(img, metadata.profile)
		if err != nil {
			return nil, info, apperror.New("colorProfileUnsupported", "This embedded color profile could not be converted safely. Export an sRGB copy from your image editor first.")
		}
	}
	img = applyOrientation(img, orientationFromFile(file))
	info.Width, info.Height = img.Bounds().Dx(), img.Bounds().Dy()
	return img, info, nil
}

func (s *Service) createRun() (any, error) {
	if err := os.MkdirAll(s.cacheDir, 0700); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(s.cacheDir, "run-")
	if err != nil {
		return nil, err
	}
	// Runs are private disposable outputs; only old run directories are removed.
	entries, _ := os.ReadDir(s.cacheDir)
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "run-") {
			continue
		}
		if info, err := entry.Info(); err == nil && time.Since(info.ModTime()) > 7*24*time.Hour {
			_ = os.RemoveAll(filepath.Join(s.cacheDir, entry.Name()))
		}
	}
	return map[string]string{"runId": filepath.Base(dir), "outputDir": dir}, nil
}

func under(base, candidate string) (string, error) {
	root, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", apperror.New("invalidOutputPath", "The output is outside this app's image workspace.")
	}
	return resolved, nil
}

func validFileName(name string) bool {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\:*?"<>|`) || strings.TrimRight(name, ". ") != name {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || (len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '1' && stem[3] <= '9') {
		return false
	}
	return true
}

func reserve(dir, name string) (*os.File, error) {
	if !validFileName(name) {
		return nil, apperror.New("invalidFileName", "Choose a filename without path separators or reserved characters.")
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for sequence := 1; sequence <= 10000; sequence++ {
		candidate := name
		if sequence > 1 {
			candidate = fmt.Sprintf("%s-%d%s", stem, sequence, ext)
		}
		file, err := os.OpenFile(filepath.Join(dir, candidate), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(err) {
			continue
		}
		return file, err
	}
	return nil, apperror.New("tooManyFiles", "Too many files share this name. Choose another output folder.")
}

func (s *Service) compress(ctx context.Context, req request) (Result, error) {
	if !writableFormat(req.Settings.TargetFormat) {
		return Result{}, apperror.New("codecUnavailable", "Choose JPEG, PNG, WebP, AVIF, or JPEG XL as the target format.")
	}
	if req.Settings.MaxDimension < 0 || req.Settings.MaxDimension > 32768 {
		return Result{}, apperror.New("invalidDimensions", "Choose an image edge between 1 and 32768 pixels, or keep the original size.")
	}
	if mode := req.Settings.AnimationMode; mode != "" && mode != "preserve" && mode != "firstFrame" {
		return Result{}, apperror.New("invalidAnimationMode", "Choose all animation frames or first frame only.")
	}
	dir, err := under(s.cacheDir, req.OutputDir)
	if err != nil {
		return Result{}, err
	}
	if !validFileName(req.OutputFileName) || strings.ToLower(filepath.Ext(req.OutputFileName)) != "."+req.Settings.TargetFormat {
		return Result{}, apperror.New("invalidFileName", "The output filename must match the selected format.")
	}
	img, inspection, err := decode(ctx, req.SourcePath)
	if err != nil {
		return Result{}, err
	}
	metadata := imageProperties(req.SourcePath)
	var animationEncoder func(io.Writer) error
	if metadata.sequence && req.Settings.AnimationMode != "firstFrame" {
		if inspection.SourceFormat != "webp" {
			return Result{}, apperror.New("animationUnsupported", "Choose First frame only to export a still image from this animation. The original animation stays untouched.")
		}
		if req.Settings.TargetFormat != "webp" {
			return Result{}, apperror.New("animationNeedsTarget", "Choose WebP to keep every animation frame. Still-image formats would discard the animation.")
		}
		animation, err := decodeWebPAnimation(ctx, req.SourcePath, metadata, inspection, req.Settings.MaxDimension)
		if err != nil {
			return Result{}, apperror.New("animationDecodeFailed", "Could not preserve this animation. Use at most 120 frames and 40 million total frame pixels.")
		}
		img = animation.Image[0]
		animationEncoder = func(writer io.Writer) error {
			return encodeAnimation(writer, animation, req.Settings.TargetFormat, min(100, max(1, req.Settings.Quality)))
		}
	}
	if highBitDepth(img) && req.Settings.TargetFormat == "jxl" && req.Settings.Quality >= 100 {
		return Result{}, apperror.New("losslessBitDepth", "Choose PNG for lossless high-bit-depth output. This JPEG XL encoder accepts 8-bit pixels.")
	}
	output, err := reserve(dir, req.OutputFileName)
	if err != nil {
		return Result{}, err
	}
	complete := false
	defer func() {
		output.Close()
		if !complete {
			_ = os.Remove(output.Name())
		}
	}()
	warning := "Metadata, including GPS, was removed."
	if limit := req.Settings.MaxDimension; limit > 0 {
		bounds := img.Bounds()
		if longest := max(bounds.Dx(), bounds.Dy()); longest > limit {
			width := max(1, int((int64(bounds.Dx())*int64(limit)+int64(longest)/2)/int64(longest)))
			height := max(1, int((int64(bounds.Dy())*int64(limit)+int64(longest)/2)/int64(longest)))
			img = resizePreservingDepth(img, width, height)
			warning += fmt.Sprintf(" Resized to %d × %d pixels without cropping.", width, height)
		}
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if metadata.hdr {
		warning += " HDR (PQ/HLG) was tone-mapped to SDR/sRGB; the HDR original is untouched."
	} else if len(metadata.profile) > 0 {
		warning += " Embedded RGB colors were converted to sRGB."
	}
	if metadata.sequence && req.Settings.AnimationMode == "firstFrame" {
		warning += " First frame only was exported as selected; the original animation is untouched."
	}
	if highBitDepth(img) && req.Settings.TargetFormat != "png" {
		warning += " High-bit-depth pixels were converted to 8-bit. Use PNG to preserve their precision."
	}
	if animationEncoder != nil {
		warning += fmt.Sprintf(" All %d animation frames, timing and loop count were retained; the preview shows the first frame.", metadata.frames)
		err = animationEncoder(output)
	} else if req.Settings.TargetFormat == "jpg" {
		if !opaque(img) {
			flat := image.NewRGBA(img.Bounds())
			draw.Draw(flat, flat.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
			draw.Draw(flat, flat.Bounds(), img, img.Bounds().Min, draw.Over)
			img = flat
			warning += " Transparency was replaced with white for JPEG."
		}
		err = jpeg.Encode(output, img, &jpeg.Options{Quality: min(100, max(1, req.Settings.Quality))})
	} else if req.Settings.TargetFormat == "png" {
		err = encodePNG(output, img)
		warning += " PNG is lossless; the quality slider does not affect PNG output."
	} else {
		err = encodeModern(output, img, req.Settings.TargetFormat, min(100, max(1, req.Settings.Quality)))
		if req.Settings.TargetFormat == "jxl" && req.Settings.Quality >= 100 {
			warning += " JPEG XL at quality 100 is lossless for the encoder's 8-bit pixels; higher-bit-depth inputs are converted to 8-bit."
		}
	}
	if err != nil {
		return Result{}, apperror.New("imageEncodeFailed", "Could not encode this image. Try another format or check free disk space.")
	}
	if err := output.Sync(); err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	stat, err := output.Stat()
	if err != nil {
		return Result{}, err
	}
	complete = true
	return Result{SourcePath: req.SourcePath, OutputPath: output.Name(), OutputFileName: filepath.Base(output.Name()), OriginalBytes: inspection.OriginalBytes, OutputBytes: stat.Size(), TargetFormat: req.Settings.TargetFormat, Width: img.Bounds().Dx(), Height: img.Bounds().Dy(), Warning: warning}, nil
}

func opaque(img image.Image) bool {
	if value, ok := img.(interface{ Opaque() bool }); ok {
		return value.Opaque()
	}
	return false
}

func thumbnail(ctx context.Context, req request) (any, error) {
	img, _, err := decode(ctx, req.Path)
	if err != nil {
		return nil, err
	}
	limit := req.MaxSize
	if limit == 0 {
		limit = 256
	}
	limit = min(1024, max(16, limit))
	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if max(width, height) > limit {
		scale := float64(limit) / float64(max(width, height))
		img = resize(img, max(1, int(float64(width)*scale)), max(1, int(float64(height)*scale)))
	}
	var buffer bytes.Buffer
	mime := "image/png"
	if opaque(img) {
		mime = "image/jpeg"
		err = jpeg.Encode(&buffer, img, &jpeg.Options{Quality: 80})
	} else {
		err = encodePNG(&buffer, img)
	}
	if err != nil {
		return nil, err
	}
	return map[string]string{"dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())}, nil
}

func comparison(ctx context.Context, path string) (any, error) {
	img, _, err := decode(ctx, path)
	if err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	if err := encodePNG(&buffer, img); err != nil {
		return nil, err
	}
	return map[string]any{"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes()), "width": img.Bounds().Dx(), "height": img.Bounds().Dy()}, nil
}

// Catmull-Rom filters the complete source footprint and interpolates premultiplied
// colors, retaining detail without aliasing or dark fringes at alpha edges.
func highBitDepth(img image.Image) bool {
	switch img.(type) {
	case *image.NRGBA64, *image.RGBA64, *image.Gray16, *image.Alpha16:
		return true
	}
	return false
}

func resizePreservingDepth(src image.Image, width, height int) image.Image {
	if highBitDepth(src) {
		dst := image.NewNRGBA64(image.Rect(0, 0, width, height))
		imagedraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), imagedraw.Src, nil)
		return dst
	}
	return resize(src, width, height)
}

func resize(src image.Image, width, height int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, width, height))
	imagedraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), imagedraw.Src, nil)
	return dst
}

func (s *Service) copyOutputs(ctx context.Context, req request) ([]string, error) {
	paths, err := s.OutputPaths(req.OutputPaths)
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return []string{}, nil
	}
	if req.TargetDir == "" {
		return nil, apperror.New("invalidTargetDir", "Choose an output folder.")
	}
	if err := os.MkdirAll(req.TargetDir, 0755); err != nil {
		return nil, err
	}
	copied := make([]string, 0, len(paths))
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		source, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		outputPath, copyErr := copyReserved(ctx, req.TargetDir, filepath.Base(path), source)
		source.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		copied = append(copied, outputPath)
	}
	return copied, nil
}

// ThumbnailDataURL uses the same bounded, isolated decoder as local previews.
func (s *Service) ThumbnailDataURL(ctx context.Context, path string, maxSize int) (string, error) {
	payload, err := json.Marshal(map[string]any{"path": path, "maxSize": maxSize})
	if err != nil {
		return "", err
	}
	value, err := s.Call(ctx, "read_thumbnail", payload)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	var result struct {
		DataURL string `json:"dataUrl"`
	}
	if err = json.Unmarshal(data, &result); err != nil {
		return "", err
	}
	return result.DataURL, nil
}

// OutputPaths validates generated files before native clipboard or export access.
func (s *Service) OutputPaths(outputPaths []string) ([]string, error) {
	paths := make([]string, 0, len(outputPaths))
	for _, path := range outputPaths {
		resolved, err := under(s.cacheDir, path)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(resolved)
		if err != nil || !info.Mode().IsRegular() {
			return nil, apperror.New("invalidOutputPath", "Only generated image files can be exported.")
		}
		paths = append(paths, resolved)
	}
	return paths, nil
}

// ClipboardPNG uses the same bounded decoding and color handling as comparison.
func (s *Service) ClipboardPNG(ctx context.Context, path string) ([]byte, error) {
	paths, err := s.OutputPaths([]string{path})
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(request{Path: paths[0]})
	result, err := s.Call(ctx, "read_comparison_image", payload)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var preview struct {
		DataURL string `json:"dataUrl"`
	}
	if err = json.Unmarshal(raw, &preview); err != nil {
		return nil, err
	}
	encoded, ok := strings.CutPrefix(preview.DataURL, "data:image/png;base64,")
	if !ok {
		return nil, apperror.New("clipboardFailed", "Could not prepare the clipboard image.")
	}
	return base64.StdEncoding.DecodeString(encoded)
}
