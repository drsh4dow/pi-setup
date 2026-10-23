package jobqueue

import (
	"container/heap"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	// ErrNotFound means no job has the given ID.
	ErrNotFound = errors.New("job not found")
	// ErrNoJob means the queue has no job due.
	ErrNoJob = errors.New("no job due")
	// ErrLeaseLost means a lease token no longer holds its job: the lease
	// expired, or the job has moved on.
	ErrLeaseLost = errors.New("lease lost")
	// ErrInvalid means a request to the store is malformed.
	ErrInvalid = errors.New("invalid job")
	// ErrCanceled means an operator canceled the job. It is a kind of
	// ErrLeaseLost, so callers that only handle lost leases still work.
	ErrCanceled = fmt.Errorf("%w: job canceled", ErrLeaseLost)
	// ErrNotCancelable means the job is past the point where it can be
	// canceled.
	ErrNotCancelable = errors.New("job can't be canceled")
	// ErrNotDead means a retry named a job that isn't dead.
	ErrNotDead = errors.New("job isn't dead")
)

// StateError is a store operation refused because of the job's state. Err
// says which operation.
type StateError struct {
	ID    string
	State State
	Err   error
}

func (e *StateError) Error() string {
	return fmt.Sprintf("job %s is %s: %v", e.ID, e.State, e.Err)
}

func (e *StateError) Unwrap() error { return e.Err }

// DefaultQueue is where jobs enqueued without a queue go.
const DefaultQueue = "default"

// Options configures a Store.
type Options struct {
	// DefaultMaxAttempts applies to jobs enqueued without MaxAttempts.
	// Defaults to 5.
	DefaultMaxAttempts int
	// Backoff spaces out a job's attempts. Defaults to DefaultBackoff.
	Backoff Backoff
}

// Store holds every job in memory and records each change in its journal
// before making it. See docs/design.md.
type Store struct {
	mu      sync.Mutex
	clock   Clock
	opts    Options
	journal *Journal
	jobs    map[string]*Job
	ready   map[string]*readyHeap
	seq     uint64
}

// Open replays the journal at path, creating it if needed, and returns a
// Store backed by it.
func Open(path string, clock Clock, opts Options) (*Store, error) {
	if opts.DefaultMaxAttempts <= 0 {
		opts.DefaultMaxAttempts = 5
	}
	if opts.Backoff == (Backoff{}) {
		opts.Backoff = DefaultBackoff
	}

	journal, jobs, err := OpenJournal(path)
	if err != nil {
		return nil, err
	}

	s := &Store{
		clock:   clock,
		opts:    opts,
		journal: journal,
		jobs:    map[string]*Job{},
		ready:   map[string]*readyHeap{},
	}
	for _, j := range jobs {
		s.jobs[j.ID] = j
		s.seq = max(s.seq, j.Seq)
		if j.State == StatePending {
			s.push(j)
		}
	}
	return s, nil
}

// Close closes the store's journal.
func (s *Store) Close() error {
	return s.journal.Close()
}

// EnqueueRequest describes a new job.
type EnqueueRequest struct {
	// Queue defaults to DefaultQueue.
	Queue   string
	Payload []byte
	// MaxAttempts defaults to the store's DefaultMaxAttempts.
	MaxAttempts int
	// Delay postpones the job's first attempt.
	Delay time.Duration
}

// Enqueue adds a pending job.
func (s *Store) Enqueue(req EnqueueRequest) (Job, error) {
	if req.MaxAttempts < 0 || req.Delay < 0 {
		return Job{}, fmt.Errorf("%w: maxAttempts and delay can't be negative", ErrInvalid)
	}
	queue := req.Queue
	if queue == "" {
		queue = DefaultQueue
	}
	maxAttempts := req.MaxAttempts
	if maxAttempts == 0 {
		maxAttempts = s.opts.DefaultMaxAttempts
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock.Now()
	s.seq++
	job := Job{
		ID:          newID("job"),
		Seq:         s.seq,
		Queue:       queue,
		Payload:     req.Payload,
		State:       StatePending,
		MaxAttempts: maxAttempts,
		RunAt:       now.Add(req.Delay),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.journal.Append(opEnqueue, job); err != nil {
		return Job{}, fmt.Errorf("enqueue job %s: %w", job.ID, err)
	}
	stored := job
	s.jobs[job.ID] = &stored
	s.push(&stored)
	return job, nil
}

// Lease hands the earliest due job on queue to worker for ttl, counting a
// new attempt. It returns ErrNoJob when nothing on the queue is due.
func (s *Store) Lease(queue, worker string, ttl time.Duration) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock.Now()
	ready := s.ready[queue]
	if ready == nil || ready.peek() == nil || ready.peek().RunAt.After(now) {
		return Job{}, ErrNoJob
	}

	j := ready.peek()
	next := *j
	next.State = StateLeased
	next.Attempts++
	next.LeaseOwner = worker
	next.LeaseToken = newID("lease")
	next.LeaseExpires = now.Add(ttl)
	if err := s.commit(j, opLease, next); err != nil {
		return Job{}, err
	}
	heap.Pop(ready)
	return *j, nil
}

// Extend pushes a lease's expiry to ttl from now.
func (s *Store) Extend(id, token string, ttl time.Duration) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, err := s.leased(id, token)
	if err != nil {
		return Job{}, fmt.Errorf("extend job %s: %w", id, err)
	}
	next := *j
	next.LeaseExpires = s.clock.Now().Add(ttl)
	if err := s.commit(j, opExtend, next); err != nil {
		return Job{}, err
	}
	return *j, nil
}

// Complete ends a lease with success.
func (s *Store) Complete(id, token string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, err := s.leased(id, token)
	if err != nil {
		return Job{}, fmt.Errorf("complete job %s: %w", id, err)
	}
	next := *j
	next.State = StateDone
	next.clearLease()
	if err := s.commit(j, opComplete, next); err != nil {
		return Job{}, err
	}
	return *j, nil
}

// Fail ends a lease with an error, and requeues the job.
func (s *Store) Fail(id, token, reason string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, err := s.leased(id, token)
	if err != nil {
		return Job{}, fmt.Errorf("fail job %s: %w", id, err)
	}
	if err := s.commit(j, opFail, s.requeue(*j, reason)); err != nil {
		return Job{}, err
	}
	return *j, nil
}

// ReapExpired requeues every leased job whose lease has expired and
// returns how many it requeued.
func (s *Store) ReapExpired() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.clock.Now()
	reaped := 0
	for _, j := range s.sorted() {
		if j.State != StateLeased || now.Before(j.LeaseExpires) {
			continue
		}
		if err := s.commit(j, opExpire, s.requeue(*j, "lease expired")); err != nil {
			return reaped, err
		}
		reaped++
	}
	return reaped, nil
}

// Cancel stops a pending or leased job for good and records reason. A
// leased job's token stops working at once, so its worker can't complete
// or fail the job.
func (s *Store) Cancel(id, reason string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, err := s.find("cancel", id)
	if err != nil {
		return Job{}, err
	}
	if j.State != StatePending && j.State != StateLeased {
		return Job{}, fmt.Errorf("cancel job %s: %w", id, &StateError{ID: id, State: j.State, Err: ErrNotCancelable})
	}

	next := *j
	next.State = StateCanceled
	next.CancelReason = reason
	next.clearLease()
	if err := s.commit(j, opCancel, next); err != nil {
		return Job{}, err
	}
	return *j, nil
}

// Requeue moves a dead job back to pending, due now, with its attempts
// reset to zero. A maxAttempts of zero means the default.
func (s *Store) Requeue(id string, maxAttempts int) (Job, error) {
	if maxAttempts < 0 {
		return Job{}, fmt.Errorf("retry job %s: %w: maxAttempts can't be negative", id, ErrInvalid)
	}
	if maxAttempts == 0 {
		maxAttempts = s.opts.DefaultMaxAttempts
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	j, err := s.find("retry", id)
	if err != nil {
		return Job{}, err
	}
	if j.State != StateDead {
		return Job{}, fmt.Errorf("retry job %s: %w", id, &StateError{ID: id, State: j.State, Err: ErrNotDead})
	}

	next := *j
	next.State = StatePending
	next.Attempts = 0
	next.MaxAttempts = maxAttempts
	next.RunAt = s.clock.Now()
	if err := s.commit(j, opRetry, next); err != nil {
		return Job{}, err
	}
	return *j, nil
}

// Get returns the job with the given ID.
func (s *Store) Get(id string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, err := s.find("get", id)
	if err != nil {
		return Job{}, err
	}
	return *j, nil
}

// Filter narrows List. Empty fields match everything.
type Filter struct {
	Queue string
	State State
}

// List returns the jobs matching f in enqueue order.
func (s *Store) List(f Filter) []Job {
	s.mu.Lock()
	defer s.mu.Unlock()

	var jobs []Job
	for _, j := range s.sorted() {
		if f.Queue != "" && j.Queue != f.Queue {
			continue
		}
		if f.State != "" && j.State != f.State {
			continue
		}
		jobs = append(jobs, *j)
	}
	return jobs
}

// Stats counts jobs by queue and state.
func (s *Store) Stats() map[string]map[State]int {
	s.mu.Lock()
	defer s.mu.Unlock()

	stats := map[string]map[State]int{}
	for _, j := range s.jobs {
		if stats[j.Queue] == nil {
			stats[j.Queue] = map[State]int{}
		}
		stats[j.Queue][j.State]++
	}
	return stats
}

// find returns the stored job with the given ID, or an error that names op.
func (s *Store) find(op, id string) (*Job, error) {
	j, ok := s.jobs[id]
	if !ok {
		return nil, fmt.Errorf("%s job %s: %w", op, id, ErrNotFound)
	}
	return j, nil
}

// leased returns the job if token is its current, unexpired lease. A
// canceled job answers ErrCanceled whatever the token.
func (s *Store) leased(id, token string) (*Job, error) {
	j, ok := s.jobs[id]
	if !ok {
		return nil, ErrNotFound
	}
	switch {
	case j.State == StateCanceled:
		return nil, ErrCanceled
	case j.State != StateLeased, j.LeaseToken != token, !s.clock.Now().Before(j.LeaseExpires):
		return nil, ErrLeaseLost
	}
	return j, nil
}

// requeue returns job as it is after a failed attempt: back in pending
// after its backoff, or dead if that was its last attempt. The attempt
// counts either way.
func (s *Store) requeue(job Job, reason string) Job {
	job.clearLease()
	job.LastError = reason
	if job.Attempts >= job.MaxAttempts {
		job.State = StateDead
		return job
	}
	job.State = StatePending
	job.RunAt = s.clock.Now().Add(s.opts.Backoff.Delay(job.Attempts))
	return job
}

// commit journals next under op and then makes it the stored job j. A job
// that enters pending joins its queue's ready heap.
func (s *Store) commit(j *Job, op string, next Job) error {
	next.UpdatedAt = s.clock.Now()
	if err := s.journal.Append(op, next); err != nil {
		return fmt.Errorf("%s job %s: %w", op, j.ID, err)
	}
	entersPending := next.State == StatePending && j.State != StatePending
	*j = next
	if entersPending {
		s.push(j)
	}
	return nil
}

func (s *Store) sorted() []*Job {
	jobs := make([]*Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		jobs = append(jobs, j)
	}
	sort.Slice(jobs, func(a, b int) bool { return jobs[a].Seq < jobs[b].Seq })
	return jobs
}

func newID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("read random bytes: %v", err))
	}
	return prefix + "_" + hex.EncodeToString(b)
}
