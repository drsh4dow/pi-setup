package jobqueue

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func startPool(t *testing.T, st *Store, log *bytes.Buffer, handler Handler) *Pool {
	t.Helper()
	pool := NewPool(st, PoolConfig{
		Queue:     testQueue,
		LeaseTTL:  30 * time.Second,
		Heartbeat: 5 * time.Millisecond,
		PollEvery: time.Millisecond,
	}, handler, NewLogger(log))
	pool.Start()
	return pool
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func stateOf(st *Store, id string) State {
	job, err := st.Get(id)
	if err != nil {
		return ""
	}
	return job.State
}

func TestPoolCompletesJobs(t *testing.T) {
	st, _ := newTestStore(t)
	job := enqueue(t, st, `{"to":"ana@example.com"}`)

	var log bytes.Buffer
	pool := startPool(t, st, &log, func(ctx context.Context, job Job) error { return nil })
	waitFor(t, "job done", func() bool { return stateOf(st, job.ID) == StateDone })
	pool.Stop()

	if !strings.Contains(log.String(), "event="+EventJobCompleted) {
		t.Fatalf("log = %q, want a %s event", log.String(), EventJobCompleted)
	}
}

func TestPoolFailsJobWhenHandlerErrsOrPanics(t *testing.T) {
	st, _ := newTestStore(t)
	erring := enqueue(t, st, `{"mode":"err"}`)
	panicking := enqueue(t, st, `{"mode":"panic"}`)

	var log bytes.Buffer
	pool := startPool(t, st, &log, func(ctx context.Context, job Job) error {
		if job.ID == panicking.ID {
			panic("nil template")
		}
		return errors.New("mailbox full")
	})
	waitFor(t, "both attempts failed", func() bool {
		a, _ := st.Get(erring.ID)
		b, _ := st.Get(panicking.ID)
		return a.LastError != "" && b.LastError != ""
	})
	pool.Stop()

	if job, _ := st.Get(erring.ID); job.LastError != "mailbox full" || job.State != StatePending {
		t.Fatalf("erring job = %+v, want requeued with its error", job)
	}
	if job, _ := st.Get(panicking.ID); !strings.Contains(job.LastError, "nil template") {
		t.Fatalf("panicking job = %+v, want the panic as its error", job)
	}
}

func TestHandlerStopsWhenLeaseIsLost(t *testing.T) {
	st, clock := newTestStore(t)
	job := enqueue(t, st, `{}`)

	started := make(chan struct{})
	stopped := make(chan error, 1)
	var log bytes.Buffer
	pool := startPool(t, st, &log, func(ctx context.Context, job Job) error {
		close(started)
		<-ctx.Done()
		stopped <- context.Cause(ctx)
		return ctx.Err()
	})
	defer pool.Stop()

	<-started
	clock.Advance(time.Minute)
	select {
	case cause := <-stopped:
		if !errors.Is(cause, ErrLeaseLost) {
			t.Fatalf("handler stopped with cause %v, want ErrLeaseLost", cause)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("handler still running after its lease expired")
	}

	waitFor(t, "lease.lost logged", func() bool {
		pool.log.mu.Lock()
		defer pool.log.mu.Unlock()
		return strings.Contains(log.String(), "event="+EventLeaseLost)
	})
	if got := stateOf(st, job.ID); got != StateLeased {
		t.Fatalf("state = %s, want leased until the reaper runs: the stale worker must not fail it", got)
	}
}
