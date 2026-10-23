package jobqueue

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const testQueue = "mail"

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2024, 3, 1, 9, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

var testOptions = Options{DefaultMaxAttempts: 3, Backoff: Backoff{Base: time.Second, Max: time.Minute}}

// newTestStore opens a store on a fresh journal with a fake clock.
func newTestStore(t *testing.T) (*Store, *fakeClock) {
	t.Helper()
	clock := newFakeClock()
	return openTestStore(t, filepath.Join(t.TempDir(), "jobs.journal"), clock), clock
}

func openTestStore(t *testing.T, path string, clock Clock) *Store {
	t.Helper()
	st, err := Open(path, clock, testOptions)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// enqueue adds a job with payload to testQueue.
func enqueue(t *testing.T, st *Store, payload string) Job {
	t.Helper()
	job, err := st.Enqueue(EnqueueRequest{Queue: testQueue, Payload: []byte(payload)})
	if err != nil {
		t.Fatal(err)
	}
	return job
}

// lease leases the next job on testQueue for a minute.
func lease(t *testing.T, st *Store) Job {
	t.Helper()
	job, err := st.Lease(testQueue, "w1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return job
}
