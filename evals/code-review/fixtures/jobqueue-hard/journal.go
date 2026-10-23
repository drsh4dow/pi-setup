package jobqueue

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// journalVersion is the format this build writes and the newest it reads.
const journalVersion = 1

// Ops name the operation that produced a record. Replay doesn't need them,
// since every record holds the whole job, but they make a journal readable
// and let replay reject records from a build it doesn't understand.
const (
	opEnqueue  = "enqueue"
	opLease    = "lease"
	opExtend   = "extend"
	opComplete = "complete"
	opFail     = "fail"
	opExpire   = "expire"
)

var knownOps = map[string]bool{
	opEnqueue:  true,
	opLease:    true,
	opExtend:   true,
	opComplete: true,
	opFail:     true,
	opExpire:   true,
}

type header struct {
	V int `json:"v"`
}

type record struct {
	Op  string `json:"op"`
	Job Job    `json:"job"`
}

// Journal is the append-only file a Store records its changes in.
type Journal struct {
	f *os.File
}

// OpenJournal opens the journal at path, creating it if needed, and replays
// it. It returns the journal's jobs as of their last records.
func OpenJournal(path string) (*Journal, []*Job, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, nil, fmt.Errorf("open journal %s: %w", path, err)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, fmt.Errorf("stat journal %s: %w", path, err)
	}
	if info.Size() == 0 {
		if err := writeLine(f, header{V: journalVersion}); err != nil {
			f.Close()
			return nil, nil, fmt.Errorf("write journal header %s: %w", path, err)
		}
		return &Journal{f: f}, nil, nil
	}

	jobs, err := Replay(f)
	if err != nil {
		f.Close()
		return nil, nil, fmt.Errorf("replay journal %s: %w", path, err)
	}
	return &Journal{f: f}, jobs, nil
}

// Replay reads a journal and returns its jobs in the order they were
// enqueued, each as of its last record.
func Replay(r io.Reader) ([]*Job, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	if !scanner.Scan() {
		return nil, errors.Join(errors.New("missing header"), scanner.Err())
	}
	var h header
	if err := json.Unmarshal(scanner.Bytes(), &h); err != nil || h.V == 0 {
		return nil, errors.New("line 1: not a journal header")
	}
	if h.V > journalVersion {
		return nil, fmt.Errorf("journal version %d is newer than %d, the newest this build reads", h.V, journalVersion)
	}

	byID := map[string]*Job{}
	var order []*Job
	for line := 2; scanner.Scan(); line++ {
		var rec record
		if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		if !knownOps[rec.Op] {
			return nil, fmt.Errorf("line %d: unknown op %q", line, rec.Op)
		}
		if _, err := ParseState(string(rec.Job.State)); err != nil {
			return nil, fmt.Errorf("line %d: job %s: %w", line, rec.Job.ID, err)
		}

		if existing, ok := byID[rec.Job.ID]; ok {
			*existing = rec.Job
			continue
		}
		job := rec.Job
		byID[job.ID] = &job
		order = append(order, &job)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return order, nil
}

// Append writes one record and syncs it to disk before it returns.
func (j *Journal) Append(op string, job Job) error {
	if err := writeLine(j.f, record{Op: op, Job: job}); err != nil {
		return err
	}
	return j.f.Sync()
}

// Close closes the journal file.
func (j *Journal) Close() error {
	return j.f.Close()
}

func writeLine(w io.Writer, v any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = w.Write(append(line, '\n'))
	return err
}
