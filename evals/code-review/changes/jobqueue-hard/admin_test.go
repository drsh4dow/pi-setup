package jobqueue

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var testTokens = map[string]Role{"view-tok": RoleViewer, "op-tok": RoleOperator, "audit-tok": RoleAuditor}

type adminFixture struct {
	store  *Store
	clock  *fakeClock
	server *httptest.Server
	log    *bytes.Buffer
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	st, clock := newTestStore(t)
	var log bytes.Buffer
	server := httptest.NewServer(NewAdmin(st, testTokens, NewLogger(&log)).Handler())
	t.Cleanup(server.Close)
	return &adminFixture{store: st, clock: clock, server: server, log: &log}
}

// call sends a request and decodes the JSON answer into a generic value.
func (f *adminFixture) call(t *testing.T, method, token, path, body string) (int, any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, f.server.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var decoded any
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatalf("%s %s: decode answer: %v", method, path, err)
	}
	return resp.StatusCode, decoded
}

func field(v any, key string) any {
	object, _ := v.(map[string]any)
	return object[key]
}

func TestAdminNeedsAToken(t *testing.T) {
	f := newAdminFixture(t)
	for _, token := range []string{"", "made-up"} {
		if status, body := f.call(t, "GET", token, "/jobs", ""); status != 401 || field(body, "error") != "unauthorized" {
			t.Errorf("token %q: %d %v, want 401 unauthorized", token, status, body)
		}
	}
}

func TestViewerCannotEnqueue(t *testing.T) {
	f := newAdminFixture(t)
	status, body := f.call(t, "POST", "view-tok", "/jobs", `{"queue":"mail","payload":{}}`)
	if status != 403 || field(body, "error") != "forbidden" {
		t.Fatalf("viewer enqueue: %d %v, want 403 forbidden", status, body)
	}
}

func TestOperatorEnqueuesAndSeesPayload(t *testing.T) {
	f := newAdminFixture(t)
	status, created := f.call(t, "POST", "op-tok", "/jobs", `{"queue":"mail","payload":{"to":"ana@example.com"},"maxAttempts":2}`)
	if status != 201 || field(created, "state") != "pending" || field(created, "maxAttempts") != 2.0 {
		t.Fatalf("enqueue: %d %v", status, created)
	}
	if strings.Contains(f.log.String(), "ana@example.com") {
		t.Fatalf("log leaks the payload: %q", f.log.String())
	}

	id := field(created, "id").(string)
	_, asOperator := f.call(t, "GET", "op-tok", "/jobs/"+id, "")
	if field(field(asOperator, "payload"), "to") != "ana@example.com" {
		t.Fatalf("operator view = %v, want the payload", asOperator)
	}
	_, asViewer := f.call(t, "GET", "view-tok", "/jobs/"+id, "")
	if field(asViewer, "payload") != nil || field(asViewer, "leaseToken") != nil {
		t.Fatalf("viewer view = %v, want no payload and no lease token", asViewer)
	}
}

func TestEnqueueRejectsBadBodies(t *testing.T) {
	f := newAdminFixture(t)
	for _, body := range []string{`{"queue":"mail"}`, `{"payload":{},"maxAttempts":-1}`, `{"payload":{},"priority":1}`, `not json`} {
		if status, answer := f.call(t, "POST", "op-tok", "/jobs", body); status != 400 || field(answer, "error") != "invalid" {
			t.Errorf("body %s: %d %v, want 400 invalid", body, status, answer)
		}
	}
}

func TestGetUnknownJob(t *testing.T) {
	f := newAdminFixture(t)
	if status, body := f.call(t, "GET", "view-tok", "/jobs/job_nope", ""); status != 404 || field(body, "error") != "not_found" {
		t.Fatalf("unknown job: %d %v, want 404 not_found", status, body)
	}
}

func TestListFiltersAndStats(t *testing.T) {
	f := newAdminFixture(t)
	enqueue(t, f.store, `{}`)
	enqueue(t, f.store, `{}`)
	lease(t, f.store)

	_, pending := f.call(t, "GET", "view-tok", "/jobs?state=pending", "")
	if jobs, _ := pending.([]any); len(jobs) != 1 || field(jobs[0], "payload") != nil {
		t.Fatalf("pending jobs = %v, want one, without payload", pending)
	}
	if status, _ := f.call(t, "GET", "view-tok", "/jobs?state=sleeping", ""); status != 400 {
		t.Fatalf("unknown state filter: %d, want 400", status)
	}

	_, stats := f.call(t, "GET", "view-tok", "/stats", "")
	if mail := field(stats, testQueue); field(mail, "pending") != 1.0 || field(mail, "leased") != 1.0 {
		t.Fatalf("stats = %v", stats)
	}
}

func TestParseTokens(t *testing.T) {
	tokens, err := ParseTokens("a=viewer, b=operator, c=auditor")
	if err != nil || tokens["a"] != RoleViewer || tokens["b"] != RoleOperator || tokens["c"] != RoleAuditor {
		t.Fatalf("ParseTokens = %v, %v", tokens, err)
	}
	if _, err := ParseTokens("s3cret=admin"); err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("ParseTokens error = %v, want an error that doesn't echo the token", err)
	}
}

func TestCancelThroughAdmin(t *testing.T) {
	f := newAdminFixture(t)
	job := enqueue(t, f.store, `{}`)

	status, canceled := f.call(t, "POST", "op-tok", "/jobs/"+job.ID+"/cancel", `{"reason":"duplicate send"}`)
	if status != 200 || field(canceled, "state") != "canceled" || field(canceled, "cancelReason") != "duplicate send" {
		t.Fatalf("cancel: %d %v", status, canceled)
	}
	if !strings.Contains(f.log.String(), "event="+EventJobCanceled) {
		t.Fatalf("log = %q, want a %s event", f.log.String(), EventJobCanceled)
	}

	status, again := f.call(t, "POST", "op-tok", "/jobs/"+job.ID+"/cancel", "")
	if status != 409 || field(again, "error") != "not_cancelable" || field(again, "state") != "canceled" {
		t.Fatalf("second cancel: %d %v, want 409 not_cancelable with state canceled", status, again)
	}
	if status, _ := f.call(t, "POST", "op-tok", "/jobs/job_nope/cancel", ""); status != 404 {
		t.Fatalf("cancel of an unknown job: %d, want 404", status)
	}
}

func TestRetryThroughAdmin(t *testing.T) {
	f := newAdminFixture(t)
	dead := kill(t, f.store, f.clock)

	status, retried := f.call(t, "POST", "op-tok", "/jobs/"+dead.ID+"/retry", "")
	if status != 200 || field(retried, "state") != "pending" || field(retried, "attempts") != 0.0 {
		t.Fatalf("retry: %d %v, want 200 pending with no attempts", status, retried)
	}

	status, again := f.call(t, "POST", "op-tok", "/jobs/"+dead.ID+"/retry", `{"maxAttempts":7}`)
	if status != 409 || field(again, "error") != "not_dead" || field(again, "state") != "pending" {
		t.Fatalf("retry of a pending job: %d %v, want 409 not_dead", status, again)
	}
	if status, body := f.call(t, "POST", "op-tok", "/jobs/"+dead.ID+"/retry", `{"maxAttempts":"seven"}`); status != 400 {
		t.Fatalf("retry with a bad body: %d %v, want 400", status, body)
	}
}

func TestRetryWithMaxAttemptsThroughAdmin(t *testing.T) {
	f := newAdminFixture(t)
	dead := kill(t, f.store, f.clock)

	status, retried := f.call(t, "POST", "op-tok", "/jobs/"+dead.ID+"/retry", `{"maxAttempts":7}`)
	if status != 200 || field(retried, "maxAttempts") != 7.0 {
		t.Fatalf("retry: %d %v, want maxAttempts 7", status, retried)
	}
}

func TestViewerCannotCancelOrRetry(t *testing.T) {
	f := newAdminFixture(t)
	job := enqueue(t, f.store, `{}`)

	for _, action := range []string{"cancel", "retry"} {
		status, body := f.call(t, "POST", "view-tok", "/jobs/"+job.ID+"/"+action, "")
		if status != 403 || field(body, "error") != "forbidden" {
			t.Errorf("viewer %s: %d %v, want 403 forbidden", action, status, body)
		}
	}
	if got, _ := f.store.Get(job.ID); got.State != StatePending {
		t.Fatalf("state = %s, want pending", got.State)
	}
}

func TestAuditorSeesPayloads(t *testing.T) {
	f := newAdminFixture(t)
	job := enqueue(t, f.store, `{"to":"ana@example.com"}`)

	_, one := f.call(t, "GET", "audit-tok", "/jobs/"+job.ID, "")
	if field(field(one, "payload"), "to") != "ana@example.com" {
		t.Fatalf("auditor view = %v, want the payload", one)
	}
	_, list := f.call(t, "GET", "audit-tok", "/jobs", "")
	if jobs, _ := list.([]any); len(jobs) != 1 || field(jobs[0], "payload") != nil {
		t.Fatalf("auditor list = %v, want one job without payload", list)
	}
}

func TestCanceledJobsInListAndStats(t *testing.T) {
	f := newAdminFixture(t)
	job := enqueue(t, f.store, `{}`)
	enqueue(t, f.store, `{}`)
	if _, err := f.store.Cancel(job.ID, ""); err != nil {
		t.Fatal(err)
	}

	_, canceled := f.call(t, "GET", "view-tok", "/jobs?state=canceled", "")
	if jobs, _ := canceled.([]any); len(jobs) != 1 || field(jobs[0], "id") != job.ID {
		t.Fatalf("canceled jobs = %v, want %s", canceled, job.ID)
	}
	_, stats := f.call(t, "GET", "view-tok", "/stats", "")
	if mail := field(stats, testQueue); field(mail, "canceled") != 1.0 || field(mail, "pending") != 1.0 {
		t.Fatalf("stats = %v", stats)
	}
}
