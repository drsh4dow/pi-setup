package jobqueue

import (
	"os"
	"strings"
	"testing"
)

func TestReplayVersion1Journal(t *testing.T) {
	f, err := os.Open("testdata/journal-v1.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	jobs, err := Replay(f)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]State{}
	for _, job := range jobs {
		got[job.ID] = job.State
	}
	want := map[string]State{"job_01": StateDone, "job_02": StatePending, "job_03": StateDead}
	for id, state := range want {
		if got[id] != state {
			t.Errorf("%s state = %q, want %q", id, got[id], state)
		}
	}
	if len(jobs) != len(want) {
		t.Errorf("replayed %d jobs, want %d", len(jobs), len(want))
	}
}

func TestReplayRefusesNewerVersion(t *testing.T) {
	_, err := Replay(strings.NewReader(`{"v":99}` + "\n"))
	if err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("Replay of a v99 journal err = %v, want a version error", err)
	}
}

func TestReplayRejectsUnknownOp(t *testing.T) {
	journal := `{"v":1}` + "\n" + `{"op":"teleport","job":{"id":"job_01","state":"pending"}}` + "\n"
	if _, err := Replay(strings.NewReader(journal)); err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("Replay err = %v, want an error naming line 2", err)
	}
}

func TestReplayRejectsUnknownState(t *testing.T) {
	journal := `{"v":1}` + "\n" + `{"op":"enqueue","job":{"id":"job_01","state":"paused"}}` + "\n"
	if _, err := Replay(strings.NewReader(journal)); err == nil || !strings.Contains(err.Error(), "paused") {
		t.Fatalf("Replay err = %v, want an error naming the state", err)
	}
}
