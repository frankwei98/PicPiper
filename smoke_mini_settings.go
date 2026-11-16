package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/frankwei98/PicPiper/internal/cloud"
)

// Exercise the real cross-window settings notification and Mini save bridge.
func smokeMiniCompressionSync(panel *mygo.Window, backend *Backend, dir string) (resultErr error) {
	current, err := backend.cloud.Call(context.Background(), "load_app_settings", json.RawMessage(`{}`))
	if err != nil {
		return err
	}
	original, err := json.Marshal(current)
	if err != nil {
		return err
	}
	save := func(raw []byte) error {
		payload, err := json.Marshal(map[string]json.RawMessage{"settings": raw})
		if err != nil {
			return err
		}
		var result reply
		if err = json.Unmarshal([]byte(backend.Call(context.Background(), "save_app_settings", string(payload))), &result); err != nil {
			return err
		}
		if result.Error != nil {
			return fmt.Errorf("save Mini smoke preferences: %s", result.Error.Message)
		}
		return nil
	}
	restore := true
	defer func() {
		if restore {
			if err := save(original); err != nil && resultErr == nil {
				resultErr = err
			}
		}
	}()
	var updated map[string]json.RawMessage
	if err = json.Unmarshal(original, &updated); err != nil {
		return err
	}
	var before cloud.MiniSettings
	if err = json.Unmarshal(updated["mini"], &before); err != nil {
		return err
	}
	quality := 85
	if before.Quality == quality {
		quality = 84
	}
	if err = smokeWait(panel, `Boolean(document.querySelector('.mini-format:not(:disabled)'))`, 5*time.Second); err != nil {
		return err
	}
	// Keep this settings regression independent of flyout animation completion.
	if _, err = smokeEval(panel, `window.__miniSmokeAnimations=globalThis.BASE_UI_ANIMATIONS_DISABLED;globalThis.BASE_UI_ANIMATIONS_DISABLED=true;return true;`); err != nil {
		return err
	}
	defer func() {
		_, _ = smokeEval(panel, `globalThis.BASE_UI_ANIMATIONS_DISABLED=window.__miniSmokeAnimations;delete window.__miniSmokeAnimations;return true;`)
	}()
	if err = smokeClick(panel, "Adjust compression settings"); err != nil {
		return err
	}
	if err = smokeWait(panel, `Boolean(document.querySelector('.mini-compression-dialog input'))`, 5*time.Second); err != nil {
		return err
	}
	_, err = smokeEval(panel, `const input=document.querySelector('.mini-compression-dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,`+smokeJSON(quality)+`);input.dispatchEvent(new Event('input',{bubbles:true}));return true;`)
	if err != nil {
		return err
	}
	// The main window saves a format change while the panel is editing quality.
	mainWindow := before
	mainWindow.TargetFormat = "avif"
	updated["mini"], err = json.Marshal(mainWindow)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(updated)
	if err != nil {
		return err
	}
	if err = save(raw); err != nil {
		return err
	}
	if err = smokeWait(panel, `document.querySelector('.mini-format').textContent.includes('AVIF')`, 5*time.Second); err != nil {
		return err
	}
	if err = smokeClick(panel, "Save Mini settings"); err != nil {
		return err
	}
	if err = smokeWait(panel, `!document.querySelector('.mini-compression-dialog')&&document.querySelector('.mini-format').textContent.includes('AVIF')&&document.querySelector('.mini-format').textContent.includes(`+smokeJSON(fmt.Sprintf("%d%%", quality))+`)`, 5*time.Second); err != nil {
		return err
	}
	value, err := backend.cloud.Call(context.Background(), "load_app_settings", json.RawMessage(`{}`))
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var saved struct {
		Mini cloud.MiniSettings `json:"mini"`
	}
	if err = json.Unmarshal(encoded, &saved); err != nil {
		return err
	}
	expected := mainWindow
	expected.Quality = quality
	if saved.Mini != expected {
		return fmt.Errorf("Mini compression save replaced another window's preferences: %+v", saved.Mini)
	}
	if err = smokeCapture(panel, dir, "mini-settings-synced.png"); err != nil {
		return err
	}
	if err = save(original); err != nil {
		return err
	}
	restore = false
	return smokeWait(panel, `document.querySelector('.mini-format').textContent.includes(`+smokeJSON(strings.ToUpper(before.TargetFormat))+`)&&document.querySelector('.mini-format').textContent.includes(`+smokeJSON(fmt.Sprintf("%d%%", before.Quality))+`)`, 5*time.Second)
}
