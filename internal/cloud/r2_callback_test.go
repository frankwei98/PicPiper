package cloud

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestR2SuccessfulCallbackDrainsBeforeClosingConnections(t *testing.T) {
	service := New(t.TempDir())
	service.client.Transport = r2Transport(func(*http.Request) (*http.Response, error) {
		return r2Response(http.StatusOK, `{"access_token":"fake-oauth-token","token_type":"Bearer"}`), nil
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	session := &r2Session{ctx: ctx, cancel: cancel, listener: listener, state: "synthetic-state", verifier: "synthetic-verifier", status: "pending"}
	returned, finish := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(finish) })
	session.server = &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		service.r2Callback(session, w, r)
		close(returned)
		// Keep net/http's response buffer pending after the callback returns.
		// Closing active connections here loses the already-authorized success page.
		<-finish
	})}
	t.Cleanup(func() { release(); cancel(); session.closeServer() })
	go func() { _ = session.server.Serve(listener) }()
	type response struct {
		status int
		body   string
		err    error
	}
	received := make(chan response, 1)
	go func() {
		client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
		request, _ := http.NewRequest(http.MethodGet, "http://"+listener.Addr().String()+"/oauth/cloudflare/callback?state=synthetic-state&code=fake-code", nil)
		request.Host = "127.0.0.1:19827"
		result, err := client.Do(request)
		if err != nil {
			received <- response{err: err}
			return
		}
		defer result.Body.Close()
		body, err := io.ReadAll(result.Body)
		received <- response{status: result.StatusCode, body: string(body), err: err}
	}()
	select {
	case <-returned:
	case <-time.After(3 * time.Second):
		t.Fatal("callback did not finish")
	}
	assertComplete := func(result response) {
		t.Helper()
		if result.err != nil || result.status != http.StatusOK || result.body != r2ConnectedHTML {
			t.Fatalf("authorized callback response was lost: status=%d bytes=%d err=%v", result.status, len(result.body), result.err)
		}
	}
	select {
	case result := <-received:
		assertComplete(result)
		release()
	case <-time.After(100 * time.Millisecond):
		release()
		select {
		case result := <-received:
			assertComplete(result)
		case <-time.After(3 * time.Second):
			t.Fatal("success response did not arrive after handler completion")
		}
	}
	session.mu.Lock()
	authorized := session.status == "authorized" && session.token == "fake-oauth-token"
	session.mu.Unlock()
	if !authorized {
		t.Fatal("response shutdown changed the authorized session")
	}
}
