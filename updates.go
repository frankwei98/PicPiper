package main

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
	"github.com/frankwei98/PicPiper/internal/apperror"
)

var UpdatesChanged = mygo.NewEvent[bool]("updates-changed")

// Both bridge requests and the frontend's batch lifetime keep a prepared
// update from interrupting work between individual image/upload requests.
const activityLeaseDuration = 2 * time.Minute

type updateController struct {
	now             func() time.Time
	mu              sync.Mutex
	active          int
	queues          map[string]time.Time
	installed       bool
	closing         bool
	restartDeferred bool
	smoke           bool
}

type updateState struct {
	Version            string `json:"version"`
	Enabled            bool   `json:"enabled"`
	AutomaticChecks    bool   `json:"automaticChecks"`
	AutomaticDownloads bool   `json:"automaticDownloads"`
	LastCheck          string `json:"lastCheck"`
	AvailableVersion   string `json:"availableVersion"`
	RestartDeferred    bool   `json:"restartDeferred"`
}

func (u *updateController) activityNow() time.Time {
	if u.now != nil {
		return u.now()
	}
	return time.Now()
}

func (u *updateController) begin() (func(), error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closing {
		return nil, apperror.New("closing", "Pic Piper is closing. Try again after reopening the app.")
	}
	u.active++
	return func() { u.mu.Lock(); u.active--; u.mu.Unlock() }, nil
}

// Called on the main thread before windows close. A prepared update must wait
// for the whole batch, including Mini jobs not owned by a bridge goroutine.
func (u *updateController) prepareQuit(miniBusy, sessionEnding bool) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	busy := u.active > 0 || miniBusy
	now := u.activityNow()
	for key, expires := range u.queues {
		if !now.Before(expires) {
			delete(u.queues, key)
		} else {
			busy = true
		}
	}
	if u.installed && busy && !sessionEnding {
		u.restartDeferred = true
		return false
	}
	u.closing = true
	return true
}

func (u *updateController) state() updateState {
	u.mu.Lock()
	deferred := u.restartDeferred
	u.mu.Unlock()
	v := updateState{Version: mygo.App.Version(), RestartDeferred: deferred}
	if u.smoke {
		return v
	}
	v.Enabled = mygo.Updater.Enabled()
	v.AutomaticChecks = updater.AutomaticChecks()
	v.AutomaticDownloads = updater.AutomaticDownloads()
	v.AvailableVersion = updater.AvailableVersion()
	if at := updater.LastCheck(); !at.IsZero() {
		v.LastCheck = at.UTC().Format("2006-01-02T15:04:05Z")
	}
	return v
}

func (u *updateController) call(operation string, payload []byte) (any, error) {
	switch operation {
	case "update_state":
		return u.state(), nil
	case "update_check":
		if !u.smoke {
			updater.CheckForUpdates()
		}
	case "update_preferences":
		var prefs struct {
			AutomaticChecks    bool `json:"automaticChecks"`
			AutomaticDownloads bool `json:"automaticDownloads"`
		}
		if err := json.Unmarshal(payload, &prefs); err != nil {
			return nil, err
		}
		if !u.smoke && mygo.Updater.Enabled() {
			updater.SetAutomaticChecks(prefs.AutomaticChecks)
			updater.SetAutomaticDownloads(prefs.AutomaticDownloads)
		}
		return u.state(), nil
	case "update_locale":
		var req struct {
			Language string `json:"language"`
		}
		if err := json.Unmarshal(payload, &req); err != nil {
			return nil, err
		}
		switch req.Language {
		case "system", "en", "zh-CN", "fr", "es", "ja", "ko":
			if !u.smoke {
				mygo.App.SetLocale(strings.ReplaceAll(strings.TrimPrefix(req.Language, "system"), "zh-CN", "zh-Hans"))
			}
		default:
			return nil, apperror.New("invalidRequest", "Choose a supported application language.")
		}
	case "update_activity":
		var req struct {
			Scope string `json:"scope"`
			ID    string `json:"id"`
			Busy  bool   `json:"busy"`
		}
		if err := json.Unmarshal(payload, &req); err != nil {
			return nil, err
		}
		if (req.Scope != "optimize" && req.Scope != "gallery") || len(req.ID) > 64 {
			return nil, apperror.New("invalidRequest", "Unknown task scope.")
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		if req.Busy && u.closing {
			return nil, apperror.New("closing", "Pic Piper is closing. Try again after reopening the app.")
		}
		if u.queues == nil {
			u.queues = make(map[string]time.Time)
		}
		key := req.Scope + ":" + req.ID
		if req.Busy {
			u.queues[key] = u.activityNow().Add(activityLeaseDuration)
		} else {
			delete(u.queues, key)
		}
	}
	return nil, nil
}

func (b *Backend) setupUpdates(smoke bool) {
	u := &updateController{smoke: smoke}
	b.updates = u
	if smoke {
		return // Smoke never reads or writes real updater preferences or feeds.
	}
	mygo.Use(updater.Plugin)
	updater.OnChange(func() { UpdatesChanged.Broadcast(true) })
	updater.OnInstalled(func() {
		u.mu.Lock()
		u.installed = true
		u.mu.Unlock()
		UpdatesChanged.Broadcast(true)
	})
	mygo.App.WhenReady(b.updateMenu)
	mygo.App.OnLocaleChanged(func(string) { b.updateMenu() })
}

func (b *Backend) updateMenu() {
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Pic Piper", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout}, updater.MenuItem(), mygo.Separator(), {Role: mygo.RoleQuit},
		}},
		{Role: mygo.RoleEditMenu}, {Role: mygo.RoleWindowMenu},
	}))
}
