package main

import (
	_ "embed"
	"log"
	"runtime"

	"github.com/egoist/mygo"
	"github.com/frankwei98/PicPiper/internal/cloud"
	"github.com/frankwei98/PicPiper/internal/traydrop"
)

//go:embed resources/tray@2x.png
var miniTrayIcon []byte

// All native handles below belong to MyGo's main thread.
type desktopController struct {
	backend           *Backend
	main, panel       *mygo.Window
	tray              *mygo.Tray
	detachDrop        func()
	quitting, dismiss bool
	trayError         string
	page              mygo.PageOptions
	closeBehavior     cloud.CloseBehavior
}

func (d *desktopController) refresh() {
	preferences, err := d.backend.cloud.DesktopPreferences()
	if err != nil {
		d.trayError = "Could not load desktop settings."
		return
	}
	d.closeBehavior = preferences.CloseBehavior
	if !preferences.StatusIconEnabled {
		d.removeTray()
		return
	}
	if d.tray != nil {
		return
	}
	d.tray, err = mygo.NewTray(mygo.TrayOptions{ID: "pic-piper-mini", Icon: miniTrayIcon, IconIsTemplate: true, ToolTip: "Pic Piper Mini"})
	if err != nil {
		d.tray = nil
		d.trayError = "The system tray is unavailable on this desktop."
		log.Print(d.trayError)
		return
	}
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Pic Piper Mini", Click: func(*mygo.MenuItem, *mygo.Window) { d.showPanel() }},
		{Label: "Open Pic Piper", Click: func(*mygo.MenuItem, *mygo.Window) { d.openMain() }},
		mygo.Separator(), {Role: mygo.RoleQuit},
	})
	if runtime.GOOS == "linux" {
		d.tray.SetMenu(menu)
	} else {
		d.tray.OnClick(func() {
			if d.panel != nil {
				d.closePanel()
			} else {
				d.showPanel()
			}
		})
		d.tray.OnRightClick(func() { d.closePanel(); d.tray.SetMenu(menu); defer d.tray.SetMenu(nil); d.tray.PopUpMenu() })
	}
	var dropErr error
	d.detachDrop, dropErr = traydrop.Install("Pic Piper Mini", func(paths []string) {
		// The callback only enqueues; all image/network work stays off the UI thread.
		if err := d.backend.mini.Add(paths); err != nil {
			d.backend.mini.Report(err)
		}
		d.showPanel()
	})
	if dropErr != nil {
		d.trayError = "Drop files into the Mini panel; direct icon drops are unavailable."
		log.Print(d.trayError)
	}
}

func (d *desktopController) closeMain(event *mygo.CloseEvent) {
	if d.quitting {
		return
	}
	event.PreventDefault()
	if d.tray != nil || d.closeBehavior == cloud.CloseBackground {
		d.main.Hide()
		return
	}
	mygo.App.Quit()
}

func (d *desktopController) removeTray() {
	d.closePanel()
	if d.detachDrop != nil {
		d.detachDrop()
		d.detachDrop = nil
	}
	if d.tray != nil {
		d.tray.Destroy()
		d.tray = nil
	}
}
func (d *desktopController) showPanel() {
	if d.tray == nil {
		return
	}
	if d.panel != nil {
		d.panel.Show()
		d.panel.Focus()
		return
	}
	d.panel = mygo.NewFlyout(mygo.FlyoutOptions{Tray: d.tray, Placement: mygo.PlacementBottom, Gap: 6, Width: 362, Height: 560, FitContent: false, MinWidth: 362, MaxWidth: 362, MaxHeight: 560, Focusable: true, Shadow: true, CornerRadius: 14, URL: "/?mini=1", Page: d.page})
	panel := d.panel
	// Keep the drop target visible when the user returns to Finder to drag a file.
	panel.OnClose(func(e *mygo.CloseEvent) {
		if !d.dismiss && !d.quitting {
			e.PreventDefault()
		}
	})
	panel.OnClosed(func() {
		if d.panel == panel {
			d.panel = nil
			d.dismiss = false
		}
	})
}
func (d *desktopController) closePanel() {
	if d.panel != nil {
		d.dismiss = true
		d.panel.Close()
	}
}
func (d *desktopController) openMain() {
	d.closePanel()
	if d.main != nil {
		d.main.Restore()
		d.main.Show()
		d.main.Focus()
		mygo.App.Focus()
	}
}
