package imaging

import (
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestInvalidNameOnlyRetriedForLongWindowsComponents(t *testing.T) {
	// Each supplementary character occupies two UTF-16 code units.
	stem := strings.Repeat("🌙", 125) + "x"
	err := &os.PathError{Op: "open", Err: windows.ERROR_INVALID_NAME}
	if outputNameTooLong(stem+".png", err) {
		t.Fatal("syntax error on a 255-unit name should be returned to the caller")
	}
	if !outputNameTooLong(stem+".webp", err) {
		t.Fatal("expected the 256-unit name to be shortened")
	}
}
