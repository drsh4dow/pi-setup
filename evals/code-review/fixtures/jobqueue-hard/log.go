package jobqueue

import (
	"fmt"
	"io"
	"strings"
	"sync"
)

// Logger writes one line per event: the event name, then key="value" pairs.
type Logger struct {
	mu sync.Mutex
	w  io.Writer
}

// NewLogger returns a Logger that writes to w.
func NewLogger(w io.Writer) *Logger {
	return &Logger{w: w}
}

// Event logs event with fields given as alternating keys and values. Use an
// event name from events.go.
func (l *Logger) Event(event string, fields ...any) {
	var line strings.Builder
	line.WriteString("event=")
	line.WriteString(event)
	for i := 0; i+1 < len(fields); i += 2 {
		fmt.Fprintf(&line, " %v=%q", fields[i], fmt.Sprint(fields[i+1]))
	}
	line.WriteByte('\n')

	l.mu.Lock()
	defer l.mu.Unlock()
	io.WriteString(l.w, line.String())
}
