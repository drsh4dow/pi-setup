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
)
