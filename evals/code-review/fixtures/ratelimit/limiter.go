// Package ratelimit limits requests per key with token buckets.
package ratelimit

import (
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// ErrInvalidConfig reports a Config that cannot build a Limiter.
var ErrInvalidConfig = errors.New("invalid rate limit config")

// Config sets how large each key's bucket is and how fast it refills.
type Config struct {
	// Rate is the number of tokens added to a bucket per second.
	Rate float64
	// Burst is the bucket capacity: how many requests a new key may make at once.
	Burst int
	// Clock supplies the current time. Nil means SystemClock.
	Clock Clock
}

// Limiter holds one token bucket per key. It is safe for concurrent use.
type Limiter struct {
	rate  float64
	burst float64
	clock Clock

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// New returns a Limiter for cfg, or an error wrapping ErrInvalidConfig.
func New(cfg Config) (*Limiter, error) {
	if !(cfg.Rate > 0) || math.IsInf(cfg.Rate, 0) {
		return nil, fmt.Errorf("%w: rate must be a positive number, got %v", ErrInvalidConfig, cfg.Rate)
	}
	if cfg.Burst < 1 {
		return nil, fmt.Errorf("%w: burst must be at least 1, got %d", ErrInvalidConfig, cfg.Burst)
	}

	clock := cfg.Clock
	if clock == nil {
		clock = SystemClock{}
	}

	return &Limiter{
		rate:    cfg.Rate,
		burst:   float64(cfg.Burst),
		clock:   clock,
		buckets: make(map[string]*bucket),
	}, nil
}

// Allow takes a token from key's bucket if one is available. When none is,
// it returns false and how long until the next token arrives.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.clock.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.refill(now, l.rate, l.burst)

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}

	wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	return false, wait
}

// Sweep drops every bucket that has refilled to full and returns how many it
// dropped. A full bucket behaves exactly like a missing one.
func (l *Limiter) Sweep() int {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.clock.Now()
	dropped := 0
	for key, b := range l.buckets {
		b.refill(now, l.rate, l.burst)
		if b.tokens >= l.burst {
			delete(l.buckets, key)
			dropped++
		}
	}
	return dropped
}

// refill adds the tokens earned since b.last, capped at burst. A clock that
// steps backwards earns nothing.
func (b *bucket) refill(now time.Time, rate, burst float64) {
	elapsed := now.Sub(b.last).Seconds()
	if elapsed <= 0 {
		return
	}
	b.tokens = math.Min(burst, b.tokens+elapsed*rate)
	b.last = now
}
