# Inventory

Everything this setup installs. `scripts/verify-docs.ts` checks each list
against the files in the repository, so a new skill, prompt, extension, or
theme needs a line here. It also checks each skill's Who entry against that
skill's frontmatter.

### Installed skills

"Who" says who starts a skill. **you**: only you, with `/skill:<name>`.
**agent**: the agent loads it when its trigger matches, and it stays out of
`/skill:`. **both**: either one.

#### Agree on the problem

| Skill                  | Who   | Use it to                                                       |
| ---------------------- | ----- | --------------------------------------------------------------- |
| `grill-with-docs`      | you   | Get interviewed hard, and write the glossary and ADRs as you go |
| `prototype`            | agent | Build a throwaway that settles a design question                |
| `research`             | agent | Answer a question from primary sources in a background agent    |
| `to-spec`              | both  | Turn the conversation into a spec ticket                        |
| `to-tickets`           | both  | Split the spec into tickets under it, with blocking edges       |
| `triage`               | you   | Make tickets others wrote agent-ready, as a spec over tickets   |
| `grilling`             | agent | Question a plan hard when you say "grill me"                    |
| `writing-good-tickets` | agent | Write one ticket an agent can take to one PR                    |

#### Build it

| Skill                       | Who   | Use it to                                                  |
| --------------------------- | ----- | ---------------------------------------------------------- |
| `architect`                 | agent | Sketch types and signatures, then stop for review          |
| `arena`                     | agent | Run N candidates, keep the best, graft in the rest         |
| `code-review`               | both  | Review a branch with one persona subagent per lens         |
| `babysit`                   | agent | Answer review threads and fix CI until merge-ready         |
| `subagents`                 | agent | Delegate, with the model for each role                     |
| `swarm`                     | agent | Fan out parallel workers and merge one report              |
| `show-me-your-work`         | both  | Log each decision, audit it, and get a second-model review |
| `background-terminals`      | agent | Run services, watchers, and subagents alongside work       |
| `tdd`                       | agent | Test-first loop for features and bug fixes                 |
| `diagnosing-bugs`           | agent | Find the cause of a hard bug through a red loop            |
| `typescript-best-practices` | agent | Write TypeScript to this setup's standard                  |
| `frontend-design`           | agent | Give new UI a deliberate visual direction                  |
| `docs-search`               | agent | Check version-sensitive API behavior                       |
| `web-search`                | agent | Find and read live sources                                 |
| `pi-harness`                | agent | Change or build on Pi itself                               |
| `writing-good-commits`      | agent | Write and size commits                                     |
| `writing-good-prs`          | agent | Write a PR a reviewer can trust and own                    |
| `unslop`                    | agent | Cut AI tells from prose                                    |

#### Test it on the real app

| Skill                         | Who   | Use it to                                                   |
| ----------------------------- | ----- | ----------------------------------------------------------- |
| `create-verification-skill`   | you   | Generate `verify-<app>`, which drives the app like a user   |
| `maintain-verification-skill` | you   | Bring `verify-<app>` back in line with the app              |
| `agent-browser`               | agent | Drive a browser or Electron app                             |
| `benchmark-checklist`         | agent | Vet a performance number before you trust it                |
| `hillclimb`                   | both  | Push one metric to a target, one measured attempt at a time |
| `blast-radius`                | agent | Find what a change breaks outside the diff                  |
| `dumpfile`                    | agent | Publish screenshots and recordings as PR evidence           |

#### Keep the codebase easy to work in

| Skill                                | Who   | Use it to                                                |
| ------------------------------------ | ----- | -------------------------------------------------------- |
| `improve-codebase-architecture`      | you   | Find modules that expose more than they do               |
| `create-formal-verification-skill`   | you   | Model-check or prove the code where a bug costs the most |
| `maintain-formal-verification-skill` | you   | Update the model when the code changes                   |
| `statechart`                         | both  | Draw a TLA+ model's states, with each bug as a path      |
| `correct`                            | you   | Turn a repeated agent mistake into a type, lint, or test |
| `teach`                              | you   | Explain a body of work so a person understands it        |
| `domain-modeling`                    | agent | Sharpen terms in `GLOSSARY.md` and record ADRs           |
| `codebase-design`                    | agent | Design deep modules and place seams                      |
| `how`                                | agent | Walk through a subsystem before changing it              |
| `why`                                | agent | Recover the rationale behind code                        |

#### Improve the setup

| Skill                 | Who   | Use it to                                                |
| --------------------- | ----- | -------------------------------------------------------- |
| `setup-sh4dow-skills` | you   | Record a repo's tracker, domain docs, and standards      |
| `reflect`             | you   | Route each lesson from a session to a skill or the repo  |
| `automate-me`         | you   | Capture your working style as a skill                    |
| `eval`                | both  | Measure a skill or prompt change on blinded agent runs   |
| `recall`              | agent | Look up an earlier chat or what came before compaction   |
| `catchup`             | you   | Hear what changed since your last message, and each call |
| `catchup-video`       | you   | Watch the catchup as a short narrated video              |
| `writing-for-agents`  | agent | Write skills and `AGENTS.md`                             |
| `wizard`              | agent | Generate a bash wizard for steps only a human can do     |
| `mailbox`             | agent | Read and send email through Himalaya                     |

#### Principles

The agent loads these on its own when the trigger matches.

| Principle                                            | Applies when                                    |
| ---------------------------------------------------- | ----------------------------------------------- |
| `principle-attack-the-premise`                       | Two fixes with one premise failed the same gate |
| `principle-boundary-discipline`                      | Wiring validation, errors, or adapters          |
| `principle-build-the-lever`                          | Work will be rerun or delegated                 |
| `principle-encode-lessons-in-structure`              | The same correction comes up twice              |
| `principle-engineering-standards`                    | Writing or reviewing code                       |
| `principle-exhaust-the-design-space`                 | A decision has no precedent or depends on feel  |
| `principle-experience-first`                         | Product or UX tradeoffs                         |
| `principle-explain-the-number`                       | Reporting a measured number                     |
| `principle-fix-root-causes`                          | Debugging                                       |
| `principle-laziness-protocol`                        | Adding code paths, refactoring, sizing a diff   |
| `principle-make-operations-idempotent`               | Steps must survive crashes and retries          |
| `principle-minimize-reader-load`                     | Code is hard to trace                           |
| `principle-model-the-domain`                         | Choosing core types or writing stateful logic   |
| `principle-prove-it-works`                           | Choosing how to verify                          |
| `principle-redesign-from-first-principles`           | A new requirement meets an old design           |
| `principle-separate-before-serializing-shared-state` | Concurrent writers share state                  |
| `principle-sequence-verifiable-units`                | Multi-step work, or stacking commits and PRs    |
| `principle-test-behavior-not-implementation`         | Writing or keeping a test                       |

### Installed prompts

- `bro`: restate the last message in plain language, with no jargon
- `handoff`: compact the conversation into a message for a fresh agent
- `implement-chunk`: orchestrate a ticket and its sub-tickets through
  subagents to merge-ready PRs, then verify them live after merge
- `restate-sharpened`: restate a short task, sharpen it into a deeper
  approach, and list the decisions that are yours, before any work starts
- `sharpen-prompt`: rewrite a prompt so it asks for a deeper version of the
  task, not a bigger one

### Installed extensions

- `background-terminals`: `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for
  session-owned processes, plus `emit-to-pi` notifications
- `build-bin-path`: puts `.build/bin` (`pi-subagent`, `emit-to-pi`, `dumpfile`)
  on the PATH of every command Pi runs, the `bash` tool included
- `delegate-guard`: keeps subagents two tiers deep. A subagent whose
  `--system-prompt` is a role prompt under `agent/system/generated/delegate/`
  is a delegate and may run no `pi --print`, `pi -p`, `pi-subagent`, or
  `subagents/scripts/launch.ts` launch. An owner, a subagent on a prompt under
  `agent/system/generated/owner/` that carries a whole unit such as a PR, may
  launch only delegates. It checks `bash`, `bg_start`, and codemode alike.
  `launch.ts` refuses the same spawns, and any child past depth 2, from the
  `PI_SUBAGENT_*` variables it gives each child
- `fast-mode`: `/fast` and `Ctrl-Alt-M` toggle Fast mode for the models listed
  under `fastMode` in `agent/settings.json`, and the footer shows `⚡ Fast` while
  it is on. A provider entry with `subagentsEnabled: false` skips sessions
  named `subagent: …`
- `herdr-agent-state`: Herdr pane state and Pi session reporting
- `herdr-bg-indicator`: reports running background terminals, such as `2 bg`,
  as the `$bg` Herdr pane token. Herdr shows it only where a sidebar row names
  it, for example `rows = [["state_icon", "machine", "workspace", "tab", "$bg"],
  ["agent"]]` under `[ui.sidebar.agents]` in `~/.config/herdr/config.toml`
- `herdr-worktrees`: inside Herdr, each checkout that appears under
  `.worktrees/<branch>` or `.worktrees/<repo>/<branch>` of the session's
  directory opens as a Herdr workspace, grouped under its repository
- `host-guard`: refuses a `bash` or `bg_start` call, direct or from a codemode
  script, that kills by name, pattern, port, or file, such as `pkill`,
  `killall`, `fuser -k`, `kill $(pgrep …)`, `kill $(lsof -t …)`, or
  `pids=$(pgrep x); kill $pids`, or that deletes a glob under `/tmp`,
  `/var/tmp`, or `$TMPDIR` with `rm` or `find … -delete`, or deletes `/tmp` or
  `/var/tmp` itself, by name, through a variable whose default is one of them,
  or with `find` started there and `-delete` or `-exec rm`. It reads commands
  inside substitutions, subshells, `case` clauses, `bash -c`, and `eval`. It also reads the command line that `watch` or
  a tmux `new-session`, `new-window`, `split-window`, `respawn-pane`, or
  `respawn-window` starts, and a heredoc, here-string, or literal `echo` or
  `printf` fed to a shell. It runs in every session. Its reason points the agent
  at `bg_kill`, a PID it started, or the exact path it created. It refuses a
  command nested past 64 levels with a reason to split it, and a `printf` fed to
  a shell whose output it cannot reproduce (a width, precision, flag, `*`, a
  conversion other than `%s`, `%b`, and `%%`, or an escape that bash's and
  coreutils' printf print differently), or an `echo` fed to a shell with an
  escape that bash's and coreutils' echo print differently, or without `-e`
  with an escape that `echo -e` reads, with a reason to use a quoted heredoc.
  It decodes an ANSI-C quoted `$'…'` word as bash does, and refuses one with
  `\u`, `\U`, `\c`, or a number escape for NUL or a byte above 0x7F when it
  names a command, is a script a shell runs, or is an argument of `kill`,
  `rm`, `find`, `xargs`, `fuser`, `pkill`, or `killall`, with the same reason.
  It expands a brace expansion such as `{a,b}` or `{01..10..3}` into the words
  bash makes of it, and judges each word; one it cannot expand exactly (more
  than 1024 words, a range with a non-letter, or a substitution inside a
  script) stays unread. It refuses a locale-quoted `$"…"` word, an unread
  brace expansion, or `$[…]` arithmetic in those same places, and an unquoted `*`,
  `?`, or `[…]` in the base name of a command word, with a reason that names
  the form. A shell fed by a variable or a substitution still runs
- `process-status`: `/ps` views of background terminals and the `session_usage`
  tool
- `prompt-context`: restores Pi's `<tools>` and `<rules>` sections with the
  stock wording, which Pi omits when a custom system prompt replaces its own
- `sacrifice-preference`: marks spawned work as the preferred target under Linux
  memory pressure
- `session-timer`: branch duration since the first user message, with clock
  footers on responses
- `sh4dow`: `/sh4dow <ticket reference> [base branch] [target environment]`
  opens a new session, linked to the current one as its parent, that runs on
  the sh4dow mode prompt with no skill table, and starts the coordinator on the
  chunk. The mode survives `/reload` and a resume, and `/sh4dow` inside a
  sh4dow session is refused
- `skill-visibility`: `/skill-visibility` controls which loaded skills the model
  can discover, and skills marked `user-invokable: false` stay out of `/skill:`
  autocomplete
- `subagents`: the `pi-subagent` launcher runs a subagent as a read-only Pi
  chat in its own Herdr pane, listed under its parent in the agents sidebar.
  Outside Herdr it runs `pi --print`. It also runs `pi --print` where the pane
  cannot match it: a terminal on stdin, an extension command as the task, or a
  missing model, login, or catalog entry
- `tps-tracker`: live and final output-token throughput
- `ui-moto`: compact model and project status header

`agent/extensions/herdr-agent-state.ts` carries local patches. Updating Herdr's
integration overwrites it, so restore the repository version afterwards and run
`/reload` in affected sessions.

How `pi-subagent` differs from `pi --print` inside Herdr is in
[pi-subagent.md](pi-subagent.md).

### Installed CLI tools

- [`dumpfile`](../cli/dumpfile/README.md) publishes screenshots, recordings, and
  other review evidence to immutable public R2 URLs. The links are not
  permanent, and setup can opt into 30-day object-age retention. Run
  `./cli/dumpfile/setup.sh` once to provision Cloudflare and install the
  command.

### Installed themes

- `catppuccin-mocha`
- `gruvbox-dark-hard`
