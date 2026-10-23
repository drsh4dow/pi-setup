package ratelimit

import "time"

// Clock tells the limiter what time it is. Tests inject a fake one.
type Clock interface {
	Now() time.Time
}

// SystemClock reads the wall clock.
type SystemClock struct{}

// Now returns the current wall-clock time.
func (SystemClock) Now() time.Time { return time.Now() }
