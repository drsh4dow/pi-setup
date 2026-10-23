package ratelimit

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// ErrNoAdminToken reports that NewAdmin was given an empty token.
var ErrNoAdminToken = errors.New("admin token must not be empty")

// Admin serves the bucket admin API under /admin/.
type Admin struct {
	buckets bucketService
	token   []byte
	mux     *http.ServeMux
}

// bucketService gives the admin handlers access to the limiter's buckets.
type bucketService struct {
	limiter *Limiter
}

func (s bucketService) state(key string) (State, bool) { return s.limiter.Snapshot(key) }

func (s bucketService) reset(key string) bool { return s.limiter.Reset(key) }

type bucketView struct {
	Key       string  `json:"key"`
	Remaining float64 `json:"remaining"`
	Burst     int     `json:"burst"`
	AsOf      string  `json:"as_of"`
}

func newBucketView(key string, state State) bucketView {
	return bucketView{
		Key:       key,
		Remaining: state.Remaining,
		Burst:     state.Burst,
		AsOf:      time.Now().UTC().Format(time.RFC3339),
	}
}

// NewAdmin returns the admin API for l. Requests must carry token as a bearer
// token. It returns ErrNoAdminToken if token is empty.
func NewAdmin(l *Limiter, token string) (*Admin, error) {
	if token == "" {
		return nil, ErrNoAdminToken
	}

	a := &Admin{buckets: bucketService{limiter: l}, token: []byte(token), mux: http.NewServeMux()}
	a.mux.HandleFunc("GET /admin/buckets/{key}", a.show)
	a.mux.HandleFunc("DELETE /admin/buckets/{key}", a.reset)
	return a, nil
}

// ServeHTTP routes r to the admin handlers.
func (a *Admin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mux.ServeHTTP(w, r)
}

func (a *Admin) authorized(r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(token), a.token) == 1
}

func (a *Admin) show(w http.ResponseWriter, r *http.Request) {
	if a.authorized(r) {
		key := r.PathValue("key")
		if state, ok := a.buckets.state(key); ok {
			body, err := json.Marshal(newBucketView(key, state))
			if err == nil {
				w.Header().Set("Content-Type", "application/json")
				w.Write(body)
			} else {
				http.Error(w, "encode bucket", http.StatusInternalServerError)
			}
		} else {
			http.Error(w, "no bucket for key", http.StatusNotFound)
		}
	} else {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}

func (a *Admin) reset(w http.ResponseWriter, r *http.Request) {
	if !a.buckets.reset(r.PathValue("key")) {
		http.Error(w, "no bucket for key", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
