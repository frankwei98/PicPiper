package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

type updateSmokeReport struct {
	Passed            bool   `json:"passed"`
	Before            string `json:"before"`
	Available         string `json:"available"`
	After             string `json:"after"`
	SignatureRejected bool   `json:"signatureRejected"`
	Error             string `json:"error,omitempty"`
}

// The real updater can be exercised only in a disposable copy of the app
// beneath a temporary directory. This driver never opens the user's backend,
// profiles, updater preferences, or installed /Applications bundle.
func runUpdateSmokeMode() bool {
	if len(os.Args) != 3 || (os.Args[1] != "--update-smoke" && os.Args[1] != "--update-smoke-complete") {
		return false
	}
	dir, err := filepath.Abs(os.Args[2])
	exe, exeErr := os.Executable()
	temp, _ := filepath.EvalSymlinks(os.TempDir())
	resolvedDir, _ := filepath.EvalSymlinks(dir)
	resolvedExe, _ := filepath.EvalSymlinks(exe)
	rel, relErr := filepath.Rel(resolvedDir, resolvedExe)
	if err != nil || exeErr != nil || relErr != nil || strings.HasPrefix(rel, "..") || !strings.HasPrefix(resolvedDir, temp+string(os.PathSeparator)) {
		fmt.Fprintln(os.Stderr, "Update smoke requires a disposable app inside its temporary report directory.")
		return true
	}
	dir = resolvedDir
	path := filepath.Join(dir, "update-report.json")
	complete := os.Args[1] == "--update-smoke-complete"
	mygo.App.WhenReady(func() {
		go func() {
			report := updateSmokeReport{Before: mygo.App.Version()}
			if complete {
				data, readErr := os.ReadFile(path)
				if readErr == nil {
					readErr = json.Unmarshal(data, &report)
				}
				report.After = mygo.App.Version()
				report.Passed = readErr == nil && report.After == report.Available && report.SignatureRejected
				if !report.Passed {
					report.Error = "Relaunched app did not match the verified update."
				}
			} else {
				err := exerciseUpdate(&report, exe)
				if err != nil {
					report.Error = err.Error()
				}
			}
			data, _ := json.MarshalIndent(report, "", "  ")
			if err := os.WriteFile(path, data, 0600); err != nil {
				fmt.Fprintln(os.Stderr, err)
				mygo.App.Quit()
				return
			}
			if !complete && report.Error == "" {
				mygo.App.Relaunch("--update-smoke-complete", dir)
			} else {
				mygo.App.Quit()
			}
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	return true
}

func exerciseUpdate(report *updateSmokeReport, executable string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	url := "https://github.com/frankwei98/PicPiper/releases/latest/download/update-" + runtime.GOOS + "-" + runtime.GOARCH + ".json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Update feed returned %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		return err
	}
	manifest["signature"] = "invalid-signature"
	delete(manifest, "deltas")
	corrupt, _ := json.Marshal(manifest)
	before, err := os.ReadFile(executable)
	if err != nil {
		return err
	}
	mygo.Updater.SetSource(smokeUpdateSource{manifest: corrupt})
	bad, err := mygo.Updater.Check(ctx)
	if err != nil || bad == nil {
		return errors.New("No newer version available for the signature rejection test.")
	}
	if err := bad.Install(ctx, nil); err == nil {
		return errors.New("Tampered signature was accepted.")
	} else if !strings.Contains(err.Error(), "signed") && !strings.Contains(err.Error(), "signature") {
		return fmt.Errorf("Signature test failed before verification: %w", err)
	}
	after, err := os.ReadFile(executable)
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		return errors.New("Failed update changed the current executable.")
	}
	report.SignatureRejected = true
	mygo.Updater.SetSource(nil)
	update, err := mygo.Updater.Check(ctx)
	if err != nil {
		return err
	}
	if update == nil {
		return errors.New("No newer public update found.")
	}
	report.Available = update.Version
	return update.Install(ctx, nil)
}

type smokeUpdateSource struct{ manifest []byte }

func (s smokeUpdateSource) Manifest(context.Context, bool) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(s.manifest)), nil
}
func (s smokeUpdateSource) Open(ctx context.Context, url string) (io.ReadCloser, error) {
	if !strings.HasPrefix(url, "https://github.com/frankwei98/PicPiper/releases/download/") {
		return nil, errors.New("Unexpected smoke download origin.")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("Update download returned %d", response.StatusCode)
	}
	return response.Body, nil
}
