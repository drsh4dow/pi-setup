// Command jobqueued serves a job queue's admin API and reaps expired leases.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"example.com/jobqueue"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "jobqueued:", err)
		os.Exit(1)
	}
}

func run() error {
	journalPath := flag.String("journal", "jobs.journal", "path of the journal file")
	addr := flag.String("addr", "127.0.0.1:8090", "admin API listen address")
	tokenSpec := flag.String("tokens", os.Getenv("JOBQUEUE_TOKENS"), "token=role pairs, comma-separated; roles are viewer and operator")
	reapEvery := flag.Duration("reap-every", 5*time.Second, "how often to requeue jobs with expired leases")
	flag.Parse()

	tokens, err := jobqueue.ParseTokens(*tokenSpec)
	if err != nil {
		return fmt.Errorf("parse -tokens: %w", err)
	}
	store, err := jobqueue.Open(*journalPath, jobqueue.SystemClock{}, jobqueue.Options{})
	if err != nil {
		return err
	}
	defer store.Close()

	logger := jobqueue.NewLogger(os.Stderr)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go reap(ctx, store, logger, *reapEvery)

	server := &http.Server{Addr: *addr, Handler: jobqueue.NewAdmin(store, tokens, logger).Handler()}
	go func() {
		<-ctx.Done()
		server.Shutdown(context.Background())
	}()
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func reap(ctx context.Context, store *jobqueue.Store, logger *jobqueue.Logger, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reaped, err := store.ReapExpired()
			if err != nil {
				logger.Event(jobqueue.EventStoreError, "error", err)
			}
			if reaped > 0 {
				logger.Event(jobqueue.EventLeasesReaped, "count", reaped)
			}
		}
	}
}
