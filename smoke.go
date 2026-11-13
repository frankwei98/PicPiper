package main

import (
	"bytes"
	"context"
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
func runSmoke(win *mygo.Window, dir string) {
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
	must(smokeWait(win, `Boolean(window.mygo && document.querySelector('[role="tab"]'))`, 15*time.Second))
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
	must(smokeCapture(win, dir, "workspace.png"))
	report.Steps = append(report.Steps, "Packaged frontend and native runtime loaded")

	bucket := &smokeBucket{objects: map[string][]byte{}}
	server := httptest.NewServer(bucket)
	defer server.Close()
	must(smokeClick(win, "Settings"))
	must(smokeWait(win, `Boolean([...document.querySelectorAll('label')].find(x => x.textContent.trim().startsWith('Profile name')))`, 5*time.Second))
	fields := [][2]string{{"Profile name", "MVP local bucket"}, {"Endpoint", server.URL}, {"Region", "us-east-1"}, {"Bucket", "mvp-images"}, {"Access key ID", "MVP-TEST-ACCESS"}, {"Secret access key", "local-test-secret"}, {"Public Base URL", server.URL + "/public"}, {"Default prefix", "images"}}
	for _, field := range fields {
		label, value := smokeJSON(field[0]), smokeJSON(field[1])
		_, err := smokeEval(win, `const label = [...document.querySelectorAll('label')].find(x => x.textContent.trim().startsWith(`+label+`));
const input = label?.querySelector('input'); if (!input) throw Error('Missing field ' + `+label+`);
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, `+value+`);
input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
await new Promise(resolve => setTimeout(resolve, 25)); return true;`)
		must(err)
	}
	must(smokeClick(win, "Test connection"))
	must(smokeWait(win, `document.body.innerText.includes('Connection successful')`, 10*time.Second))
	must(smokeClick(win, "Save profile"))
	must(smokeWait(win, `document.body.innerText.includes('Profile saved.')`, 10*time.Second))
	must(smokeCapture(win, dir, "settings.png"))
	report.Steps = append(report.Steps, "Settings form tested a draft S3 connection and saved the profile")

	fixture := filepath.Join(dir, "Sample photo.jpg")
	must(smokeFixture(fixture))
	// Open With is app-wide, including while the settings page is active.
	must(ImagesOpened.Emit(win, []string{fixture}))
	must(smokeClick(win, "Compress"))
	must(smokeWait(win, `Boolean(document.querySelector('[data-testid="image-drop-zone"]'))`, 5*time.Second))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Sample photo.jpg"]'))`, 15*time.Second))
	must(smokeCapture(win, dir, "compressed.png"))
	report.Steps = append(report.Steps, "Native file-open event received in Settings imported an image and completed compression")
	galleryFixture := filepath.Join(dir, "Opened from gallery.jpg")
	must(smokeFixture(galleryFixture))
	must(smokeClick(win, "S3 Gallery"))
	must(ImagesOpened.Emit(win, []string{galleryFixture}))
	must(smokeClick(win, "Compress"))
	must(smokeWait(win, `Boolean(document.querySelector('button[aria-label="Compare Opened from gallery.jpg"]'))`, 15*time.Second))
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
		_, err = smokeEval(win, `const select = document.querySelector('select[aria-label="Format for Sample photo.jpg"]'); if (!select) throw Error('Missing output format selector'); select.value = `+smokeJSON(format)+`; select.dispatchEvent(new Event('change', {bubbles:true})); await new Promise(resolve => setTimeout(resolve, 25)); return true;`)
		must(err)
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
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && [...document.querySelectorAll('.batch-item select')].every(x => x.value === 'webp')`, 60*time.Second))
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
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && document.querySelector('select[aria-label="Longest edge"]')?.value === '0' && [...document.querySelectorAll('.batch-item select')].every(x => x.value === 'jxl')`, 60*time.Second))
	must(smokeClick(win, "Compare Sample photo.jpg"))
	must(smokeWait(win, `[...document.querySelectorAll('[role="dialog"] img')].filter(x => x.complete && x.naturalWidth === 1200 && x.naturalHeight === 800).length === 2 && document.querySelector('[role="dialog"]').innerText.includes('Quality: 100')`, 30*time.Second))
	must(smokeClick(win, "Close"))
	must(smokeWait(win, `!document.querySelector('[role="dialog"]')`, 5*time.Second))
	report.Steps = append(report.Steps, "Batch presets applied to all formats; 960px resize kept aspect ratio and lossless preset restored full dimensions")
	must(smokeClick(win, "Remove Transparent logo.png"))
	must(smokeClick(win, "Remove Imported HEIC.heic"))
	must(smokeSelect(win, "Batch preset", "original"))
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
	must(smokeWait(win, `document.querySelectorAll('.batch-item button[aria-label^="Compare "]').length === 3 && document.querySelector('select[aria-label="Format for Precision.png"]')?.value === 'png' && document.querySelector('select[aria-label="Format for Animation.webp"]')?.value === 'webp'`, 60*time.Second))
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
	_, err = smokeEval(win, `document.documentElement.classList.remove('dark'); return true;`)
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
		must(smokeWait(win, `document.getElementById('app-tab-settings').getAttribute('aria-selected') === 'true'`, 5*time.Second))
		_, err = smokeEval(win, `const select = document.querySelector('.settings-page option[value="system"]').parentElement; select.value = `+smokeJSON(locale)+`; select.dispatchEvent(new Event('change', {bubbles:true})); return true;`)
		must(err)
		must(smokeWait(win, `document.documentElement.lang === `+smokeJSON(locale), 5*time.Second))
		must(smokeCapture(win, dir, "settings-"+locale+".png"))
		_, err = smokeEval(win, `document.getElementById('app-tab-optimize').click(); return true;`)
		must(err)
		must(smokeWorkbenchFits(win))
		must(smokeCapture(win, dir, "workbench-"+locale+".png"))
	}
	report.Steps = append(report.Steps, "All six languages switched through Settings and fit the populated minimum-size workbench")

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
	_, err := smokeEval(win, `const name = `+smokeJSON(label)+`;
const button = [...document.querySelectorAll('button')].find(x => !x.disabled && (x.getAttribute('aria-label') === name || x.textContent.trim() === name));
if (!button) throw Error('Missing enabled action: ' + name); button.click(); return true;`)
	return err
}

func smokeSelect(win *mygo.Window, label, value string) error {
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
	return fmt.Errorf("timed out waiting for: %s", expression)
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
	mu      sync.Mutex
	objects map[string][]byte
}

func (bucket *smokeBucket) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	key := strings.TrimPrefix(req.URL.Path, "/mvp-images/")
	if strings.HasPrefix(req.URL.Path, "/public/") {
		key = strings.TrimPrefix(req.URL.Path, "/public/")
	} else if !strings.HasPrefix(req.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if req.Method == http.MethodGet && req.URL.Query().Get("list-type") == "2" {
		type object struct {
			Key          string `xml:"Key"`
			Size         int    `xml:"Size"`
			LastModified string `xml:"LastModified"`
		}
		response := struct {
			XMLName     xml.Name `xml:"ListBucketResult"`
			IsTruncated bool     `xml:"IsTruncated"`
			Contents    []object `xml:"Contents"`
		}{}
		for name, body := range bucket.objects {
			if strings.HasPrefix(name, req.URL.Query().Get("prefix")) {
				response.Contents = append(response.Contents, object{name, len(body), time.Now().UTC().Format(time.RFC3339)})
			}
		}
		w.Header().Set("Content-Type", "application/xml")
		_ = xml.NewEncoder(w).Encode(response)
		return
	}
	switch req.Method {
	case http.MethodPut:
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
		bucket.objects[key] = body
	case http.MethodGet:
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
