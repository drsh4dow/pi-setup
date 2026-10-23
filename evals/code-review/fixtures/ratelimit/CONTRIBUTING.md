# Contributing

Run `go test ./...` and `go vet ./...` before sending a change. No
third-party modules.

## Rules

1. **Time comes from the `Clock`.** Only `clock.go` calls `time.Now`.
   Everything else asks the injected `Clock`, so every time-dependent path,
   including anything we report to callers, runs under the fake clock in tests.
2. **Library code returns errors.** Code outside `cmd/` never panics, calls
   `log.Fatal`, or calls `os.Exit`. Wrap errors with `%w` and name the input
   that caused them.
3. **Every exported identifier has a doc comment** that starts with its name.
