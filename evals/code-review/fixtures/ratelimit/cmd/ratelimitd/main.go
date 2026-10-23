// Command ratelimitd serves a demo endpoint behind the rate limiter.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"

	"example.com/ratelimit"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	rate := flag.Float64("rate", 5, "tokens per second per client")
	burst := flag.Int("burst", 10, "bucket capacity per client")
	flag.Parse()

	limiter, err := ratelimit.New(ratelimit.Config{Rate: *rate, Burst: *burst})
	if err != nil {
		log.Fatal(err)
	}
	go sweep(limiter, time.Minute)

	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	mux := http.NewServeMux()
	mux.Handle("/", ratelimit.Middleware(limiter, ratelimit.ClientIP, app))
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func sweep(l *ratelimit.Limiter, every time.Duration) {
	for range time.Tick(every) {
		l.Sweep()
	}
}
