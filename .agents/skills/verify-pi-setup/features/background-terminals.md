# Background terminals

Background terminals let the model start a shell job that keeps running after its turn ends. The footer counts running jobs, and the job's completion wakes the agent with its exit code and output.

## Sub-features

- `bg-start` starts a job through the `bg_start` tool and reports its ID, such as `bt-1`.
- `bg-count` shows `<n> bg` in the footer while jobs run.
- `bg-wake` posts a completion card and wakes the agent when the job exits.
- `bg-inspect` reads a job with `bg_status` and `bg_list`.
- `bg-kill` stops a job with `bg_kill`.

## How to get to it (user POV)

- Ask the model to run a long command in the background.
- Ask it to check on or stop a job.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor.
- The checkout has `.build/bin/emit-to-pi`. Launch refuses to start without it.

- **Start a job.** Run ``$CP send RUN 'Use bg_start to run `sleep 8; echo "verify-$((40+2))"` with the title "verify sleep". Then reply with only the word started, and call no other tool.'`` and `$CP wait RUN 'started bt-1' 120`. The pane shows `bg_start sleep 8; echo "verify-$((40+2))"`, then `started bt-1`, then the reply `started`.
- **Running count.** Before eight seconds pass, run `$CP snap RUN bg.running`. The footer's last line starts with `1 bg`.
- **Completion wake.** Run `$CP wait RUN '✓ bt-1 done · exit 0' 60`. A card shows `✓ bt-1 done · exit 0 · 8s` with the command under it, and the agent then replies on its own that the job printed `verify-42`. The footer no longer shows `1 bg`.
- **Kill.** Start `sleep 300` the same way, then run `$CP send RUN 'Use bg_kill on that job, then reply with only the word killed.'`. Wait for `killed`, then run `$CP send RUN /ps` and wait for `[ps] idle`.
- **Proof.** Snap the running and finished states. The command prints `verify-$((40+2))` literally, so only the finished job's output contains `verify-42`.

## Gotchas

- Each start costs at least two model calls, one for the turn and one for the wake-up.
- Write the marker so the model cannot produce it before the job runs, as `$((40+2))` does. A literal marker in the prompt proves nothing.
- Jobs belong to the Pi session. `$CP stop` kills any left running.
- The wake-up reply arrives after the card. Wait for the card, then for the reply's own `⏱` footer.
