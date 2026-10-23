package ratelimit

import (
	"errors"
	"testing"
	"time"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) advance(d time.Duration) { c.now = c.now.Add(d) }

func newTestLimiter(t *testing.T, rate float64, burst int) (*Limiter, *fakeClock) {
	t.Helper()
	clock := &fakeClock{now: time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC)}
	l, err := New(Config{Rate: rate, Burst: burst, Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	return l, clock
}

func TestNewRejectsInvalidConfig(t *testing.T) {
	for _, cfg := range []Config{{Rate: 0, Burst: 1}, {Rate: -1, Burst: 1}, {Rate: 1, Burst: 0}} {
		if _, err := New(cfg); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("New(%+v) error = %v, want ErrInvalidConfig", cfg, err)
		}
	}
}

func TestNewKeyGetsFullBurst(t *testing.T) {
	l, _ := newTestLimiter(t, 1, 3)
	for i := range 3 {
		if ok, _ := l.Allow("10.0.0.1"); !ok {
			t.Fatalf("request %d denied, want allowed", i+1)
		}
	}
	ok, wait := l.Allow("10.0.0.1")
	if ok {
		t.Fatal("fourth request allowed, want denied")
	}
	if wait != time.Second {
		t.Errorf("wait = %v, want 1s", wait)
	}
}

func TestKeysHaveSeparateBuckets(t *testing.T) {
	l, _ := newTestLimiter(t, 1, 1)
	l.Allow("10.0.0.1")
	if ok, _ := l.Allow("10.0.0.2"); !ok {
		t.Fatal("second key denied, want allowed")
	}
}

func TestBucketRefillsAtRate(t *testing.T) {
	l, clock := newTestLimiter(t, 2, 2)
	l.Allow("k")
	l.Allow("k")

	clock.advance(500 * time.Millisecond)
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("denied after earning one token")
	}
	if ok, _ := l.Allow("k"); ok {
		t.Fatal("allowed with an empty bucket")
	}
}

func TestRefillStopsAtBurst(t *testing.T) {
	l, clock := newTestLimiter(t, 10, 2)
	l.Allow("k")
	clock.advance(time.Hour)

	allowed := 0
	for range 5 {
		if ok, _ := l.Allow("k"); ok {
			allowed++
		}
	}
	if allowed != 2 {
		t.Errorf("allowed %d requests after a long idle, want burst 2", allowed)
	}
}

func TestClockSteppingBackEarnsNothing(t *testing.T) {
	l, clock := newTestLimiter(t, 1, 1)
	l.Allow("k")
	clock.advance(-time.Minute)
	if ok, _ := l.Allow("k"); ok {
		t.Fatal("allowed after the clock stepped back")
	}
}

func TestSweepDropsOnlyFullBuckets(t *testing.T) {
	l, clock := newTestLimiter(t, 1, 2)
	l.Allow("idle")
	clock.advance(time.Second)
	l.Allow("busy")
	l.Allow("busy")

	if dropped := l.Sweep(); dropped != 1 {
		t.Fatalf("Sweep dropped %d, want 1", dropped)
	}
	if ok, _ := l.Allow("busy"); ok {
		t.Fatal("busy key got a fresh bucket after Sweep")
	}
}
