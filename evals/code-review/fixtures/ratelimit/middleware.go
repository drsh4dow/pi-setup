package ratelimit

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"strconv"
)

// KeyFunc derives the rate limit key for a request.
type KeyFunc func(*http.Request) (string, error)

// ClientIP keys a request by the host part of its RemoteAddr. Put the limiter
// behind a proxy only if the proxy rewrites RemoteAddr to the real client.
func ClientIP(r *http.Request) (string, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "", fmt.Errorf("parse remote address %q: %w", r.RemoteAddr, err)
	}
	return host, nil
}

// Middleware passes requests to next while key's bucket has tokens and
// answers 429 with a Retry-After header once it runs dry.
func Middleware(l *Limiter, key KeyFunc, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		k, err := key(r)
		if err != nil {
			http.Error(w, "cannot identify client", http.StatusBadRequest)
			return
		}

		allowed, wait := l.Allow(k)
		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
