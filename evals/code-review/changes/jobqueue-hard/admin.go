package jobqueue

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Role is what a token may do. Roles are ordered: a role may do everything
// the roles before it may.
type Role int

const (
	// RoleViewer lists and reads jobs, without payloads.
	RoleViewer Role = iota + 1
	// RoleOperator also sees payloads and changes jobs.
	RoleOperator
	// RoleAuditor is for support staff who need to see what a job was
	// given: it reads jobs like a viewer, payloads included.
	RoleAuditor
)

// ParseRole returns the Role named name.
func ParseRole(name string) (Role, error) {
	switch name {
	case "viewer":
		return RoleViewer, nil
	case "operator":
		return RoleOperator, nil
	case "auditor":
		return RoleAuditor, nil
	}
	return 0, fmt.Errorf("unknown role %q", name)
}

// ParseTokens parses "token=role,token=role" into a token table. Errors
// name entries by position, never by token.
func ParseTokens(spec string) (map[string]Role, error) {
	tokens := map[string]Role{}
	for i, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		token, name, ok := strings.Cut(entry, "=")
		if !ok || token == "" {
			return nil, fmt.Errorf("token entry %d: want token=role", i+1)
		}
		role, err := ParseRole(name)
		if err != nil {
			return nil, fmt.Errorf("token entry %d: %w", i+1, err)
		}
		tokens[token] = role
	}
	return tokens, nil
}

// Admin serves the admin API.
type Admin struct {
	store  *Store
	tokens map[string]Role
	log    *Logger
}

// NewAdmin returns an Admin that accepts the given tokens.
func NewAdmin(store *Store, tokens map[string]Role, log *Logger) *Admin {
	return &Admin{store: store, tokens: tokens, log: log}
}

// Handler routes the admin API.
func (a *Admin) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /jobs", a.auth(RoleViewer, a.listJobs))
	mux.Handle("GET /jobs/{id}", a.auth(RoleViewer, a.getJob))
	mux.Handle("POST /jobs", a.auth(RoleOperator, a.enqueue))
	mux.Handle("POST /jobs/{id}/cancel", a.auth(RoleOperator, a.cancelJob))
	mux.Handle("POST /jobs/{id}/retry", a.auth(RoleOperator, a.retryJob))
	mux.Handle("GET /stats", a.auth(RoleViewer, a.stats))
	return mux
}

type roleHandler func(w http.ResponseWriter, r *http.Request, role Role)

// auth admits requests whose bearer token has at least the role need.
func (a *Admin) auth(need Role, h roleHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, hasBearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		role, known := a.tokens[token]
		if !hasBearer || !known {
			writeError(w, http.StatusUnauthorized, "unauthorized", nil)
			return
		}
		if role < need {
			writeError(w, http.StatusForbidden, "forbidden", nil)
			return
		}
		h(w, r, role)
	})
}

func (a *Admin) listJobs(w http.ResponseWriter, r *http.Request, _ Role) {
	filter := Filter{Queue: r.URL.Query().Get("queue")}
	if name := r.URL.Query().Get("state"); name != "" {
		state, err := ParseState(name)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid", map[string]any{"message": err.Error()})
			return
		}
		filter.State = state
	}

	jobs := a.store.List(filter)
	views := make([]jobView, 0, len(jobs))
	for _, job := range jobs {
		views = append(views, view(job, false))
	}
	writeJSON(w, http.StatusOK, views)
}

func (a *Admin) getJob(w http.ResponseWriter, r *http.Request, role Role) {
	job, err := a.store.Get(r.PathValue("id"))
	if err != nil {
		a.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view(job, role >= RoleOperator))
}

type enqueueBody struct {
	Queue        string          `json:"queue"`
	Payload      json.RawMessage `json:"payload"`
	MaxAttempts  int             `json:"maxAttempts"`
	DelaySeconds int             `json:"delaySeconds"`
}

func (a *Admin) enqueue(w http.ResponseWriter, r *http.Request, _ Role) {
	var body enqueueBody
	if err := decodeBody(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", map[string]any{"message": err.Error()})
		return
	}
	if !json.Valid(body.Payload) {
		writeError(w, http.StatusBadRequest, "invalid", map[string]any{"message": "payload must be JSON"})
		return
	}

	job, err := a.store.Enqueue(EnqueueRequest{
		Queue:       body.Queue,
		Payload:     body.Payload,
		MaxAttempts: body.MaxAttempts,
		Delay:       time.Duration(body.DelaySeconds) * time.Second,
	})
	if err != nil {
		a.writeStoreError(w, err)
		return
	}
	a.log.Event(EventJobEnqueued, "id", job.ID, "queue", job.Queue)
	writeJSON(w, http.StatusCreated, view(job, true))
}

type cancelBody struct {
	Reason string `json:"reason"`
}

func (a *Admin) cancelJob(w http.ResponseWriter, r *http.Request, _ Role) {
	var body cancelBody
	if err := decodeOptionalBody(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", map[string]any{"message": err.Error()})
		return
	}

	job, err := a.store.Cancel(r.PathValue("id"), body.Reason)
	if err != nil {
		a.writeStoreError(w, err)
		return
	}
	a.log.Event(EventJobCanceled, "id", job.ID, "queue", job.Queue, "reason", job.CancelReason)
	writeJSON(w, http.StatusOK, view(job, true))
}

type retryBody struct {
	MaxAttempts int `json:"maxAttempts"`
}

func (a *Admin) retryJob(w http.ResponseWriter, r *http.Request, _ Role) {
	var body retryBody
	if err := decodeOptionalBody(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", map[string]any{"message": err.Error()})
		return
	}

	job, err := a.store.Requeue(r.PathValue("id"), body.MaxAttempts)
	if err != nil {
		a.writeStoreError(w, err)
		return
	}
	a.log.Event(EventJobRetried, "id", job.ID, "queue", job.Queue, "maxAttempts", job.MaxAttempts)
	writeJSON(w, http.StatusOK, view(job, true))
}

func (a *Admin) stats(w http.ResponseWriter, _ *http.Request, _ Role) {
	writeJSON(w, http.StatusOK, a.store.Stats())
}

// jobView is how the admin API shows a job. The lease token never leaves
// the store except to the worker holding the lease.
type jobView struct {
	ID           string          `json:"id"`
	Queue        string          `json:"queue"`
	State        State           `json:"state"`
	Attempts     int             `json:"attempts"`
	MaxAttempts  int             `json:"maxAttempts"`
	RunAt        time.Time       `json:"runAt"`
	LeaseOwner   string          `json:"leaseOwner,omitempty"`
	LeaseExpires *time.Time      `json:"leaseExpires,omitempty"`
	LastError    string          `json:"lastError,omitempty"`
	CancelReason string          `json:"cancelReason,omitempty"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
	Payload      json.RawMessage `json:"payload,omitempty"`
}

func view(job Job, withPayload bool) jobView {
	v := jobView{
		ID:           job.ID,
		Queue:        job.Queue,
		State:        job.State,
		Attempts:     job.Attempts,
		MaxAttempts:  job.MaxAttempts,
		RunAt:        job.RunAt,
		LeaseOwner:   job.LeaseOwner,
		LastError:    job.LastError,
		CancelReason: job.CancelReason,
		CreatedAt:    job.CreatedAt,
		UpdatedAt:    job.UpdatedAt,
	}
	if job.State == StateLeased {
		expires := job.LeaseExpires
		v.LeaseExpires = &expires
	}
	if withPayload {
		v.Payload = job.Payload
	}
	return v
}

// conflictCodes names the 409 answer for each StateError the store returns.
var conflictCodes = map[error]string{
	ErrNotCancelable: "not_cancelable",
	ErrNotDead:       "not_dead",
}

// writeStoreError is the one place store errors become HTTP responses.
func (a *Admin) writeStoreError(w http.ResponseWriter, err error) {
	var refused *StateError
	switch {
	case errors.As(err, &refused) && conflictCodes[refused.Err] != "":
		writeError(w, http.StatusConflict, conflictCodes[refused.Err], map[string]any{"state": refused.State})
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", nil)
	case errors.Is(err, ErrInvalid):
		writeError(w, http.StatusBadRequest, "invalid", map[string]any{"message": err.Error()})
	default:
		a.log.Event(EventAdminError, "error", err)
		writeError(w, http.StatusInternalServerError, "internal", nil)
	}
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(v)
}

// decodeOptionalBody is decodeBody for endpoints whose body may be left out.
func decodeOptionalBody(w http.ResponseWriter, r *http.Request, v any) error {
	if err := decodeBody(w, r, v); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func writeError(w http.ResponseWriter, status int, code string, fields map[string]any) {
	body := map[string]any{"error": code}
	for key, value := range fields {
		body[key] = value
	}
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
