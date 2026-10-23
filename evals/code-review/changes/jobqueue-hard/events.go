package jobqueue

// Event names. Every Logger.Event call uses one of these, so dashboards and
// alerts can match on them.
const (
	EventJobEnqueued  = "job.enqueued"
	EventJobCompleted = "job.completed"
	EventJobFailed    = "job.failed"
	EventLeaseLost    = "lease.lost"
	EventLeasesReaped = "lease.reaped"
	EventStoreError   = "store.error"
	EventAdminError   = "admin.error"

	// EventJobCanceled and EventJobRetried record an operator's action.
	EventJobCanceled = "job.canceled"
	EventJobRetried  = "job.retried"
	// EventHandlerCanceled records a worker giving up on a job that was
	// canceled while it ran.
	EventHandlerCanceled = "handler.canceled"
)
