package cloud

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
)

//go:embed r2_connected.html
var r2ConnectedHTML string

func writeR2ConnectedPage(w http.ResponseWriter) {
	// Hash only the bundled static style/script; callback parameters never enter
	// the HTML or app link. All other scripts and network resources stay blocked.
	hashElement := func(tag string) string {
		_, rest, _ := strings.Cut(r2ConnectedHTML, "<"+tag+">")
		content, _, _ := strings.Cut(rest, "</"+tag+">")
		hash := sha256.Sum256([]byte(content))
		return "'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src "+hashElement("style")+"; script-src "+hashElement("script")+"; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.WriteString(w, r2ConnectedHTML)
}
