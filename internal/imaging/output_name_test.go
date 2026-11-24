package imaging

import (
	"bytes"
	"image"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCompressionAndExportWithMaximumLengthNames(t *testing.T) {
	for _, tc := range []struct {
		label, unit string
	}{{"ASCII", "x"}, {"Unicode", "月"}} {
		t.Run(tc.label, func(t *testing.T) {
			prefix, count, collisionTrim := "", 251, 2
			if tc.unit != "x" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
				prefix, count, collisionTrim = "xx", 83, 1
			}
			stem := prefix + strings.Repeat(tc.unit, count)
			source := fixture(t, image.NewNRGBA(image.Rect(0, 0, 2, 2)))
			longSource := filepath.Join(filepath.Dir(source), stem+".png")
			if err := os.Rename(source, longSource); err != nil {
				t.Fatal(err)
			}
			service := New(t.TempDir())
			t.Cleanup(service.Close)
			run := call(t, service, "create_optimizer_run", request{}).(map[string]string)
			base := request{SourcePath: longSource, OutputDir: run["outputDir"], OutputFileName: stem + ".png", Settings: settings{TargetFormat: "png"}}
			png := call(t, service, "compress_image", base).(Result)
			if png.OutputFileName != base.OutputFileName {
				t.Fatalf("valid filename changed: got %q, want %q", png.OutputFileName, base.OutputFileName)
			}

			t.Run("longer extension", func(t *testing.T) {
				req := base
				req.OutputFileName, req.Settings.TargetFormat = stem+".webp", "webp"
				result := call(t, service, "compress_image", req).(Result)
				if want := prefix + strings.Repeat(tc.unit, count-1) + ".webp"; result.OutputFileName != want {
					t.Fatalf("output filename = %q, want %q", result.OutputFileName, want)
				}
			})

			t.Run("export collision", func(t *testing.T) {
				target := t.TempDir()
				existing := filepath.Join(target, base.OutputFileName)
				protected := []byte("existing file")
				if err := os.WriteFile(existing, protected, 0600); err != nil {
					t.Fatal(err)
				}
				req := request{OutputPaths: []string{png.OutputPath}, TargetDir: target}
				outputs := call(t, service, "copy_outputs_to_dir", req).([]string)
				wantName := prefix + strings.Repeat(tc.unit, count-collisionTrim) + "-2.png"
				if len(outputs) != 1 || filepath.Base(outputs[0]) != wantName {
					t.Fatalf("exported filename = %q, want %q", outputs, wantName)
				}
				original, err := os.ReadFile(existing)
				if err != nil || !bytes.Equal(original, protected) {
					t.Fatalf("existing file changed: %q, %v", original, err)
				}
				exported, err := os.ReadFile(outputs[0])
				if err != nil {
					t.Fatal(err)
				}
				cached, err := os.ReadFile(png.OutputPath)
				if err != nil || !bytes.Equal(exported, cached) {
					t.Fatalf("export did not preserve the cached image: %v", err)
				}
			})
		})
	}
}
