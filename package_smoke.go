package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/frankwei98/PicPiper/internal/imaging"
)

// runPackageSmoke checks the real packaged WebView, bridge and child-process
// codecs on each desktop platform without a provider account or OS file picker.
// It uses the same private data/session and disabled updater as the full smoke.
func runPackageSmoke(win *mygo.Window, dir string) {
	report := struct {
		smokeReport
		Version string `json:"version"`
		Target  string `json:"target"`
	}{Version: mygo.App.Version(), Target: runtime.GOOS + "-" + runtime.GOARCH}
	defer func() {
		if value := recover(); value != nil {
			report.Error = fmt.Sprint(value)
			_ = smokeCapture(win, dir, "failure.png")
		}
		encoded, _ := json.MarshalIndent(report, "", "  ")
		_ = os.WriteFile(filepath.Join(dir, "report.json"), encoded, 0600)
		fmt.Println(string(encoded))
		mygo.App.Quit()
	}()
	must := func(err error) {
		if err != nil {
			panic(err)
		}
	}
	must(smokeWait(win, `Boolean(window.mygo && document.querySelector('.onboarding-cards'))`, 30*time.Second))
	_, err := smokeEval(win, `localStorage.setItem('pic-piper.language', 'en'); window.dispatchEvent(new StorageEvent('storage', {key: 'pic-piper.language'})); return true;`)
	must(err)
	must(smokeWait(win, `document.documentElement.lang === 'en'`, 5*time.Second))
	must(smokeClick(win, "Continue"))
	must(smokeClick(win, "Complete setup"))
	must(smokeWait(win, `Boolean(document.querySelector('.rail-tools button[aria-label="Add images"]:not(:disabled)'))`, 10*time.Second))
	must(smokeCapture(win, dir, "workspace.png"))
	report.Steps = append(report.Steps, "Packaged frontend completed onboarding through the native settings bridge")

	source := filepath.Join(dir, "Synthetic alpha.png")
	img := image.NewNRGBA(image.Rect(0, 0, 32, 16))
	img.SetNRGBA(31, 15, color.NRGBA{R: 200, G: 100, B: 50, A: 128})
	var buffer bytes.Buffer
	must(png.Encode(&buffer, img))
	must(os.WriteFile(source, buffer.Bytes(), 0600))
	must(ImagesOpened.Emit(win, []string{source}))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Synthetic alpha.png"]'))`, 30*time.Second))
	must(smokeCapture(win, dir, "compressed.png"))
	report.Steps = append(report.Steps, "Frontend received an image event and displayed a compressed result")

	call := func(operation string, payload any, destination any) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		value, err := win.Page().EvalContext(ctx, `return await window.mygo.call('Backend.Call', `+smokeJSON(operation)+`, `+smokeJSON(smokeJSON(payload))+`);`)
		must(err)
		var response struct {
			Data  json.RawMessage `json:"data"`
			Error any             `json:"error"`
		}
		must(json.Unmarshal([]byte(fmt.Sprint(value)), &response))
		if response.Error != nil {
			must(fmt.Errorf("%s: %v", operation, response.Error))
		}
		must(json.Unmarshal(response.Data, destination))
	}
	var run struct {
		OutputDir string `json:"outputDir"`
	}
	call("create_optimizer_run", map[string]any{}, &run)
	var outputs []string
	for _, format := range []string{"jpg", "png", "webp", "avif", "jxl"} {
		var result imaging.Result
		call("compress_image", map[string]any{
			"sourcePath": source, "outputDir": run.OutputDir, "outputFileName": "result." + format,
			"settings": map[string]any{"targetFormat": format, "quality": 85},
		}, &result)
		var inspected imaging.Inspection
		call("inspect_image", map[string]any{"path": result.OutputPath}, &inspected)
		if inspected.Width != 32 || inspected.Height != 16 {
			must(fmt.Errorf("%s dimensions changed: %+v", format, inspected))
		}
		outputs = append(outputs, result.OutputPath)
	}
	report.Steps = append(report.Steps, "Native bridge encoded and decoded JPEG, PNG, WebP, AVIF and JPEG XL through isolated workers")
	var preview imaging.ComparisonImage
	call("read_comparison_image", map[string]any{"path": outputs[1], "taskId": "package-smoke-comparison"}, &preview)
	pixels, err := smokeEval(win, `const img = new Image(); img.crossOrigin = "anonymous"; img.src = `+smokeJSON(preview.URL)+`; await img.decode(); return img.naturalWidth * img.naturalHeight;`)
	must(err)
	if fmt.Sprint(pixels) != "512" {
		must(fmt.Errorf("native comparison returned incorrect pixels: %v", pixels))
	}
	call("cancel_image_task", map[string]any{"taskId": "package-smoke-comparison"}, new(any))
	exportDir := filepath.Join(dir, "exports")
	must(os.MkdirAll(exportDir, 0700))
	var first, second []string
	request := map[string]any{"outputPaths": outputs, "targetDir": exportDir}
	call("copy_outputs_to_dir", request, &first)
	call("copy_outputs_to_dir", request, &second)
	if len(first) != len(outputs) || len(second) != len(outputs) {
		must(fmt.Errorf("not all generated outputs were exported"))
	}
	for index, path := range first {
		if path == second[index] {
			must(fmt.Errorf("export replaced an existing path"))
		}
		original, err := os.ReadFile(outputs[index])
		must(err)
		exported, err := os.ReadFile(path)
		must(err)
		if !bytes.Equal(original, exported) {
			must(fmt.Errorf("export changed output bytes"))
		}
	}
	report.Steps = append(report.Steps, "Export preserved existing files and generated image bytes")
	report.Passed = true
}
