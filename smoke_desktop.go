package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/egoist/mygo"
)

// Exercise real native window close events without ending the smoke process.
// A temporary quit listener observes and cancels quit requests in this test.
func smokeWindowCloseBehavior(win *mygo.Window, backend *Backend) (resultErr error) {
	value, err := backend.cloud.Call(context.Background(), "load_app_settings", json.RawMessage(`{}`))
	if err != nil {
		return err
	}
	original, err := json.Marshal(value)
	if err != nil {
		return err
	}
	save := func(settings json.RawMessage) error {
		payload, err := json.Marshal(map[string]json.RawMessage{"settings": settings})
		if err != nil {
			return err
		}
		var result reply
		if err = json.Unmarshal([]byte(backend.Call(context.Background(), "save_app_settings", string(payload))), &result); err != nil {
			return err
		}
		if result.Error != nil {
			return fmt.Errorf("save smoke desktop settings: %s", result.Error.Message)
		}
		return nil
	}
	configure := func(behavior string, icon bool) error {
		var settings map[string]any
		if err := json.Unmarshal(original, &settings); err != nil {
			return err
		}
		settings["closeBehavior"] = behavior
		settings["mini"].(map[string]any)["enabled"] = icon
		encoded, err := json.Marshal(settings)
		if err != nil {
			return err
		}
		return save(encoded)
	}
	quitAttempts := make(chan struct{}, 4)
	var offQuit func()
	mygo.RunOnMain(func() {
		offQuit = mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
			event.PreventDefault()
			select {
			case quitAttempts <- struct{}{}:
			default:
			}
		})
	})
	defer func() {
		if err := save(original); err != nil && resultErr == nil {
			resultErr = err
		}
		mygo.RunOnMain(func() { offQuit(); backend.desktop.openMain() })
	}()
	for _, test := range []struct {
		behavior string
		icon     bool
	}{{"background", false}, {"quit", true}} {
		if err := configure(test.behavior, test.icon); err != nil {
			return err
		}
		win.Close()
		deadline := time.Now().Add(3 * time.Second)
		for win.IsVisible() && time.Now().Before(deadline) {
			time.Sleep(25 * time.Millisecond)
		}
		if win.IsVisible() {
			return fmt.Errorf("close did not hide the main window (preference=%s, statusIcon=%t)", test.behavior, test.icon)
		}
		select {
		case <-quitAttempts:
			return fmt.Errorf("background close requested application quit")
		default:
		}
		mygo.RunOnMain(backend.desktop.openMain)
		if !win.IsVisible() {
			return fmt.Errorf("background window could not be reopened")
		}
	}
	if err := configure("quit", false); err != nil {
		return err
	}
	win.Close()
	select {
	case <-quitAttempts:
	case <-time.After(3 * time.Second):
		return fmt.Errorf("default main-window close did not request application quit")
	}
	return nil
}
