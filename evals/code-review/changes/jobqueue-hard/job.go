package jobqueue

import (
	"fmt"
	"time"
)

// State is where a job is in its life. A job starts pending, a worker's
// lease moves it to leased, and the lease ends in done, back in pending for
// another attempt, or in dead once the job has used its last attempt.
// done and dead are final: nothing moves a job out of them.
type State string

const (
	StatePending State = "pending"
	StateLeased  State = "leased"
	StateDone    State = "done"
	StateDead    State = "dead"
	// StateCanceled is where an operator's cancel leaves a pending or leased
	// job. It is final too.
	StateCanceled State = "canceled"
)

// States lists every state in lifecycle order.
var States = []State{StatePending, StateLeased, StateDone, StateDead, StateCanceled}

// ParseState returns the State named name.
func ParseState(name string) (State, error) {
	for _, state := range States {
		if string(state) == name {
			return state, nil
		}
	}
	return "", fmt.Errorf("unknown state %q", name)
}

// Job is one unit of work and everything the queue knows about it.
type Job struct {
	ID    string `json:"id"`
	Seq   uint64 `json:"seq"`
	Queue string `json:"queue"`
	// Payload is the job's JSON input. It can carry customer data, so it
	// stays out of logs and out of the admin API for viewers.
	Payload     []byte    `json:"payload"`
	State       State     `json:"state"`
	Attempts    int       `json:"attempts"`
	MaxAttempts int       `json:"maxAttempts"`
	RunAt       time.Time `json:"runAt"`

	LeaseOwner   string    `json:"leaseOwner,omitempty"`
	LeaseToken   string    `json:"leaseToken,omitempty"`
	LeaseExpires time.Time `json:"leaseExpires"`

	LastError string `json:"lastError,omitempty"`
	// CancelReason is what the operator gave when canceling the job.
	CancelReason string    `json:"cancelReason,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (j *Job) clearLease() {
	j.LeaseOwner = ""
	j.LeaseToken = ""
	j.LeaseExpires = time.Time{}
}
