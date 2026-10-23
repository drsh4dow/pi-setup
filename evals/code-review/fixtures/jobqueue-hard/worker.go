package jobqueue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Handler does the work of one job. Its context is canceled when the lease
// is lost or the pool stops.
type Handler func(ctx context.Context, job Job) error

// PoolConfig configures a Pool.
type PoolConfig struct {
	Queue string
	// Workers defaults to 1.
	Workers int
	// LeaseTTL defaults to 30 seconds.
	LeaseTTL time.Duration
	// Heartbeat is how often a worker extends its lease. Defaults to
	// LeaseTTL / 3.
	Heartbeat time.Duration
	// PollEvery is how long an idle worker waits before it asks for a job
	// again. Defaults to 100ms.
	PollEvery time.Duration
}

// Pool runs workers that lease jobs from one queue and hand them to a
// Handler.
type Pool struct {
	store   *Store
	cfg     PoolConfig
	handler Handler
	log     *Logger

	stop context.CancelFunc
	wg   sync.WaitGroup
}

// NewPool returns a Pool that is not running yet.
func NewPool(store *Store, cfg PoolConfig, handler Handler, log *Logger) *Pool {
	if cfg.Workers <= 0 {
		cfg.Workers = 1
	}
	if cfg.LeaseTTL <= 0 {
		cfg.LeaseTTL = 30 * time.Second
	}
	if cfg.Heartbeat <= 0 {
		cfg.Heartbeat = cfg.LeaseTTL / 3
	}
	if cfg.PollEvery <= 0 {
		cfg.PollEvery = 100 * time.Millisecond
	}
	return &Pool{store: store, cfg: cfg, handler: handler, log: log}
}

// Start launches the workers. Call it once.
func (p *Pool) Start() {
	ctx, stop := context.WithCancel(context.Background())
	p.stop = stop
	for i := range p.cfg.Workers {
		worker := fmt.Sprintf("%s-%d", p.cfg.Queue, i+1)
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			p.loop(ctx, worker)
		}()
	}
}

// Stop cancels running handlers and waits for every worker to return. A
// job whose handler was interrupted keeps its lease until it expires, and
// the reaper requeues it.
func (p *Pool) Stop() {
	p.stop()
	p.wg.Wait()
}

func (p *Pool) loop(ctx context.Context, worker string) {
	for ctx.Err() == nil {
		job, err := p.store.Lease(p.cfg.Queue, worker, p.cfg.LeaseTTL)
		if err != nil {
			if !errors.Is(err, ErrNoJob) {
				p.log.Event(EventStoreError, "worker", worker, "error", err)
			}
			p.idle(ctx)
			continue
		}
		p.run(ctx, job)
	}
}

func (p *Pool) idle(ctx context.Context) {
	timer := time.NewTimer(p.cfg.PollEvery)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// run hands job to the handler while a heartbeat keeps its lease alive,
// then reports the outcome to the store.
func (p *Pool) run(ctx context.Context, job Job) {
	jobCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	done := make(chan struct{})
	var heartbeat sync.WaitGroup
	heartbeat.Add(1)
	go func() {
		defer heartbeat.Done()
		p.heartbeat(jobCtx, cancel, job, done)
	}()

	err := p.call(jobCtx, job)
	close(done)
	heartbeat.Wait()

	if cause := context.Cause(jobCtx); errors.Is(cause, ErrLeaseLost) {
		p.log.Event(EventLeaseLost, "id", job.ID, "queue", job.Queue, "attempt", job.Attempts)
		return
	}
	if err != nil && ctx.Err() != nil {
		return
	}

	if err == nil {
		if _, err := p.store.Complete(job.ID, job.LeaseToken); err != nil {
			p.log.Event(EventStoreError, "id", job.ID, "error", err)
			return
		}
		p.log.Event(EventJobCompleted, "id", job.ID, "queue", job.Queue, "attempt", job.Attempts)
		return
	}

	failed, failErr := p.store.Fail(job.ID, job.LeaseToken, err.Error())
	if failErr != nil {
		p.log.Event(EventStoreError, "id", job.ID, "error", failErr)
		return
	}
	p.log.Event(EventJobFailed, "id", job.ID, "queue", job.Queue, "attempt", job.Attempts, "state", failed.State, "error", err)
}

// heartbeat extends job's lease every Heartbeat until done closes. When an
// extension fails it cancels the handler's context with the error as cause.
func (p *Pool) heartbeat(ctx context.Context, cancel context.CancelCauseFunc, job Job, done <-chan struct{}) {
	ticker := time.NewTicker(p.cfg.Heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := p.store.Extend(job.ID, job.LeaseToken, p.cfg.LeaseTTL); err != nil {
				cancel(err)
				return
			}
		}
	}
}

func (p *Pool) call(ctx context.Context, job Job) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panicked: %v", r)
		}
	}()
	return p.handler(ctx, job)
}
