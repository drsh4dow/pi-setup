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

// kill fails a job on testQueue until it is dead.
func kill(t *testing.T, st *Store, clock *fakeClock) Job {
	t.Helper()
	job := enqueue(t, st, `{"to":"ana@example.com"}`)
	for job.State != StateDead {
		leased := lease(t, st)
		var err error
		if job, err = st.Fail(leased.ID, leased.LeaseToken, "mailbox full"); err != nil {
			t.Fatal(err)
		}
		clock.Advance(time.Hour)
	}
	return job
}

func TestCancelPendingJob(t *testing.T) {
	st, _ := newTestStore(t)
	job := enqueue(t, st, `{}`)

	canceled, err := st.Cancel(job.ID, "customer unsubscribed")
	if err != nil {
		t.Fatal(err)
	}
	if canceled.State != StateCanceled || canceled.CancelReason != "customer unsubscribed" {
		t.Fatalf("canceled job = %+v", canceled)
	}

	_, err = st.Cancel(job.ID, "again")
	var refused *StateError
	if !errors.Is(err, ErrNotCancelable) || !errors.As(err, &refused) || refused.State != StateCanceled {
		t.Fatalf("second Cancel err = %v, want ErrNotCancelable naming state canceled", err)
	}
}

func TestCancelRevokesLease(t *testing.T) {
	st, _ := newTestStore(t)
	enqueue(t, st, `{}`)
	leased := lease(t, st)

	if _, err := st.Cancel(leased.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Extend(leased.ID, leased.LeaseToken, time.Minute); !errors.Is(err, ErrCanceled) {
		t.Fatalf("Extend after cancel err = %v, want ErrCanceled", err)
	}
	if _, err := st.Complete(leased.ID, leased.LeaseToken); !errors.Is(err, ErrCanceled) || !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Complete after cancel err = %v, want ErrCanceled, a kind of ErrLeaseLost", err)
	}
	if job, _ := st.Get(leased.ID); job.State != StateCanceled || job.LeaseToken != "" {
		t.Fatalf("job = %+v, want canceled with no lease", job)
	}
}

func TestCancelRefusesFinishedJobs(t *testing.T) {
	st, clock := newTestStore(t)
	dead := kill(t, st, clock)
	enqueue(t, st, `{}`)
	leased := lease(t, st)
	done, err := st.Complete(leased.ID, leased.LeaseToken)
	if err != nil {
		t.Fatal(err)
	}

	for _, job := range []Job{dead, done} {
		if _, err := st.Cancel(job.ID, ""); !errors.Is(err, ErrNotCancelable) {
			t.Errorf("Cancel of a %s job err = %v, want ErrNotCancelable", job.State, err)
		}
	}
	if _, err := st.Cancel("job_nope", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("Cancel of an unknown job err = %v, want ErrNotFound", err)
	}
}

func TestCanceledJobsAreNeverLeased(t *testing.T) {
	cases := []struct {
		name  string
		delay time.Duration
	}{
		{"due now", 0},
		{"scheduled", time.Minute},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st, clock := newTestStore(t)
			job, err := st.Enqueue(EnqueueRequest{Payload: []byte(`{"to":"ana@example.com"}`), Delay: tc.delay})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := st.Cancel(job.ID, "customer unsubscribed"); err != nil {
				t.Fatal(err)
			}

			clock.Advance(time.Hour)
			if leased, err := st.Lease(testQueue, "w1", time.Minute); !errors.Is(err, ErrNoJob) {
				t.Fatalf("Lease after cancel = %+v, %v; want ErrNoJob", leased, err)
			}
		})
	}
}

func TestRequeueDeadJob(t *testing.T) {
	st, clock := newTestStore(t)
	dead := kill(t, st, clock)

	retried, err := st.Requeue(dead.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if retried.State != StatePending || retried.Attempts != 0 || !retried.RunAt.Equal(clock.Now()) {
		t.Fatalf("retried job = %+v, want pending now with no attempts", retried)
	}
	if retried.LastError != "mailbox full" {
		t.Fatalf("lastError = %q, want the error that killed it", retried.LastError)
	}
	if leased := lease(t, st); leased.ID != dead.ID || leased.Attempts != 1 {
		t.Fatalf("lease after retry = %+v, want attempt 1 of %s", leased, dead.ID)
	}
}

func TestRequeueWithNewLimit(t *testing.T) {
	st, clock := newTestStore(t)
	dead := kill(t, st, clock)

	retried, err := st.Requeue(dead.ID, 7)
	if err != nil {
		t.Fatal(err)
	}
	if retried.MaxAttempts != 7 {
		t.Fatalf("maxAttempts = %d, want 7", retried.MaxAttempts)
	}
	if _, err := st.Requeue(dead.ID, -1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Requeue with -1 attempts err = %v, want ErrInvalid", err)
	}
}

func TestRequeueOnlyDeadJobs(t *testing.T) {
	st, _ := newTestStore(t)
	job := enqueue(t, st, `{}`)

	_, err := st.Requeue(job.ID, 0)
	var refused *StateError
	if !errors.Is(err, ErrNotDead) || !errors.As(err, &refused) || refused.State != StatePending {
		t.Fatalf("Requeue of a pending job err = %v, want ErrNotDead naming state pending", err)
	}
}

func TestCancelAndRetrySurviveReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.journal")
	clock := newFakeClock()
	st, err := Open(path, clock, testOptions)
	if err != nil {
		t.Fatal(err)
	}
	dead := kill(t, st, clock)
	if _, err := st.Requeue(dead.ID, 0); err != nil {
		t.Fatal(err)
	}
	canceled := enqueue(t, st, `{}`)
	if _, err := st.Cancel(canceled.ID, "duplicate"); err != nil {
		t.Fatal(err)
	}
	st.Close()

	reopened := openTestStore(t, path, clock)
	if job, err := reopened.Get(canceled.ID); err != nil || job.State != StateCanceled || job.CancelReason != "duplicate" {
		t.Fatalf("canceled job after reopen = %+v, %v", job, err)
	}
	if leased := lease(t, reopened); leased.ID != dead.ID {
		t.Fatalf("lease after reopen = %s, want the retried job %s", leased.ID, dead.ID)
	}
}
