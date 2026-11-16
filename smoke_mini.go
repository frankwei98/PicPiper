package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

func smokeMini(backend *Backend, dir string, bucket *smokeBucket) (resultErr error) {
	var panel *mygo.Window
	defer func() {
		if resultErr != nil && panel != nil && panel.IsVisible() {
			_ = smokeCapture(panel, dir, "mini-failure.png")
			if body, err := smokeEval(panel, "document.body.innerText"); err == nil {
				text := fmt.Sprint(body)
				if len(text) > 1200 {
					text = text[:1200]
				}
				resultErr = fmt.Errorf("%w\nMini: %s", resultErr, text)
			}
		}
	}()
	var nativeErr error
	show := func() { mygo.RunOnMain(func() { backend.desktop.showPanel(); panel = backend.desktop.panel }) }
	counts := func() (int, int, int) {
		bucket.mu.Lock()
		defer bucket.mu.Unlock()
		return bucket.putAttempts, bucket.putCount, len(bucket.objects)
	}
	waitCopy := func(sequence uint64) error {
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			snapshot := backend.mini.Snapshot()
			if !snapshot.Busy && snapshot.CopySequence > sequence {
				return nil
			}
			time.Sleep(50 * time.Millisecond)
		}
		return fmt.Errorf("Mini clipboard action did not finish")
	}
	click := func(label string) error {
		if err := smokeWait(panel, `Boolean([...document.querySelectorAll('button,[role="switch"]')].find(x=>!x.disabled&&(x.getAttribute('aria-label')===`+smokeJSON(label)+`||x.textContent.trim()===`+smokeJSON(label)+`)))`, 5*time.Second); err != nil {
			return err
		}
		return smokeClick(panel, label)
	}
	language := func(locale string) error {
		_, err := smokeEval(panel, `localStorage.setItem('pic-piper.language',`+smokeJSON(locale)+`);window.dispatchEvent(new StorageEvent('storage',{key:'pic-piper.language'}));return true;`)
		if err != nil {
			return err
		}
		return smokeWait(panel, `document.documentElement.lang===`+smokeJSON(locale), 5*time.Second)
	}
	uploadDialog := func(name string) error {
		if err := click("Upload " + name + " to S3"); err != nil {
			return err
		}
		return smokeWait(panel, `Boolean(document.querySelector('.mini-upload-dialog select:not(:disabled)'))`, 5*time.Second)
	}
	mygo.RunOnMain(func() {
		if backend.desktop.tray == nil || backend.desktop.detachDrop == nil {
			nativeErr = fmt.Errorf("Mini native integration unavailable: %s", backend.desktop.trayError)
		}
	})
	if nativeErr != nil {
		return nativeErr
	}
	show()
	if panel == nil {
		return fmt.Errorf("Mini did not create a panel")
	}
	if err := smokeWait(panel, `Boolean(document.querySelector('[data-testid="mini-drop-zone"]'))`, 10*time.Second); err != nil {
		return err
	}
	if err := language("en"); err != nil {
		return err
	}
	if _, err := smokeEval(panel, `if(document.querySelector('.mini-tag,.mini-recipe,.mini-upload-all,.mini-upload-options,.mini-note'))throw Error('Old Mini controls remain');if(!document.querySelector('.mini-header .mini-format'))throw Error('Compression controls are not in the header');return true;`); err != nil {
		return err
	}
	if err := smokeCapture(panel, dir, "mini-idle.png"); err != nil {
		return err
	}
	if err := smokeMiniCompressionSync(panel, backend, dir); err != nil {
		return err
	}
	mygo.RunOnMain(func() { backend.desktop.main.Focus() })
	if !panel.IsVisible() {
		return fmt.Errorf("Mini disappeared when returning to Finder")
	}
	fixture := filepath.Join(dir, "Mini photo.jpg")
	if err := smokeFixture(fixture); err != nil {
		return err
	}
	beforeAttempts, beforeWrites, _ := counts()
	sequence := backend.mini.Snapshot().CopySequence
	if err := backend.mini.Add([]string{fixture}); err != nil {
		return err
	}
	if err := waitCopy(sequence); err != nil {
		return err
	}
	before := backend.mini.Snapshot().Items[0]
	if before.URL != "" || before.UploadStatus != "" || len(mygo.Clipboard.ReadImage()) == 0 {
		return fmt.Errorf("drop must only compress and copy image pixels")
	}
	if attempts, writes, _ := counts(); attempts != beforeAttempts || writes != beforeWrites {
		return fmt.Errorf("drop uploaded without an upload click")
	}
	if err := smokeWait(panel, `document.querySelectorAll('.mini-item').length===1`, 5*time.Second); err != nil {
		return err
	}
	if err := smokeCapture(panel, dir, "mini-image-copied.png"); err != nil {
		return err
	}
	exportDir := filepath.Join(dir, "mini-exports")
	if err := os.MkdirAll(exportDir, 0700); err != nil {
		return err
	}
	existing := filepath.Join(exportDir, before.OutputName)
	if err := os.WriteFile(existing, []byte("existing user file"), 0600); err != nil {
		return err
	}
	exported := backend.Call(context.Background(), "mini_export", smokeJSON(map[string]any{"ids": []string{before.ID}, "targetDir": exportDir}))
	var saved struct {
		Data  []string `json:"data"`
		Error any      `json:"error"`
	}
	if err := json.Unmarshal([]byte(exported), &saved); err != nil {
		return err
	}
	if saved.Error != nil || len(saved.Data) != 1 || saved.Data[0] == existing {
		return fmt.Errorf("Mini export failed to preserve existing file: %s", exported)
	}
	original, err := os.ReadFile(existing)
	if err != nil || string(original) != "existing user file" {
		return fmt.Errorf("Mini export overwrote existing file")
	}
	if info, err := os.Stat(saved.Data[0]); err != nil || info.Size() != before.OutputBytes {
		return fmt.Errorf("Mini saved output size differs")
	}
	if err := uploadDialog(before.OutputName); err != nil {
		return err
	}
	if err := click("Markdown"); err != nil {
		return err
	}
	if err := smokeCapture(panel, dir, "mini-upload-options.png"); err != nil {
		return err
	}
	sequence = backend.mini.Snapshot().CopySequence
	if err := click("Upload and copy links"); err != nil {
		return err
	}
	// Ensure the request reached Go before destroying the short-lived WebView.
	deadline := time.Now().Add(5 * time.Second)
	for backend.mini.Snapshot().Items[0].UploadStatus == "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if backend.mini.Snapshot().Items[0].UploadStatus == "" {
		return fmt.Errorf("upload action never queued")
	}
	mygo.RunOnMain(backend.desktop.closePanel)
	if err := waitCopy(sequence); err != nil {
		return err
	}
	after := backend.mini.Snapshot()
	if len(after.Items) != 1 || after.Items[0].ID != before.ID || after.Items[0].OutputBytes != before.OutputBytes || len(after.Items[0].Uploads) != 1 {
		return fmt.Errorf("upload replaced the compressed result")
	}
	if !strings.HasPrefix(mygo.Clipboard.ReadText(), "![") {
		return fmt.Errorf("Mini did not copy Markdown")
	}
	attemptsAfterUpload, writesAfterUpload, _ := counts()
	if writesAfterUpload != beforeWrites+1 {
		return fmt.Errorf("manual upload did not create exactly one object")
	}
	show()
	if err := smokeWait(panel, `Boolean(document.querySelector('[data-testid="mini-drop-zone"]'))`, 10*time.Second); err != nil {
		return err
	}
	if err := language("en"); err != nil {
		return err
	}
	if err := smokeWait(panel, `Boolean(document.querySelector('.mini-upload-refresh'))`, 10*time.Second); err != nil {
		return err
	}
	for _, format := range []string{"Plain text URL", "HTML", "BBCode", "Markdown"} {
		if err := uploadDialog(before.OutputName); err != nil {
			return err
		}
		if err := click(format); err != nil {
			return err
		}
		sequence = backend.mini.Snapshot().CopySequence
		if err := click("Copy existing links"); err != nil {
			return err
		}
		if err := waitCopy(sequence); err != nil {
			return err
		}
		if err := smokeWait(panel, `!document.querySelector('[role="dialog"]')`, 5*time.Second); err != nil {
			return err
		}
		text := mygo.Clipboard.ReadText()
		prefix := "http://"
		switch format {
		case "HTML":
			prefix = "<img "
		case "BBCode":
			prefix = "[img]"
		case "Markdown":
			prefix = "!["
		}
		if !strings.HasPrefix(text, prefix) {
			return fmt.Errorf("Mini link format %s failed", format)
		}
		if attempts, writes, _ := counts(); attempts != attemptsAfterUpload || writes != writesAfterUpload {
			return fmt.Errorf("same bucket uploaded again")
		}
	}
	if err := smokeCapture(panel, dir, "mini-uploaded.png"); err != nil {
		return err
	}
	if err := click("Copy image " + before.OutputName); err != nil {
		return err
	}
	if err := smokeWait(panel, `document.body.innerText.includes('Image copied to clipboard')`, 5*time.Second); err != nil {
		return err
	}
	if len(mygo.Clipboard.ReadImage()) == 0 {
		return fmt.Errorf("uploaded result lost image copying")
	}
	paths := make([]string, 10)
	for n := range paths {
		paths[n] = fixture
	}
	sequence = backend.mini.Snapshot().CopySequence
	if err := backend.mini.Add(paths); err != nil {
		return err
	}
	if err := waitCopy(sequence); err != nil {
		return err
	}
	if err := smokeWait(panel, `document.querySelectorAll('.mini-item').length===11&&[...document.querySelectorAll('.mini-item input[type="checkbox"]')].every(x=>!x.disabled)`, 10*time.Second); err != nil {
		return err
	}
	if _, err := smokeEval(panel, `const list=document.querySelector('.mini-results-scroll'),d=document.scrollingElement;if(d.scrollHeight>d.clientHeight+1||d.scrollWidth>d.clientWidth+1)throw Error('Mini has a document scrollbar');if(list.scrollHeight<=list.clientHeight)throw Error('History did not overflow independently');window.miniFixedPositions=['.mini-header','.mini-drop','.mini-results-head','.mini-retention'].map(s=>document.querySelector(s).getBoundingClientRect().top);list.scrollTop=list.scrollHeight;return true;`); err != nil {
		return err
	}
	if _, err := smokeEval(panel, `const actual=['.mini-header','.mini-drop','.mini-results-head','.mini-retention'].map(s=>document.querySelector(s).getBoundingClientRect().top);if(actual.some((y,n)=>Math.abs(y-window.miniFixedPositions[n])>1))throw Error('Fixed controls moved');return true;`); err != nil {
		return err
	}
	geometry, err := smokeEval(panel, `const d=document.scrollingElement,l=document.querySelector('.mini-results-scroll');return {width:d.clientWidth,height:d.clientHeight,documentScrollWidth:d.scrollWidth,documentScrollHeight:d.scrollHeight,listHeight:l.clientHeight,listScrollHeight:l.scrollHeight};`)
	if err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(geometry, "", "  ")
	if err = os.WriteFile(filepath.Join(dir, "mini-scroll-geometry.json"), raw, 0600); err != nil {
		return err
	}
	if _, err = smokeEval(panel, `document.querySelector('input[aria-label="Select all recent results"]').click();return true;`); err != nil {
		return err
	}
	if err = click("Upload selected"); err != nil {
		return err
	}
	if err = smokeWait(panel, `document.body.innerText.includes('Upload 10 and copy links')`, 5*time.Second); err != nil {
		return err
	}
	// All supported locales must keep the selected header and mixed upload sheet
	// inside the same fixed viewport, including long action labels.
	for _, locale := range []string{"en", "zh-CN", "ja", "ko", "es", "fr"} {
		if err = language(locale); err != nil {
			return err
		}
		if _, err = smokeEval(panel, `const d=document.scrollingElement,p=document.querySelector('.mini-dialog').getBoundingClientRect(),format=document.querySelector('.mini-format').getBoundingClientRect(),actions=document.querySelector('.mini-window-actions').getBoundingClientRect();if(d.scrollWidth>d.clientWidth+1||d.scrollHeight>d.clientHeight+1||p.left<0||p.right>innerWidth+1||p.top<0||p.bottom>innerHeight+1||format.right>actions.left+1)throw Error('Translated Mini overflows');return true;`); err != nil {
			return err
		}
		if locale == "zh-CN" {
			if err = smokeCapture(panel, dir, "mini-upload-mixed-zh-CN.png"); err != nil {
				return err
			}
		}
	}
	if err = language("en"); err != nil {
		return err
	}
	sequence = backend.mini.Snapshot().CopySequence
	if err = click("Upload 10 and copy links"); err != nil {
		return err
	}
	if err = waitCopy(sequence); err != nil {
		return err
	}
	if err = smokeWait(panel, `!document.querySelector('[role="dialog"]')`, 5*time.Second); err != nil {
		return err
	}
	if _, writes, _ := counts(); writes != writesAfterUpload+10 {
		return fmt.Errorf("selection upload did not skip its existing object")
	}
	if len(strings.Split(mygo.Clipboard.ReadText(), "\n")) != 11 {
		return fmt.Errorf("selection did not copy all eleven links")
	}
	_, _, objectsBeforeClear := counts()
	if err = click("Clear list"); err != nil {
		return err
	}
	if err = smokeWait(panel, `document.querySelectorAll('.mini-item').length===0&&document.body.innerText.includes('No recent images')`, 5*time.Second); err != nil {
		return err
	}
	if _, _, objects := counts(); objects != objectsBeforeClear {
		return fmt.Errorf("clear deleted gallery objects")
	}
	if err = smokeCapture(panel, dir, "mini-cleared.png"); err != nil {
		return err
	}
	if err = click("Undo"); err != nil {
		return err
	}
	if err = smokeWait(panel, `document.querySelectorAll('.mini-item').length===11`, 5*time.Second); err != nil {
		return err
	}
	if _, _, objects := counts(); objects != objectsBeforeClear {
		return fmt.Errorf("undo changed gallery objects")
	}
	if err = language("zh-CN"); err != nil {
		return err
	}
	if _, err = smokeEval(panel, `document.querySelector('.mini-results-scroll').scrollTop=0;return true;`); err != nil {
		return err
	}
	if err = smokeCapture(panel, dir, "mini-selection-zh-CN.png"); err != nil {
		return err
	}
	if err = language("en"); err != nil {
		return err
	}
	mygo.RunOnMain(backend.desktop.openMain)
	return nil
}
