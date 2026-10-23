package ratelimit

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const testToken = "s3cret"

func newTestAdmin(t *testing.T, rate float64, burst int) (*Admin, *Limiter) {
	t.Helper()
	l, _ := newTestLimiter(t, rate, burst)
	a, err := NewAdmin(l, testToken)
	if err != nil {
		t.Fatal(err)
	}
	return a, l
}

func adminRequest(a *Admin, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	return rec
}

func TestNewAdminRequiresToken(t *testing.T) {
	l, _ := newTestLimiter(t, 1, 1)
	if _, err := NewAdmin(l, ""); !errors.Is(err, ErrNoAdminToken) {
		t.Fatalf("NewAdmin with empty token error = %v, want ErrNoAdminToken", err)
	}
}

func TestShowReportsBucket(t *testing.T) {
	a, l := newTestAdmin(t, 1, 5)
	l.Allow("10.0.0.1")
	l.Allow("10.0.0.1")

	rec := adminRequest(a, http.MethodGet, "/admin/buckets/10.0.0.1", testToken)
	var got bucketView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("status %d, body %q: %v", rec.Code, rec.Body, err)
	}
	if got.Key != "10.0.0.1" || got.Remaining != 3 || got.Burst != 5 {
		t.Errorf("body = %+v, want key 10.0.0.1, remaining 3, burst 5", got)
	}
	if _, err := time.Parse(time.RFC3339, got.AsOf); err != nil {
		t.Errorf("as_of %q is not RFC 3339: %v", got.AsOf, err)
	}
}

func TestShowRequiresToken(t *testing.T) {
	a, l := newTestAdmin(t, 1, 5)
	l.Allow("10.0.0.1")
	for _, token := range []string{"", "wrong", testToken + "x"} {
		if rec := adminRequest(a, http.MethodGet, "/admin/buckets/10.0.0.1", token); rec.Code != http.StatusUnauthorized {
			t.Errorf("token %q: status = %d, want 401", token, rec.Code)
		}
	}
}

func TestResetAndUnknownKeyStatus(t *testing.T) {
	a, l := newTestAdmin(t, 1, 2)
	l.Allow("10.0.0.1")
	for _, tc := range []struct {
		method, key string
		want        int
	}{
		{http.MethodDelete, "10.0.0.1", http.StatusNoContent},
		{http.MethodGet, "10.0.0.9", http.StatusNotFound},
		{http.MethodDelete, "10.0.0.9", http.StatusNotFound},
	} {
		if rec := adminRequest(a, tc.method, "/admin/buckets/"+tc.key, testToken); rec.Code != tc.want {
			t.Errorf("%s %s: status = %d, want %d", tc.method, tc.key, rec.Code, tc.want)
		}
	}
}
