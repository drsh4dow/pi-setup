package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func serve(h http.Handler, remoteAddr string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestMiddlewareRejectsOverLimit(t *testing.T) {
	l, _ := newTestLimiter(t, 0.5, 1)
	h := Middleware(l, ClientIP, okHandler())

	if rec := serve(h, "10.0.0.1:5000"); rec.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want 200", rec.Code)
	}
	rec := serve(h, "10.0.0.1:5001")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second request status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "2" {
		t.Errorf("Retry-After = %q, want %q", got, "2")
	}
}

func TestMiddlewareRoundsRetryAfterUp(t *testing.T) {
	l, clock := newTestLimiter(t, 1, 1)
	h := Middleware(l, ClientIP, okHandler())
	serve(h, "10.0.0.1:5000")
	clock.advance(100 * time.Millisecond)

	if got := serve(h, "10.0.0.1:5000").Header().Get("Retry-After"); got != "1" {
		t.Errorf("Retry-After = %q, want %q", got, "1")
	}
}

func TestMiddlewareRejectsUnparseableAddress(t *testing.T) {
	l, _ := newTestLimiter(t, 1, 1)
	if rec := serve(Middleware(l, ClientIP, okHandler()), "garbage"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
