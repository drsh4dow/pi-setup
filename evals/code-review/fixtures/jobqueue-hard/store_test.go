package jobqueue

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestLeaseTakesEarliestDueJobFirst(t *testing.T) {
	st, _ := newTestStore(t)
	first := enqueue(t, st, `{"n":1}`)
	second := enqueue(t, st, `{"n":2}`)
	if _, err := st.Enqueue(EnqueueRequest{Queue: testQueue, Payload: []byte(`{"n":3}`), Delay: time.Minute}); err != nil {
		t.Fatal(err)
	}

	if got := lease(t, st); got.ID != first.ID {
		t.Fatalf("first lease = %s, want %s", got.ID, first.ID)
	}
	if got := lease(t, st); got.ID != second.ID {
		t.Fatalf("second lease = %s, want %s", got.ID, second.ID)
	}
	if _, err := st.Lease(testQueue, "w1", time.Minute); !errors.Is(err, ErrNoJob) {
		t.Fatalf("third lease err = %v, want ErrNoJob while the delayed job isn't due", err)
	}
}

func TestEnqueueDefaults(t *testing.T) {
	st, _ := newTestStore(t)
	job, err := st.Enqueue(EnqueueRequest{Payload: []byte(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	if job.Queue != DefaultQueue || job.MaxAttempts != testOptions.DefaultMaxAttempts || job.State != StatePending {
		t.Fatalf("job = %+v, want pending on %q with %d attempts", job, DefaultQueue, testOptions.DefaultMaxAttempts)
	}
}

func TestExpiredLeaseIsRejectedBeforeReaping(t *testing.T) {
	st, clock := newTestStore(t)
	enqueue(t, st, `{}`)
	leased := lease(t, st)

	clock.Advance(time.Minute)
	if _, err := st.Complete(leased.ID, leased.LeaseToken); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Complete after expiry err = %v, want ErrLeaseLost", err)
	}
	if _, err := st.Extend(leased.ID, leased.LeaseToken, time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Extend after expiry err = %v, want ErrLeaseLost", err)
	}
}

func TestCompleteNeedsTheCurrentToken(t *testing.T) {
	st, _ := newTestStore(t)
	enqueue(t, st, `{}`)
	leased := lease(t, st)

	if _, err := st.Complete(leased.ID, "lease_forged"); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Complete with a forged token err = %v, want ErrLeaseLost", err)
	}
	done, err := st.Complete(leased.ID, leased.LeaseToken)
	if err != nil {
		t.Fatal(err)
	}
	if done.State != StateDone || done.LeaseToken != "" {
		t.Fatalf("completed job = %+v, want done with no lease", done)
	}
}

func TestFailRequeuesAfterBackoff(t *testing.T) {
	st, clock := newTestStore(t)
	enqueue(t, st, `{}`)

	first := lease(t, st)
	failed, err := st.Fail(first.ID, first.LeaseToken, "smtp timeout")
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != StatePending || failed.Attempts != 1 || failed.LastError != "smtp timeout" {
		t.Fatalf("failed job = %+v, want pending after 1 attempt", failed)
	}
	if want := clock.Now().Add(time.Second); !failed.RunAt.Equal(want) {
		t.Fatalf("runAt = %v, want %v", failed.RunAt, want)
	}

	if _, err := st.Lease(testQueue, "w1", time.Minute); !errors.Is(err, ErrNoJob) {
		t.Fatalf("lease during backoff err = %v, want ErrNoJob", err)
	}
	clock.Advance(time.Second)
	if second := lease(t, st); second.ID != first.ID || second.Attempts != 2 {
		t.Fatalf("second lease = %+v, want attempt 2 of %s", second, first.ID)
	}
}

func TestLastFailedAttemptKillsJob(t *testing.T) {
	st, clock := newTestStore(t)
	enqueue(t, st, `{}`)

	var job Job
	for attempt := 1; attempt <= testOptions.DefaultMaxAttempts; attempt++ {
		leased := lease(t, st)
		var err error
		if job, err = st.Fail(leased.ID, leased.LeaseToken, "bounced"); err != nil {
			t.Fatal(err)
		}
		clock.Advance(time.Hour)
	}
	if job.State != StateDead || job.Attempts != testOptions.DefaultMaxAttempts {
		t.Fatalf("job = %+v, want dead after %d attempts", job, testOptions.DefaultMaxAttempts)
	}
	if _, err := st.Lease(testQueue, "w1", time.Minute); !errors.Is(err, ErrNoJob) {
		t.Fatalf("lease of a dead job err = %v, want ErrNoJob", err)
	}
}

func TestReapExpiredRequeuesLeases(t *testing.T) {
	st, clock := newTestStore(t)
	enqueue(t, st, `{}`)
	leased := lease(t, st)

	if reaped, err := st.ReapExpired(); err != nil || reaped != 0 {
		t.Fatalf("ReapExpired before expiry = %d, %v; want 0", reaped, err)
	}
	clock.Advance(time.Minute)
	if reaped, err := st.ReapExpired(); err != nil || reaped != 1 {
		t.Fatalf("ReapExpired after expiry = %d, %v; want 1", reaped, err)
	}

	job, err := st.Get(leased.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.State != StatePending || job.Attempts != 1 || job.LastError != "lease expired" {
		t.Fatalf("reaped job = %+v, want pending, attempt 1 counted", job)
	}
}

func TestReopenRestoresJobsAndReadyHeap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.journal")
	clock := newFakeClock()
	st, err := Open(path, clock, testOptions)
	if err != nil {
		t.Fatal(err)
	}
	done := enqueue(t, st, `{"n":1}`)
	pending := enqueue(t, st, `{"n":2}`)
	leased := lease(t, st)
	if _, err := st.Complete(leased.ID, leased.LeaseToken); err != nil {
		t.Fatal(err)
	}
	st.Close()

	reopened := openTestStore(t, path, clock)
	if job, err := reopened.Get(done.ID); err != nil || job.State != StateDone {
		t.Fatalf("done job after reopen = %+v, %v", job, err)
	}
	if got := lease(t, reopened); got.ID != pending.ID {
		t.Fatalf("lease after reopen = %s, want %s", got.ID, pending.ID)
	}
}

func TestFailedAppendLeavesStoreUnchanged(t *testing.T) {
	st, _ := newTestStore(t)
	job := enqueue(t, st, `{}`)
	st.journal.Close()

	if _, err := st.Enqueue(EnqueueRequest{Queue: testQueue, Payload: []byte(`{}`)}); err == nil {
		t.Fatal("Enqueue succeeded on a closed journal")
	}
	if _, err := st.Lease(testQueue, "w1", time.Minute); err == nil {
		t.Fatal("Lease succeeded on a closed journal")
	}
	if got := st.List(Filter{}); len(got) != 1 || got[0].State != StatePending {
		t.Fatalf("jobs = %+v, want only %s, still pending", got, job.ID)
	}
}

func TestListAndStats(t *testing.T) {
	st, _ := newTestStore(t)
	enqueue(t, st, `{}`)
	enqueue(t, st, `{}`)
	if _, err := st.Enqueue(EnqueueRequest{Queue: "reports", Payload: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	lease(t, st)

	if got := st.List(Filter{Queue: testQueue, State: StatePending}); len(got) != 1 {
		t.Fatalf("pending mail jobs = %d, want 1", len(got))
	}
	stats := st.Stats()
	if stats[testQueue][StateLeased] != 1 || stats[testQueue][StatePending] != 1 || stats["reports"][StatePending] != 1 {
		t.Fatalf("stats = %v", stats)
	}
}

func TestBackoffDoublesUpToMax(t *testing.T) {
	b := Backoff{Base: time.Second, Max: 5 * time.Second}
	for attempt, want := range map[int]time.Duration{1: time.Second, 2: 2 * time.Second, 3: 4 * time.Second, 4: 5 * time.Second, 30: 5 * time.Second} {
		if got := b.Delay(attempt); got != want {
			t.Errorf("Delay(%d) = %v, want %v", attempt, got, want)
		}
	}
}
