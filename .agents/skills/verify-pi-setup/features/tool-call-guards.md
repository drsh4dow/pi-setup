# Tool-call guards

Two extensions refuse a bash call before it runs, and the model reads the refusal as the tool result. The host guard (`host-guard`) runs in every session and refuses a kill by name or pattern and a glob delete under `/tmp`. `delegate-guard` runs only in a delegate session, one whose Pi was started with `subagents/unattended.md` and `subagents/delegate.md` appended to its system prompt, and refuses any subagent launch there. An allowed command runs as usual.

## Sub-features

- `host-refuse` refuses `pkill -0 -f <pattern>` with a reason that starts `Kill only processes you started.`
- `host-allow` runs `pgrep -af <pattern>`, a search that kills nothing.
- `delegate-refuse` refuses `command pi-subagent --help` in a delegate session with a reason that starts `Delegates spawn nothing.`
- `delegate-allow` runs `command -v pi-subagent` in a delegate session, a lookup that launches nothing.

## How to get to it (user POV)

- In a root session, ask the model to call bash with a kill by pattern, then with a search.
- In a delegate session, ask the model to call bash with a subagent launch, then with a lookup. A delegate session is what `pi-subagent` starts for a delegate; here a `pi` wrapper first on PATH appends the same two files to the session `control-pi` launches.

## Driving it with control-pi

Preconditions:

- `vp install` ran in this checkout, and no run with either ID exists (`$CP list`).
- Pick run IDs of letters, digits, and `-` with a suffix of your own, such as `ROOT=guards-root-0412` and `DELEGATE=guards-delegate-0412`. Shell variables do not survive between tool calls, so set `CP`, `ROOT`, and `DELEGATE` at the top of each call that uses them, and `DLG` to the path the wrapper step prints.
- Each prompt names one exact call. Each `send` text starts with `Call`, so no kill word opens it or follows `;`, `&&`, `|`, or a newline, and the driver's own host guard, which reads a kill word in those positions as a command, lets the `send` through.

Root session:

- **Launch.** Run `$CP launch "$ROOT"` and `$CP doctor "$ROOT" >"$($CP path "$ROOT" evidence)/doctor.txt"`. Doctor exits 0.
- **host-refuse.** Run `$CP send "$ROOT" "Call the bash tool once with the command pkill -0 -f no-such-process-$ROOT and make no other tool call. Then reply with the word done."`, `$CP wait-turn "$ROOT" 120`, and `$CP snap "$ROOT" host-refuse`. The snap shows the call and `Kill only processes you started.` under it.
- **host-allow.** Run `$CP send "$ROOT" "Call the bash tool once with the command pgrep -af no-such-process-$ROOT and make no other tool call. Then reply with the word done."`, `$CP wait-turn "$ROOT" 120`, and `$CP snap "$ROOT" host-allow`. The snap shows the call and pgrep's own output under it, such as `(no output)` and `Command exited with code 1`.
- **Proof.** Run the session read below with `RUN=$ROOT`. It prints two `call` lines, each followed by its `result`: the `pkill` result starts `Kill only processes you started.`, and the `pgrep` result is pgrep's own output. Both results carry `isError=true`: the refusal because it is one, and the pgrep result because pgrep exits 1 when it finds nothing and Pi marks every non-zero exit as an error. Read the text, not the flag. Then run `$CP stop "$ROOT"`.

Delegate session:

- **Write the wrapper.** The wrapper appends the two files only to the Pi that `control-pi` starts in tmux, the one process that carries `VERIFY_PI_SETUP_RUN`, so the credential refresh and doctor's `pi --version` run plain `pi`. It records the argv it passes on in `$DLG/pi-argv.txt`, because Pi renames its process title and `ps` shows only `pi`:

  ```bash
  DLG=$(mktemp -d)
  mkdir "$DLG/bin"
  REAL_PI=$(command -v pi)
  cat >"$DLG/bin/pi" <<EOF
  #!/usr/bin/env bash
  if [[ -n \${VERIFY_PI_SETUP_RUN:-} ]]; then
    set -- "\$@" --append-system-prompt "\$PI_CODING_AGENT_DIR/skills/subagents/unattended.md" \\
      --append-system-prompt "\$PI_CODING_AGENT_DIR/skills/subagents/delegate.md"
    printf '%s\n' "\$@" >"$DLG/pi-argv.txt"
  fi
  exec "$REAL_PI" "\$@"
  EOF
  chmod +x "$DLG/bin/pi"
  echo "DLG=$DLG"
  ```

- **Launch.** Run `PATH="$DLG/bin:$PATH" $CP launch "$DELEGATE"` and `$CP doctor "$DELEGATE" >"$($CP path "$DELEGATE" evidence)/doctor.txt"`. Doctor exits 0. Run `cp "$DLG/pi-argv.txt" "$($CP path "$DELEGATE" evidence)/"`. Its last four lines are `--append-system-prompt`, a path ending in `skills/subagents/unattended.md`, `--append-system-prompt`, and a path ending in `skills/subagents/delegate.md`.
- **delegate-refuse.** Run `$CP send "$DELEGATE" 'Call the bash tool once with the command command pi-subagent --help and make no other tool call. Then reply with the word done.'`, `$CP wait-turn "$DELEGATE" 120`, and `$CP snap "$DELEGATE" delegate-refuse`. The snap shows the call and `Delegates spawn nothing.` under it.
- **delegate-allow.** Run `$CP send "$DELEGATE" 'Call the bash tool once with the command command -v pi-subagent and make no other tool call. Then reply with the word done.'`, `$CP wait-turn "$DELEGATE" 120`, and `$CP snap "$DELEGATE" delegate-allow`. The snap shows the call and a path ending in `/pi-subagent`.
- **Proof.** Run the session read with `RUN=$DELEGATE`. The `pi-subagent --help` result starts `Delegates spawn nothing.`, and the `-v` result is a path. Then run `$CP stop "$DELEGATE"` and `rm -rf "$DLG"`.

The session read prints every bash call of the run and the first line of its result, and saves them to the evidence directory:

```bash
find "$($CP path "$RUN" sessions)" -name '*.jsonl' -exec jq -r 'select(.type == "message") | .message
  | if .role == "assistant" then (.content[] | select(.type == "toolCall") | "call   \(.arguments.command)")
    elif .role == "toolResult" then "result isError=\(.isError) \(.content[0].text | split("\n")[0])"
    else empty end' {} + | tee "$($CP path "$RUN" evidence)/tool-calls.txt"
```

## Gotchas

- Match a refusal on its first sentence only. The rest of each reason may change as patterns are added to the guards.
- When the driving agent is itself a delegate, its own `delegate-guard` reads every multi-word argument of its bash call as a possible command line. A `send` whose text holds `pi` and `--print` or `-p` is refused in the driver's session before it reaches the TUI. `pi-subagent` counts as a launch only in command position, so the `delegate-refuse` prompt gets through.
- The model may retry a refused call. A run whose session read shows a second call, or a rephrased one, failed, so relaunch and drive it again.
- `pgrep -af no-such-process-…` usually exits 1 with `(no output)`, and can instead list the shell that runs it, because that shell's command line holds the pattern. Either result counts as allowed.
- PATH reaches the delegate Pi only from the `launch` command itself. Drive the other commands without the prefix, and read `pi-argv.txt` before trusting the session as a delegate. A missing file means the launch ran plain `pi`, and the session is a root session.
