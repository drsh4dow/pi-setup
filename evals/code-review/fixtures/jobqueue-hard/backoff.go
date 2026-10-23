package jobqueue

import "time"

// Backoff decides how long a requeued job waits before its next attempt:
// Base after the first attempt, doubling after each one after that, and
// never more than Max.
type Backoff struct {
	Base time.Duration
	Max  time.Duration
}

// DefaultBackoff starts at one second and stops growing at five minutes.
var DefaultBackoff = Backoff{Base: time.Second, Max: 5 * time.Minute}

// Delay returns the wait after the given attempt, counting from 1.
func (b Backoff) Delay(attempt int) time.Duration {
	delay := b.Base
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= b.Max {
			return b.Max
		}
	}
	return min(delay, b.Max)
}
