package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/gen2brain/webp"
)

type smokeReport struct {
	Passed bool     `json:"passed"`
	Steps  []string `json:"steps"`
	Error  string   `json:"error,omitempty"`
}

// runSmoke drives the packaged application's real WebView and native Go bridge.
// It runs only with --smoke-test and uses private fixtures and a loopback bucket.
func runSmoke(win *mygo.Window, dir string, backend *Backend) {
	report := smokeReport{Steps: []string{}}
	defer func() {
		if value := recover(); value != nil {
			report.Error = fmt.Sprint(value)
		}
		if report.Error != "" {
			if body, err := smokeEval(win, "document.body.innerText"); err == nil {
				text := fmt.Sprint(body)
				if len(text) > 1800 {
					text = text[:1800]
				}
				report.Error += "\nUI: " + text
			}
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
	must(os.MkdirAll(dir, 0700))
	must(smokeWait(win, `Boolean(window.mygo && document.querySelector('.onboarding-cards'))`, 15*time.Second))
	// Keep screenshots deterministic when macOS throttles an unattended WebView.
	_, err := smokeEval(win, `const style = document.createElement('style'); style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.append(style); window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16); window.cancelAnimationFrame = clearTimeout; return true;`)
	must(err)
	// A fresh disposable WebView session must not inherit user language choices.
	must(smokeWait(win, `localStorage.getItem('pic-piper.language') === null`, 5*time.Second))
	report.Steps = append(report.Steps, "Smoke uses an isolated WebView session without saved user language preferences")
	// The existing workflow uses English action names regardless of host locale.
	_, err = smokeEval(win, `localStorage.setItem('pic-piper.language', 'en'); window.dispatchEvent(new StorageEvent('storage', {key: 'pic-piper.language'})); return true;`)
	must(err)
	must(smokeWait(win, `document.documentElement.lang === 'en'`, 5*time.Second))
	must(smokeCapture(win, dir, "onboarding.png"))
	_, err = smokeEval(win, `document.querySelectorAll('.onboarding-cards input')[1].click(); return true;`)
	must(err)
	must(smokeClick(win, "Continue"))
	must(smokeCapture(win, dir, "onboarding-r2.png"))
	_, err = smokeEval(win, `document.querySelectorAll('.onboarding-cards input')[1].click(); return true;`)
	must(err)
	must(smokeCapture(win, dir, "onboarding-s3.png"))
	must(smokeClick(win, "Back"))
	_, err = smokeEval(win, `document.querySelectorAll('.onboarding-cards input')[1].click(); return true;`)
	must(err)
	must(smokeClick(win, "Continue"))
	must(smokeWait(win, `Boolean(document.querySelector('[role="switch"][aria-label="Enable Mini"]'))`, 5*time.Second))
	must(smokeCapture(win, dir, "onboarding-mini-off.png"))
	must(smokeClick(win, "Enable Mini"))
	must(smokeCapture(win, dir, "onboarding-mini-on.png"))
	must(smokeClick(win, "Complete setup"))
	must(smokeWait(win, `Boolean(document.querySelector('[role="tab"]'))`, 5*time.Second))
	must(smokeWait(win, `Boolean(document.querySelector('.rail-tools button[aria-label="Add images"]:not(:disabled)')) && !document.querySelector('.rail-tools button[aria-label="Clear batch"]')`, 5*time.Second))
	must(smokeCapture(win, dir, "workspace.png"))
	report.Steps = append(report.Steps, "Packaged frontend and native runtime loaded")

	bucket := &smokeBucket{objects: map[string][]byte{}}
	server := httptest.NewServer(bucket)
	defer server.Close()
	must(smokeClick(win, "Settings"))
	win.SetSize(1920, 900)
	// AppKit clamps height to the display's work area (684px on the CI
	// runner). Horizontal alignment only needs the supported 600px minimum.
	must(smokeWait(win, `innerWidth >= 1900 && innerHeight >= 600`, 5*time.Second))
	must(smokeSelect(win, "Parallel image tasks", "1"))
	must(smokeClick(win, "Save general settings"))
	must(smokeWait(win, `document.querySelector('#settings-processing-concurrency')?.value === '1' && document.body.innerText.includes('General settings saved.')`, 5*time.Second))
	if backend.images.ProcessingLimits().Concurrency != 1 {
		must(fmt.Errorf("manual concurrency did not apply to native workers"))
	}
	must(smokeSelect(win, "Parallel image tasks", "0"))
	must(smokeClick(win, "Save general settings"))
	must(smokeWait(win, `document.querySelector('#settings-processing-concurrency')?.value === '0' && document.body.innerText.includes('General settings saved.')`, 5*time.Second))
	limits := backend.images.ProcessingLimits()
	if limits.Concurrency != max(1, (limits.CPUCount+1)/2) {
		must(fmt.Errorf("automatic concurrency was not rounded up from 50%% of CPU count"))
	}
	report.Steps = append(report.Steps, "General settings applied a manual image processing budget and restored the CPU-based automatic default without restarting")
	must(smokeSettingsPreferencesFit(win))
	must(smokeCapture(win, dir, "settings-general-wide-en.png"))
	win.SetSize(1920, 684)
	must(smokeWait(win, `innerWidth >= 1900 && innerHeight >= 600 && innerHeight <= 689`, 5*time.Second))
	must(smokeSettingsPreferencesFit(win))
	must(smokeCapture(win, dir, "settings-general-wide-short-en.png"))
	must(smokeWait(win, `document.querySelector('#settings-automatic-update-checks')?.disabled === true && document.body.innerText.includes('Version ')`, 5*time.Second))
	_, err = smokeEval(win, `document.querySelector('#settings-automatic-update-checks').scrollIntoView({block:'center'}); return true;`)
	must(err)
	must(smokeCapture(win, dir, "settings-updates-en.png"))
	_, err = smokeEval(win, `document.querySelector('.workspace-scroll').scrollTop = 0; return true;`)
	must(err)
	report.Steps = append(report.Steps, "Update settings show the packaged version, check action and preferences without accessing the real update feed during smoke")
	win.SetSize(1120, 820)
	must(smokeWait(win, `innerWidth <= 1125 && innerHeight <= 825`, 5*time.Second))
	must(smokeClick(win, "S3 profiles"))
	must(smokeWait(win, `document.getElementById('settings-section-profile')?.hidden === false`, 5*time.Second))
	fields := [][2]string{{"Profile name", "MVP local bucket"}, {"Endpoint", server.URL}, {"Region", "us-east-1"}, {"Bucket", "mvp-images"}, {"Access key ID", "MVP-TEST-ACCESS"}, {"Secret access key", "local-test-secret"}, {"Public Base URL", server.URL + "/public"}, {"Default prefix", "images"}}
	for _, field := range fields {
		if field[0] == "Public Base URL" || field[0] == "Default prefix" {
			must(smokeClick(win, "Links and naming"))
		}
		label, value := smokeJSON(field[0]), smokeJSON(field[1])
		_, err := smokeEval(win, `const label = [...document.querySelectorAll('label')].find(x => x.textContent.trim().startsWith(`+label+`));
const input = label?.querySelector('input'); if (!input) throw Error('Missing field ' + `+label+`);
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, `+value+`);
input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
await new Promise(resolve => setTimeout(resolve, 25)); return true;`)
		must(err)
	}
	must(smokeClick(win, "S3 profiles"))
	must(smokeClick(win, "Test connection"))
	must(smokeWait(win, `document.body.innerText.includes('Connection successful')`, 10*time.Second))
	must(smokeClick(win, "Save profile"))
	must(smokeWait(win, `document.body.innerText.includes('Profile saved.')`, 10*time.Second))
	must(smokeClick(win, "S3 profiles"))
	must(smokeCapture(win, dir, "settings.png"))
	must(smokeClick(win, "Add with an account"))
	must(smokeWait(win, `document.getElementById('settings-tab-oauth')?.getAttribute('aria-selected') === 'true'`, 5*time.Second))
	must(smokeCapture(win, dir, "account-authorization.png"))
	must(smokeClick(win, "S3 profiles"))
	report.Steps = append(report.Steps, "Settings form tested a draft S3 connection and saved the profile")
	report.Steps = append(report.Steps, "Wide settings align controls with the right content inset at the CI runner's 684px viewport height")

	fixture := filepath.Join(dir, "Sample photo.jpg")
	must(smokeFixture(fixture))
	// Open With is app-wide, including while the settings page is active.
	must(ImagesOpened.Emit(win, []string{fixture}))
	must(smokeClick(win, "Compress"))
	must(smokeWait(win, `Boolean(document.querySelector('[data-testid="image-drop-zone"]'))`, 5*time.Second))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]'))`, 15*time.Second))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	must(smokeClick(win, "View compression results"))
	must(smokeWait(win, `Boolean([...document.querySelectorAll('[role="dialog"] h2')].find(x => x.textContent==='Compression results'))`, 5*time.Second))
	must(smokeCapture(win, dir, "compression-results.png"))
	must(smokeClick(win, "Copy image"))
	must(smokeWait(win, `document.querySelector('[role="dialog"]').innerText.includes('Image copied to clipboard')`, 10*time.Second))
	clipboardPixels, err := png.DecodeConfig(bytes.NewReader(mygo.Clipboard.ReadImage()))
	must(err)
	if clipboardPixels.Width != 1200 || clipboardPixels.Height != 800 {
		must(fmt.Errorf("clipboard image lost full resolution"))
	}
	report.Steps = append(report.Steps, "Results opened on request and copied full-resolution pixels to native clipboard")
	must(smokeClick(win, "Back to compression"))
	must(smokeWait(win, `Boolean(document.querySelector('.rail-tools button[aria-label="Add images"]:not(:disabled)')) && Boolean(document.querySelector('.rail-tools button[aria-label="Clear batch"]:not(:disabled)'))`, 5*time.Second))
	must(smokeCapture(win, dir, "compressed.png"))
	report.Steps = append(report.Steps, "Queue header offers Add images when empty and populated, with Clear batch only for populated queues")
	runsBefore, err := filepath.Glob(filepath.Join(dir, "data", "optimizer-cache", "run-*"))
	must(err)
	_, err = smokeEval(win, `const slider=document.getElementById('output-quality'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'60'); slider.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,1000)); if(document.querySelector('input.quality-input').value!=='60') throw Error('Quality draft did not follow slider'); return true;`)
	must(err)
	heldRuns, err := filepath.Glob(filepath.Join(dir, "data", "optimizer-cache", "run-*"))
	must(err)
	if len(heldRuns) != len(runsBefore) {
		must(fmt.Errorf("quality drag started compression before release"))
	}
	_, err = smokeEval(win, `const slider=document.getElementById('output-quality'); slider.dispatchEvent(new Event('change',{bubbles:true})); return true;`)
	must(err)
	waitQualityRun := func(previous int) {
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			runs, err := filepath.Glob(filepath.Join(dir, "data", "optimizer-cache", "run-*"))
			must(err)
			if len(runs) > previous {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		must(fmt.Errorf("committed quality did not start compression"))
	}
	waitQualityRun(len(runsBefore))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]'))`, 15*time.Second))
	restoredFrom, err := filepath.Glob(filepath.Join(dir, "data", "optimizer-cache", "run-*"))
	must(err)
	_, err = smokeEval(win, `const input=document.querySelector('input.quality-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'85'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); return true;`)
	must(err)
	waitQualityRun(len(restoredFrom))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]'))`, 15*time.Second))
	report.Steps = append(report.Steps, "Holding a quality drag updated the draft for one second without starting compression; release committed once, and number-field blur restored quality")

	report.Steps = append(report.Steps, "Native file-open event received in Settings imported an image and completed compression")
	galleryFixture := filepath.Join(dir, "Opened from gallery.jpg")
	must(smokeFixture(galleryFixture))
	must(smokeClick(win, "S3 Gallery"))
	must(ImagesOpened.Emit(win, []string{galleryFixture}))
	must(smokeClick(win, "Compress"))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Opened from gallery.jpg"]'))`, 15*time.Second))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	must(smokeClick(win, "View compression results"))
	must(smokeWait(win, `Boolean([...document.querySelectorAll('button')].find(x => x.textContent==='Copy selected images'))`, 5*time.Second))
	must(smokeClick(win, "Copy selected images"))
	must(smokeWait(win, `document.querySelector('[role="dialog"]').innerText.includes('Images copied to clipboard')`, 10*time.Second))
	copiedFiles, err := mygo.Clipboard.ReadFiles()
	must(err)
	if len(copiedFiles) != 2 {
		must(fmt.Errorf("batch clipboard contains %d files", len(copiedFiles)))
	}
	report.Steps = append(report.Steps, "Batch result action copied two native file URLs")
	must(smokeClick(win, "Back to compression"))
	must(smokeCapture(win, dir, "open-with-across-views.png"))
	must(smokeClick(win, "Remove Opened from gallery.jpg"))
	report.Steps = append(report.Steps, "Native file-open event received in S3 Gallery was retained across navigation")
	must(smokeClick(win, "Compare Sample photo.jpg"))
	must(smokeWait(win, `[...document.querySelectorAll('[role="dialog"] img')].filter(x => x.complete && x.naturalWidth > 0).length >= 2`, 15*time.Second))
	must(smokeCapture(win, dir, "comparison.png"))
	must(smokeClick(win, "Close"))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	report.Steps = append(report.Steps, "Comparison dialog rendered both full-resolution images")
	for _, format := range []string{"webp", "avif", "jxl", "jpg"} {
		if format == "webp" {
			must(smokeSelect(win, "Batch format", format))
		} else {
			must(smokeSelect(win, "Format for Sample photo.jpg", format))
		}
		must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]')) && !document.body.innerText.includes('Compressing...')`, 60*time.Second))
		must(smokeClick(win, "Compare Sample photo.jpg"))
		must(smokeWait(win, `[...document.querySelectorAll('[role="dialog"] img')].filter(x => x.complete && x.naturalWidth === 1200 && x.naturalHeight === 800).length >= 2 && document.querySelector('[role="dialog"]').innerText.includes(`+smokeJSON("Output format: "+format)+`)`, 60*time.Second))
		must(smokeCapture(win, dir, "comparison-"+format+".png"))
		must(smokeClick(win, "Close"))
		must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
		report.Steps = append(report.Steps, "UI encoded "+format+" and rendered its full-resolution comparison")
	}

	transparentPath := filepath.Join(dir, "Transparent logo.png")
	transparent := image.NewNRGBA(image.Rect(0, 0, 800, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 800; x++ {
			if (x-400)*(x-400)+(y-400)*(y-400) < 300*300 {
				transparent.SetNRGBA(x, y, color.NRGBA{R: 35, G: uint8(100 + y/8), B: 190, A: uint8(80 + x/5)})
			}
		}
	}
	transparentFile, err := os.Create(transparentPath)
	must(err)
	must(png.Encode(transparentFile, transparent))
	must(transparentFile.Close())
	must(ImagesOpened.Emit(win, []string{fixture, transparentPath, filepath.Join(dir, "Imported HEIC.heic")}))
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && document.body.innerText.includes('duplicates skipped')`, 60*time.Second))
	report.Steps = append(report.Steps, "Mixed JPEG, transparent PNG and HEIC batch imported; duplicate source was skipped")
	must(smokeSelect(win, "Batch preset", "balanced"))
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && [...document.querySelectorAll('article.batch-item')].every(x => x.dataset.outputFormat === 'webp')`, 60*time.Second))
	must(smokeClick(win, "Select Transparent logo.png"))
	must(smokeCapture(win, dir, "batch-workbench.png"))
	must(smokeSelect(win, "Longest edge", "960"))
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3`, 60*time.Second))
	must(smokeClick(win, "Compare Sample photo.jpg"))
	must(smokeWait(win, `document.querySelector('img[alt="Original full-resolution preview"]')?.naturalWidth === 1200 && document.querySelector('img[alt="Compressed full-resolution preview"]')?.naturalWidth === 960 && document.querySelector('img[alt="Compressed full-resolution preview"]')?.naturalHeight === 640`, 30*time.Second))
	must(smokeCapture(win, dir, "resized-comparison.png"))
	must(smokeClick(win, "Close"))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	must(smokeSelect(win, "Batch preset", "lossless"))
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && document.querySelector('select[aria-label="Longest edge"]')?.value === '0' && [...document.querySelectorAll('article.batch-item')].every(x => x.dataset.outputFormat === 'jxl')`, 60*time.Second))
	must(smokeClick(win, "Compare Sample photo.jpg"))
	must(smokeWait(win, `[...document.querySelectorAll('[role="dialog"] img')].filter(x => x.complete && x.naturalWidth === 1200 && x.naturalHeight === 800).length === 2 && document.querySelector('[role="dialog"]').innerText.includes('Quality: 100')`, 30*time.Second))
	must(smokeClick(win, "Close"))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	report.Steps = append(report.Steps, "Batch presets applied to all formats; 960px resize kept aspect ratio and lossless preset restored full dimensions")
	must(smokeClick(win, "Remove Transparent logo.png"))
	must(smokeClick(win, "Remove Imported HEIC.heic"))
	must(smokeSelect(win, "Batch preset", "original"))
	must(smokeClick(win, "Select Sample photo.jpg"))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]')) && document.querySelector('select[aria-label="Format for Sample photo.jpg"]')?.value === 'jpg'`, 60*time.Second))

	precisionPath := filepath.Join(dir, "Precision.png")
	precision := image.NewNRGBA64(image.Rect(0, 0, 320, 160))
	for y := 0; y < 160; y++ {
		for x := 0; x < 320; x++ {
			precision.SetNRGBA64(x, y, color.NRGBA64{R: uint16(0x1234 + x*100), G: 0x7654, B: 0xabcd, A: 0xffff})
		}
	}
	precisionFile, err := os.Create(precisionPath)
	must(err)
	must(png.Encode(precisionFile, precision))
	must(precisionFile.Close())
	animationPath := filepath.Join(dir, "Animation.webp")
	animationFile, err := os.Create(animationPath)
	must(err)
	// Synthetic fixture setup only; production image operations use the adapter.
	must(webp.EncodeAll(animationFile, &webp.WEBP{Image: []image.Image{transparent, image.NewNRGBA(transparent.Bounds())}, Delay: []int{120, 240}, LoopCount: 3}, webp.Options{Quality: 85, Method: 4}))
	must(animationFile.Close())
	must(ImagesOpened.Emit(win, []string{precisionPath, animationPath}))
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3`, 60*time.Second))
	must(smokeSelect(win, "Batch preset", "lossless"))
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && document.querySelector('article.batch-item[aria-label="Precision.png"]')?.dataset.outputFormat === 'png' && document.querySelector('article.batch-item[aria-label="Animation.webp"]')?.dataset.outputFormat === 'webp'`, 60*time.Second))
	must(smokeClick(win, "Select Precision.png"))
	must(smokeCapture(win, dir, "lossless-precision.png"))
	must(smokeClick(win, "Select Animation.webp"))
	must(smokeCapture(win, dir, "animation-workbench.png"))
	report.Steps = append(report.Steps, "Lossless preset selected PNG for 16-bit pixels and WebP for animation without discarding frames")
	win.SetSize(920, 600)
	must(smokeWorkbenchFits(win))
	must(smokeCapture(win, dir, "minimum-animation.png"))
	win.SetSize(1120, 760)
	must(smokeSelect(win, "Format for Animation.webp", "png"))
	must(smokeWait(win, `Boolean(document.querySelector('[role="dialog"]')) && document.body.innerText.includes('Export the first frame?')`, 5*time.Second))
	must(smokeCapture(win, dir, "first-frame-confirmation.png"))
	must(smokeClick(win, "Export first frame"))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]') && document.querySelector('select[aria-label="Animation output"]')?.value === 'firstFrame' && document.querySelector('select[aria-label="Format for Animation.webp"]')?.value === 'png' && document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3`, 60*time.Second))
	must(smokeCapture(win, dir, "first-frame-output.png"))
	must(smokeSelect(win, "Animation output", "preserve"))
	must(smokeWait(win, `document.querySelector('select[aria-label="Format for Animation.webp"]')?.value === 'webp' && document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3`, 60*time.Second))
	report.Steps = append(report.Steps, "Animation still export required confirmation, produced PNG, and restored all-frame WebP on request")
	must(smokeClick(win, "Remove Precision.png"))
	must(smokeClick(win, "Remove Animation.webp"))
	for _, transfer := range []byte{16, 18} {
		path := filepath.Join(dir, fmt.Sprintf("HDR-%d.png", transfer))
		must(smokeHDRFixture(path, transfer))
		must(ImagesOpened.Emit(win, []string{path}))
	}
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3`, 60*time.Second))
	must(smokeClick(win, "Select HDR-16.png"))
	must(smokeWait(win, `document.body.innerText.includes('HDR preview and export are tone-mapped') && document.querySelector('select[aria-label="Format for HDR-16.png"]')?.value === 'png'`, 10*time.Second))
	must(smokeClick(win, "Compare HDR-16.png"))
	must(smokeWait(win, `[...document.querySelectorAll('[role="dialog"] img')].filter(x => x.complete && x.naturalWidth === 320 && x.naturalHeight === 160).length === 2 && document.querySelector('[role="dialog"]').innerText.includes('same SDR tone mapping')`, 15*time.Second))
	value, err := smokeEval(win, `const samples = [...document.querySelectorAll('[role="dialog"] img')].map(img => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160; const context = canvas.getContext('2d'); context.drawImage(img, 0, 0); return [...context.getImageData(160, 80, 1, 1).data]; }); return samples.length === 2 && samples[0].every((v, i) => Math.abs(v - samples[1][i]) <= 1) && samples[0][0] > 170;`)
	must(err)
	if value != true {
		panic("HDR comparison and PNG export disagree")
	}
	must(smokeCapture(win, dir, "hdr-sdr-comparison.png"))
	must(smokeClick(win, "Close"))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	win.SetSize(920, 600)
	must(smokeWorkbenchFits(win))
	must(smokeCapture(win, dir, "minimum-hdr.png"))
	win.SetSize(1120, 760)
	must(smokeClick(win, "Select HDR-18.png"))
	must(smokeCapture(win, dir, "hlg-workbench.png"))
	report.Steps = append(report.Steps, "PQ and HLG HDR inputs automatically produced SDR PNG; PQ comparison pixels matched export, and HDR controls fit the minimum window")
	must(smokeClick(win, "Remove HDR-16.png"))
	must(smokeClick(win, "Remove HDR-18.png"))
	must(smokeSelect(win, "Batch preset", "original"))
	must(smokeClick(win, "Select Sample photo.jpg"))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]')) && document.querySelector('select[aria-label="Format for Sample photo.jpg"]')?.value === 'jpg'`, 60*time.Second))

	cancelledValue, err := smokeEval(win, `const call = async (op, request = {}) => JSON.parse(await mygo.call('Backend.Call', op, JSON.stringify(request)));
const run = await call('create_optimizer_run');
const pending = call('compress_image', {taskId:'smoke-cancel',sourcePath:`+smokeJSON(fixture)+`,outputDir:run.data.outputDir,outputFileName:'cancelled.avif',settings:{targetFormat:'avif',quality:100}});
await new Promise(resolve => setTimeout(resolve, 50));
const started = performance.now();
const cancellation = await call('cancel_image_task',{taskId:'smoke-cancel'});
const result = await pending;
return !cancellation.error && result.error?.code === 'cancelled' && performance.now() - started < 3000;`)
	must(err)
	if cancelledValue != true {
		panic("Native codec cancellation did not terminate within three seconds")
	}
	report.Steps = append(report.Steps, "Native cancellation terminated an AVIF image worker within three seconds")

	// Export through the same bound service as the native folder-picker action.
	_, err = smokeEval(win, `const call = async (op, request = {}) => {
const r = JSON.parse(await mygo.call('Backend.Call', op, JSON.stringify(request))); if (r.error) throw Error(r.error.message); return r.data;
};
const run = await call('create_optimizer_run');
const image = await call('compress_image', {sourcePath:`+smokeJSON(fixture)+`, outputDir:run.outputDir, outputFileName:'export.jpg', settings:{targetFormat:'jpg', quality:85}});
const saved = await call('copy_outputs_to_dir', {outputPaths:[image.outputPath], targetDir:`+smokeJSON(filepath.Join(dir, "exports"))+`});
return saved.length === 1;`)
	must(err)
	if _, err := os.Stat(filepath.Join(dir, "exports", "export.jpg")); err != nil {
		panic(err)
	}
	report.Steps = append(report.Steps, "Native bridge exported a processed image to disk")

	must(smokeClick(win, "Upload to S3"))
	must(smokeWait(win, `document.body.innerText.includes('Uploaded 1 image(s)')`, 15*time.Second))
	must(smokeClick(win, "View uploaded images"))
	must(smokeWait(win, `document.querySelector('#app-tab-gallery')?.getAttribute('aria-selected') === 'true' && document.body.innerText.includes('sample-photo')`, 15*time.Second))
	must(smokeWait(win, `document.querySelector('.proof-thumbnail img')?.src.startsWith('data:image/') && document.querySelector('.proof-thumbnail img')?.naturalWidth > 0 && document.querySelector('.proof-thumbnail img')?.naturalWidth <= 384`, 15*time.Second))
	bucket.mu.Lock()
	thumbnailReads, publicReads := bucket.objectReads, bucket.publicReads
	bucket.mu.Unlock()
	if thumbnailReads != 1 || publicReads != 0 {
		panic("Gallery thumbnail did not use authenticated S3 without a public request")
	}
	must(smokeClick(win, "Compress"))
	must(smokeClick(win, "S3 Gallery"))
	must(smokeWait(win, `document.querySelector('.proof-thumbnail img')?.src.startsWith('data:image/') && document.querySelector('.proof-thumbnail img')?.naturalWidth > 0`, 15*time.Second))
	bucket.mu.Lock()
	reused := bucket.objectReads == thumbnailReads && bucket.publicReads == 0
	bucket.mu.Unlock()
	if !reused {
		panic("Reopening the gallery downloaded an image instead of reading the local thumbnail cache")
	}
	report.Steps = append(report.Steps, "Gallery rendered a local thumbnail, reused it on reopening, and made no public image requests")
	must(smokeCapture(win, dir, "gallery.png"))
	bucket.mu.Lock()
	key := ""
	for value := range bucket.objects {
		key = value
	}
	body := append([]byte(nil), bucket.objects[key]...)
	bucket.mu.Unlock()
	if key == "" || len(body) == 0 {
		panic("Gallery did not upload an image")
	}
	report.Steps = append(report.Steps, "Upload action wrote to the local S3 fixture and navigated to the gallery")
	profileValue, err := smokeEval(win, `const r = JSON.parse(await mygo.call('Backend.Call','load_app_settings','{}')); if(r.error) throw Error(r.error.message); return r.data.profiles[0];`)
	must(err)
	profileJSON := smokeJSON(profileValue)
	downloadDir := filepath.Join(dir, "downloads")
	_, err = smokeEval(win, `const r = JSON.parse(await mygo.call('Backend.Call','download_gallery_object',JSON.stringify({profile:`+profileJSON+`,key:`+smokeJSON(key)+`,outputDir:`+smokeJSON(downloadDir)+`}))); if(r.error) throw Error(r.error.message); return r.data;`)
	must(err)
	downloaded, err := os.ReadFile(filepath.Join(downloadDir, filepath.Base(key)))
	must(err)
	if !bytes.Equal(body, downloaded) {
		panic("Downloaded bytes differ from uploaded bytes")
	}
	report.Steps = append(report.Steps, "Downloaded object matches uploaded image bytes")

	clipboard := mygo.Clipboard.ReadText()
	must(smokeClick(win, "Copy URL"))
	deadline := time.Now().Add(5 * time.Second)
	for mygo.Clipboard.ReadText() != server.URL+"/public/"+key && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	copied := mygo.Clipboard.ReadText() == server.URL+"/public/"+key
	mygo.Clipboard.WriteText(clipboard)
	if !copied {
		panic("Copy URL did not reach the native clipboard")
	}
	report.Steps = append(report.Steps, "Gallery copied the public URL through the native clipboard")
	must(smokeClick(win, "Delete"))
	must(smokeWait(win, `Boolean(document.querySelector('[role="alertdialog"]'))`, 5*time.Second))
	_, err = smokeEval(win, `const dialog = document.querySelector('[role="alertdialog"]'); const button = [...dialog.querySelectorAll('button')].find(x => x.textContent.trim() === 'Delete'); if(!button) throw Error('Missing delete confirmation'); button.click(); return true;`)
	must(err)
	must(smokeWait(win, `!document.querySelector('[role="alertdialog"]') && !document.body.innerText.includes('sample-photo')`, 10*time.Second))
	bucket.mu.Lock()
	empty := len(bucket.objects) == 0
	bucket.mu.Unlock()
	if !empty {
		panic("Delete action did not remove the fixture object")
	}
	report.Steps = append(report.Steps, "Gallery delete confirmation removed the local fixture object")
	must(smokeClick(win, "Compress"))
	win.SetSize(920, 600)
	must(smokeWorkbenchFits(win))
	must(smokeCapture(win, dir, "minimum-window.png"))
	report.Steps = append(report.Steps, "Compression actions and image preview fit the minimum 920 x 600 window without overlap")
	_, err = smokeEval(win, `document.documentElement.classList.add('dark'); document.documentElement.style.colorScheme = 'dark'; return true;`)
	must(err)
	must(smokeCapture(win, dir, "dark-theme.png"))
	_, err = smokeEval(win, `document.documentElement.classList.remove('dark'); document.documentElement.style.colorScheme = 'light'; return true;`)
	must(err)
	must(smokeCapture(win, dir, "light-theme.png"))
	win.SetSize(1480, 900)
	must(smokeWait(win, `innerWidth >= 1420 && getComputedStyle(document.querySelector('.bench-body')).gridTemplateColumns.split(' ').length === 3`, 5*time.Second))
	must(smokeCapture(win, dir, "wide-workbench.png"))
	report.Steps = append(report.Steps, "Wide window rendered the three-column image workbench")
	// Exercise real language selection and layout with populated compression results.
	win.SetSize(920, 600)
	for _, locale := range []string{"zh-CN", "en", "fr", "es", "ja", "ko"} {
		_, err = smokeEval(win, `document.getElementById('app-tab-settings').click(); return true;`)
		must(err)
		must(smokeWait(win, `document.getElementById('app-tab-settings').getAttribute('aria-pressed') === 'true'`, 5*time.Second))
		_, err = smokeEval(win, `document.getElementById('settings-tab-general').click(); return true;`)
		must(err)
		_, err = smokeEval(win, `const select = document.querySelector('.settings-page option[value="system"]').parentElement; select.value = `+smokeJSON(locale)+`; select.dispatchEvent(new Event('change', {bubbles:true})); return true;`)
		must(err)
		must(smokeWait(win, `document.documentElement.lang === `+smokeJSON(locale), 5*time.Second))
		must(smokeWait(win, `[...document.querySelectorAll('.settings-sidebar [role="tab"]')].every(x => x.getBoundingClientRect().right <= document.querySelector('.settings-sidebar').getBoundingClientRect().right + 1)`, 5*time.Second))
		must(smokeSettingsPreferencesFit(win))
		must(smokeCapture(win, dir, "settings-"+locale+".png"))
		if locale == "zh-CN" {
			win.SetSize(1120, 820)
			must(smokeWait(win, `innerWidth >= 1080 && innerHeight >= 600`, 5*time.Second))
			must(smokeSettingsPreferencesFit(win))
			must(smokeCapture(win, dir, "settings-general-zh-CN.png"))
			win.SetSize(1920, 900)
			must(smokeWait(win, `innerWidth >= 1900 && innerHeight >= 600`, 5*time.Second))
			must(smokeSettingsPreferencesFit(win))
			must(smokeCapture(win, dir, "settings-general-wide-zh-CN.png"))
			win.SetSize(920, 600)
			must(smokeWait(win, `innerWidth <= 925 && innerHeight <= 605`, 5*time.Second))
		}
		_, err = smokeEval(win, `document.getElementById('app-tab-optimize').click(); return true;`)
		must(err)
		must(smokeWorkbenchFits(win))
		must(smokeCapture(win, dir, "workbench-"+locale+".png"))
	}
	report.Steps = append(report.Steps, "All six languages switched through Settings and fit the populated minimum-size workbench")
	report.Steps = append(report.Steps, "General preference rows align visible controls and Save with the viewport's right inset in all six languages at minimum size and in English/Chinese at 1920px width, with 14px field titles, 12px descriptions and 36px inputs")

	// Exercise a long gallery with real IntersectionObserver clipping and a
	// held thumbnail response, so skeleton and lazy-mount checks are deterministic.
	_, err = smokeEval(win, `localStorage.setItem('pic-piper.language', 'en'); window.dispatchEvent(new StorageEvent('storage', {key:'pic-piper.language'})); return true;`)
	must(err)
	gate := make(chan struct{})
	release := sync.OnceFunc(func() { close(gate) })
	defer release()
	seedPath := filepath.Join(dir, "Gallery seed.jpg")
	must(os.WriteFile(seedPath, body, 0600))
	_, err = smokeEval(win, `for (let index = 0; index < 80; index++) {
      const response = JSON.parse(await mygo.call('Backend.Call','upload_gallery_object', JSON.stringify({ profile: `+profileJSON+`, sourcePath: `+smokeJSON(seedPath)+`, objectKey: 'images/lazy-' + String(index).padStart(3, '0') + '.jpg', outputFilename: 'Photo-' + String(index).padStart(3, '0') + '.jpg' })));
      if (response.error || response.data.uploadRecordWarning) throw Error('Could not seed local upload history');
    } return true;`)
	must(err)
	bucket.mu.Lock()
	bucket.thumbnailGate = gate
	bucket.objects["images/unrelated.jpg"] = body
	bucket.mu.Unlock()
	win.SetSize(1120, 760)
	must(smokeClick(win, "S3 Gallery"))
	must(smokeWait(win, `document.querySelectorAll('.contact-sheet > [data-lazy-render]').length === 80 && document.querySelectorAll('.contact-sheet > [data-lazy-render="mounted"]').length > 0 && document.querySelector('.proof-thumbnail [data-slot="skeleton"]') !== null`, 15*time.Second))
	value, err = smokeEval(win, `return document.querySelectorAll('.contact-sheet > [data-lazy-render="mounted"]').length < 40 && document.querySelectorAll('.proof-thumbnail').length < 40;`)
	must(err)
	if value != true {
		panic("Offscreen gallery cards mounted heavy content")
	}
	must(smokeCapture(win, dir, "gallery-skeleton.png"))
	release()
	must(smokeWait(win, `document.querySelector('.proof-thumbnail img')?.naturalWidth > 0`, 15*time.Second))
	_, err = smokeEval(win, `const scroll = document.querySelector('.workspace-scroll'); scroll.scrollTop = scroll.scrollHeight; return true;`)
	must(err)
	must(smokeWait(win, `document.querySelector('.contact-sheet > li:last-child')?.dataset.lazyRender === 'mounted' && document.querySelector('.contact-sheet > li:first-child')?.dataset.lazyRender === 'placeholder' && document.querySelectorAll('.proof-thumbnail').length < 40`, 10*time.Second))
	must(smokeCapture(win, dir, "gallery-lazy-bottom.png"))
	for _, order := range []string{"name-asc", "name-desc", "time-asc", "time-desc"} {
		must(smokeSelect(win, "Sort by", order))
		expected := "images/lazy-000.jpg"
		if order == "name-desc" || order == "time-desc" {
			expected = "images/lazy-079.jpg"
		}
		must(smokeWait(win, `document.querySelector('.contact-sheet > li')?.getAttribute('aria-label') === `+smokeJSON(expected)+` && document.querySelectorAll('.contact-sheet > li').length === 80`, 10*time.Second))
	}
	_, err = smokeEval(win, `document.querySelector('.workspace-scroll').scrollTop = 0; return true;`)
	must(err)
	must(smokeWait(win, `document.querySelector('.contact-sheet > li:first-child')?.dataset.lazyRender === 'mounted' && document.querySelector('.proof-name') !== null`, 5*time.Second))
	must(smokeCapture(win, dir, "gallery-sorted.png"))
	must(smokeClick(win, "Filters"))
	must(smokeSelect(win, "Format", "png"))
	must(smokeWait(win, `document.body.innerText.includes('No loaded images match these filters.') && document.querySelectorAll('.contact-sheet > li').length === 0`, 5*time.Second))
	must(smokeCapture(win, dir, "gallery-filter-empty.png"))
	must(smokeClick(win, "Reset filters"))
	must(smokeWait(win, `document.querySelectorAll('.contact-sheet > li').length === 80`, 5*time.Second))
	must(smokeCapture(win, dir, "gallery-filters.png"))
	must(smokeClick(win, "List view"))
	must(smokeWait(win, `document.querySelector('.contact-sheet.gallery-list') !== null`, 5*time.Second))
	must(smokeCapture(win, dir, "gallery-list.png"))
	must(smokeClick(win, "Grid view"))
	report.Steps = append(report.Steps, "Gallery filters narrowed loaded records, reset restored them, and grid/list presentations rendered")
	report.Steps = append(report.Steps, "Gallery excluded an unrelated bucket object and sorted all local uploads by name and upload time in both directions")
	report.Steps = append(report.Steps, "80 gallery cards lazy-mounted near the viewport, unloaded on scroll, and showed skeletons during held thumbnail reads")

	must(smokeClick(win, "Compress"))
	batchPaths := []string{}
	for index := range 40 {
		path := filepath.Join(dir, fmt.Sprintf("Batch-%03d.jpg", index))
		must(os.WriteFile(path, body, 0600))
		batchPaths = append(batchPaths, path)
	}
	must(ImagesOpened.Emit(win, batchPaths))
	must(smokeWait(win, `document.querySelectorAll('.batch-list > [data-lazy-render]').length >= 40 && document.querySelectorAll('.batch-list > [data-lazy-render="mounted"]').length < 25`, 15*time.Second))
	_, err = smokeEval(win, `const list = document.querySelector('.batch-list'); list.scrollTop = list.scrollHeight; return true;`)
	must(err)
	must(smokeWait(win, `document.querySelector('.batch-list > [data-lazy-render]:last-child')?.dataset.lazyRender === 'mounted' && document.querySelector('.batch-list > [data-lazy-render]:first-child')?.dataset.lazyRender === 'placeholder'`, 10*time.Second))
	must(smokeCapture(win, dir, "batch-lazy-bottom.png"))
	report.Steps = append(report.Steps, "Long compression batch mounted only nearby cards and retained scroll placeholders")

	must(smokeMini(backend, dir, bucket))
	report.Steps = append(report.Steps, "Mini supports selection, on-demand upload sheets, same-bucket skips, four clipboard link formats, clear/undo without changing gallery objects, and fixed controls in all six languages")
	report.Steps = append(report.Steps, "Mini: native status icon drop adapter installed; persistent flyout, background image clipboard, S3 upload, four link formats and reopen verified")
	must(smokeWindowCloseBehavior(win, backend))
	report.Steps = append(report.Steps, "Native main-window close uses the independent background preference, is forced to background by a live status icon, and requests application quit by default")

	// Check the packaged scheme through Launch Services, rather than treating
	// the Info.plist declaration alone as proof of native URL integration.
	// Wait for AppKit's did-miniaturize notification, not only the early
	// isMiniaturized flag, before asking Launch Services to restore the window.
	minimized := make(chan struct{}, 1)
	offMinimize := win.OnMinimize(func() {
		select {
		case minimized <- struct{}{}:
		default:
		}
	})
	defer offMinimize()
	win.Minimize()
	select {
	case <-minimized:
	case <-time.After(5 * time.Second):
		panic("Window minimization did not finish")
	}
	deadline = time.Now().Add(5 * time.Second)
	for !win.IsMinimized() && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !win.IsMinimized() {
		panic("Could not minimize the window for the app-return test")
	}
	receivedURL := make(chan struct{}, 1)
	offURL := mygo.App.OnOpenURL(func(raw string) {
		if isCloudflareReturnURL(raw) {
			select {
			case receivedURL <- struct{}{}:
			default:
			}
		}
	})
	defer offURL()
	must(mygo.Shell.OpenExternal("picpiper://oauth/cloudflare/connected"))
	deadline = time.Now().Add(8 * time.Second)
	for (win.IsMinimized() || !win.IsFocused()) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if win.IsMinimized() || !win.IsFocused() {
		received := false
		select {
		case <-receivedURL:
			received = true
		default:
		}
		panic(fmt.Sprintf("App URL scheme did not restore and focus Pic Piper (received=%t, minimized=%t, focused=%t, active=%t)", received, win.IsMinimized(), win.IsFocused(), mygo.App.IsActive()))
	}
	report.Steps = append(report.Steps, "OS app URL scheme restored and focused the existing Pic Piper window")

	html, err := os.ReadFile(filepath.Join(dir, "oauth-connected.html"))
	must(err)
	win.SetSize(760, 900)
	win.Page().LoadHTML(string(html), "http://127.0.0.1:19827/oauth/cloudflare/callback")
	must(smokeWait(win, `document.querySelectorAll('.languages p[lang]').length === 6 && document.querySelector('a')?.href === 'picpiper://oauth/cloudflare/connected'`, 10*time.Second))
	must(smokeCapture(win, dir, "oauth-connected.png"))
	report.Steps = append(report.Steps, "OAuth completion HTML displayed all six languages and a manual app-return link")

	report.Passed = true
}

func smokeWorkbenchFits(win *mygo.Window) error {
	return smokeWait(win, `(() => { const actions = document.querySelector('.bench-actions')?.getBoundingClientRect(); const preview = document.querySelector('.stage-canvas')?.getBoundingClientRect(); const caption = document.querySelector('.stage-readout')?.getBoundingClientRect(); const workbench = document.querySelector('.bench-body')?.getBoundingClientRect(); return actions && preview && caption && workbench && actions.bottom <= innerHeight + 1 && preview.height >= 100 && caption.bottom <= actions.top && caption.bottom <= workbench.bottom; })()`, 5*time.Second)
}

func smokeHDRFixture(path string, transfer byte) error {
	img := image.NewNRGBA64(image.Rect(0, 0, 320, 160))
	for y := 0; y < 160; y++ {
		for x := 0; x < 320; x++ {
			v := uint16(x * 65535 / 319)
			img.SetNRGBA64(x, y, color.NRGBA64{R: v, G: v, B: v, A: 65535})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return err
	}
	chunk := binary.BigEndian.AppendUint32(nil, 4)
	chunk = append(chunk, []byte{'c', 'I', 'C', 'P', 9, transfer, 0, 1}...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	data := append([]byte{}, buffer.Bytes()[:33]...)
	data = append(data, chunk...)
	data = append(data, buffer.Bytes()[33:]...)
	return os.WriteFile(path, data, 0600)
}

func smokeEval(win *mygo.Window, code string) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	value, err := win.Page().EvalContext(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("evaluate %s: %w", code[:min(len(code), 120)], err)
	}
	return value, nil
}

func smokeJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func smokeClick(win *mygo.Window, label string) error {
	if name, ok := strings.CutPrefix(label, "Select "); ok {
		_, err := smokeEval(win, `const item = [...document.querySelectorAll('.batch-list > [data-lazy-render]')].find(x => x.getAttribute('aria-label') === `+smokeJSON(name)+`); item?.scrollIntoView({block:'nearest'}); return true;`)
		if err != nil {
			return err
		}
		if err = smokeWait(win, `Boolean([...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === `+smokeJSON(label)+`))`, 5*time.Second); err != nil {
			return err
		}
	}
	_, err := smokeEval(win, `const name = `+smokeJSON(label)+`;
const button = [...document.querySelectorAll('button,[role="switch"]')].find(x => !x.disabled && (x.getAttribute('aria-label') === name || x.textContent.trim() === name));
if (!button) throw Error('Missing enabled action: ' + name); button.click(); return true;`)
	return err
}

func smokeSelect(win *mygo.Window, label, value string) error {
	if name, ok := strings.CutPrefix(label, "Format for "); ok {
		if err := smokeClick(win, "Select "+name); err != nil {
			return err
		}
		if _, err := smokeEval(win, `const details = document.querySelector('details.image-format-details'); if (!details) throw Error('Missing current image format details'); details.open = true; return true;`); err != nil {
			return err
		}
	}
	_, err := smokeEval(win, `const select = [...document.querySelectorAll('select')].find(x => x.getAttribute('aria-label') === `+smokeJSON(label)+`); if (!select) throw Error('Missing selector'); select.value = `+smokeJSON(value)+`; select.dispatchEvent(new Event('change', {bubbles:true})); await new Promise(resolve => setTimeout(resolve, 25)); return true;`)
	return err
}

func smokeWait(win *mygo.Window, expression string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		value, err := smokeEval(win, expression)
		if err != nil {
			return err
		}
		if result, ok := value.(bool); ok && result {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	viewport, _ := smokeEval(win, `({width: innerWidth, height: innerHeight, availableWidth: screen.availWidth, availableHeight: screen.availHeight})`)
	return fmt.Errorf("timed out waiting for: %s (viewport: %v)", expression, viewport)
}

func smokeCapture(win *mygo.Window, dir, name string) error {
	win.Show()
	mygo.App.Focus()
	win.Focus()
	fmt.Printf("Capture %s: visible=%t focused=%t active=%t\n", name, win.IsVisible(), win.IsFocused(), mygo.App.IsActive())
	if _, err := smokeEval(win, `new Promise(resolve => setTimeout(() => { document.body.getBoundingClientRect(); resolve(true); }, 200))`); err != nil {
		return err
	}
	data, err := win.CapturePage()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), data, 0600)
}

func smokeFixture(path string) error {
	img := image.NewRGBA(image.Rect(0, 0, 1200, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 1200; x++ {
			img.SetRGBA(x, y, color.RGBA{R: uint8(30 + x*160/1200), G: uint8(65 + y*120/800), B: uint8(150 + (x+y)%80), A: 255})
		}
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	err = jpeg.Encode(file, img, &jpeg.Options{Quality: 98})
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}

type smokeBucket struct {
	thumbnailGate <-chan struct{}
	objectReads   int
	putAttempts   int
	putCount      int
	publicReads   int
	mu            sync.Mutex
	objects       map[string][]byte
	uploadIDs     map[string]string
}

func (bucket *smokeBucket) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	key := strings.TrimPrefix(req.URL.Path, "/mvp-images/")
	if strings.HasPrefix(req.URL.Path, "/public/") {
		key = strings.TrimPrefix(req.URL.Path, "/public/")
		bucket.publicReads++
	} else if !strings.HasPrefix(req.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if req.Method == http.MethodGet && req.URL.Query().Get("list-type") == "2" {
		type object struct {
			Key          string `xml:"Key"`
			Size         int    `xml:"Size"`
			LastModified string `xml:"LastModified"`
			ETag         string `xml:"ETag"`
		}
		response := struct {
			XMLName     xml.Name `xml:"ListBucketResult"`
			IsTruncated bool     `xml:"IsTruncated"`
			Contents    []object `xml:"Contents"`
		}{}
		for name, body := range bucket.objects {
			if strings.HasPrefix(name, req.URL.Query().Get("prefix")) {
				response.Contents = append(response.Contents, object{name, len(body), "2026-01-01T00:00:00Z", fmt.Sprintf("\"%x\"", sha256.Sum256(body))})
			}
		}
		w.Header().Set("Content-Type", "application/xml")
		_ = xml.NewEncoder(w).Encode(response)
		return
	}
	switch req.Method {
	case http.MethodPut:
		bucket.putAttempts++
		if req.Header.Get("If-None-Match") != "*" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if _, exists := bucket.objects[key]; exists {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, 16<<20))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		bucket.putCount++
		bucket.objects[key] = body
		if bucket.uploadIDs == nil {
			bucket.uploadIDs = map[string]string{}
		}
		bucket.uploadIDs[key] = req.Header.Get("X-Amz-Meta-Picpiper-Upload-Id")
		w.Header().Set("ETag", fmt.Sprintf("\"%x\"", sha256.Sum256(body)))
	case http.MethodHead:
		body, exists := bucket.objects[key]
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("X-Amz-Meta-Picpiper-Upload-Id", bucket.uploadIDs[key])
		w.Header().Set("ETag", fmt.Sprintf("\"%x\"", sha256.Sum256(body)))
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	case http.MethodGet:
		if gate := bucket.thumbnailGate; gate != nil {
			bucket.mu.Unlock()
			select {
			case <-gate:
			case <-req.Context().Done():
			}
			bucket.mu.Lock()
		}
		bucket.objectReads++
		body, exists := bucket.objects[key]
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(body)
	case http.MethodDelete:
		delete(bucket.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
