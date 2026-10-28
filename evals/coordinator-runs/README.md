# Coordinator runs

Grades past `implement-chunk` runs from the session files they left and their chunk state
folders. For each coordinator session and each subagent session it launched, it reports the
mode and skill table the session ran with, the skills it read, and its launches. For each chunk,
it reports what went wrong with the chunk's verdicts, merges, and units.

It reads sessions and runs no Pi, so it is not an Eval: it measures runs that already happened.

## Run

```sh
node evals/coordinator-runs/grade.ts --sessions ~/.pi/agent/sessions \
  --state ~/.local/state/pi-agent/<project>/implement-chunk/<chunk> [--state ...] \
  --out <dir>
```

It writes three files to `--out`:

- `sessions.tsv`, one row per graded session, with columns `session file project chunk mode
  role parent depth skill_table_chars skill_table_tokens skill_table_tokens_source
  skills_read`.
- `findings.tsv`, one row per counted event, with columns `session entry class detail`.
  Each row names the session and the entry id that recorded the event. `sessions.tsv` maps
  the session to its file. A finding read from a `units.tsv` or `ledger.tsv` row names the
  coordinator entry whose tool call wrote or last changed that row, and its detail ends in
  the row's `<state file>:<line>`. When no graded coordinator session holds such a call, the
  entry is `-`. The summary counts those rows for each chunk.
- `command.txt`, the command line that produced them, to rerun from the repository root.

It also prints each chunk's sessions as a tree, with the count for each finding class.
Warnings go to stderr: a pull request that GitHub says does not exist, a ledger row that names
none, a launched session whose file is not under `--sessions`, a graded chunk that no
coordinator session belongs to, or a launch call left uncounted because its command is cut
short (see below). A warning about a launch call names its session file and entry id, never
the command, which can hold a credential. It exits 2 when it cannot run: on bad arguments, when
the chunk names pull requests and `gh` is not on `PATH`, or when `gh` fails for any other
reason than a missing pull request or repository, such as an expired login, or prints no pull
request. The message names the pull request and what `gh` printed.

## What it reads

- **Coordinator sessions.** A coordinator session is one whose first user message opens
  with `COORDINATOR_MARKER` (`# Implement a chunk`, the heading of the expanded prompt), or
  one that carries a `sh4dow-mode` custom entry (`SH4DOW_MODE_ENTRY`) before its first
  user message. It reads every other session file in 4 KiB chunks and stops at the chunk
  that holds the end of its first user message, so at most 4 KiB past that point is read.
- **The chunk a coordinator ran.** This is the state folder its session names most often,
  among the `--state` folders and every sibling folder beside them. A coordinator that names
  an ungraded sibling most, such as a chunk still running, is left out. A state folder
  counts under any project name, `<state root>/<any project>/implement-chunk/<chunk>`,
  because renaming a project moves its state folders.
- **Subagent sessions.** It follows only the session ids its graded sessions launched. The
  launcher prints `launch: session <uuid>` to stderr. That line reaches the parent in a
  `background-terminal-results` message, a `bg_status` result, or a `bash` result. A launch
  without that line is listed with `child=unknown`, and nothing below it is graded.
- **Terminal runs.** A resumed session's new Pi process numbers its background terminals from
  `bt-1` again, so a terminal id names one run only from one start to the next. For a
  top-level `bg_start`, the grader uses the command recorded in the call and reads the child
  session id from the reports of the run that call started. When a report's command differs
  from the current run of its id, the grader starts a new run for that id. Codemode records a
  nested `bg_start` command cut short, so the grader matches it to the first later run that no
  other call has matched and whose full command starts with the recorded prefix.
- **Codemode calls.** A codemode result records each call its script made twice: cut short in
  `details.calls`, and in full in `nestedCalls.calls` when the session has that field. A call
  whose arguments were too large to keep records only their size there, and Pi keeps at most
  256 calls there, marking the record incomplete when it drops any. The grader takes each
  call's full arguments where they exist, the cut ones at the same position for a call
  recorded without them, and the cut ones for every call past the end of `nestedCalls`.
- **State files.** `units.tsv` and `ledger.tsv` are read by header name, so past layouts
  still read. A ledger's `head_sha` cell may hold several SHAs, as in
  `84187d1 (carries to e8a0353)`. An abbreviation of seven or more characters matches a full
  SHA.
- **Pull requests.** Every PR the state files name is looked up once with
  `gh pr view --json state,headRefOid,headRefName`. A short reference (`repo#n`, `n`)
  resolves only when the state files name exactly one matching repository in full.

## Mode, skill table, and launches

- `mode` is `sh4dow` for a session with the `sh4dow-mode` entry, `subagent` for a launched
  session, and `general` otherwise.
- The skill table is the `skills` section of the session's recorded system prompt: its
  system messages replayed up to the first reply. `skill_table_tokens` is its length divided
  by four, rounded up, so `skill_table_tokens_source` is `estimate`.
- A launch is a `bash` or `bg_start` call that runs the subagents skill's `launch.ts`, a raw
  `pi-subagent`, or the `spawn.sh` wrapper that past chunks kept in their state folder. The
  call can be top-level or made from inside a codemode script. The launcher must sit where
  the shell runs a command:
  - at the start of a statement or a pipeline stage,
  - after variable assignments, or
  - after a word that runs the next one, such as `bash`, `exec`, or `timeout 600`.

  A launcher named as an argument (`chmod +x spawn.sh`), as a redirection target
  (`cat > spawn.sh`), or inside quotes runs nothing. Dry runs, help, and text inside a
  heredoc's body are left out. A launcher's arguments end where its simple command ends, so
  `--dry-run` in a later statement, or inside a quoted argument such as a `--name`, does
  not make it a dry run. A call that failed, such as one the delegate guard refused, and
  started no child session is not a launch. Kind comes from `--kind` or from the appended kind prompt
  (`delegate.md`, `owner.md`). Role comes from `--role`. Either is `unknown` when the command
  does not say.

- A call whose recorded command codemode cut short, marked by its trailing `...`, may hide a
  `--dry-run` past the cut, and the session does not hold the rest. When such a call started no
  child session, it is not counted as a launch. A warning names its session file and entry,
  and the summary counts these calls for each chunk. A cut call that started a child session
  still counts. The grader does not read the codemode script to guess the command.

## Finding classes

| Class                   | Counted when                                                                                                                                                    | Detail                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `skill-read`            | a session's first successful read of a `SKILL.md` (`read`, codemode `tools.read`, or a printing bash command)                                                   | skill name                                        |
| `launch`                | each launch                                                                                                                                                     | `kind=<k> role=<r> depth=<d> child=<id\|unknown>` |
| `wrong-spawn`           | a delegate launches, an owner launches an owner, or a launch goes past depth 2                                                                                  | the reason, then the launch detail                |
| `root-edit`             | a coordinator's successful `edit`, `write`, or `bash` write outside its state folder                                                                            | the absolute path                                 |
| `stale-verdict`         | a merged PR whose ledger rows name no SHA it merged at, not even through a carry row                                                                            | `<pr> <ledger file>:<line of its last row>`       |
| `report-only-merge`     | a merged final PR (head branch `chunk/...`) whose merged head no `verifier` session's final message names                                                       | `<pr> <merged head> <state file>:<line>`          |
| `unterminated-subagent` | a `units.tsv` row whose state's first word is not `merged`, `done`, `abandoned`, or `reconciled`, leaving out a `planned` row that no launch names by its brief | `<id> <state> <units file>:<line>`                |

`root-edit` counts the `edit` and `write` tools exactly: each successful call writes its path.
For `bash` the count is an upper bound. A bash root-edit is a write target that the text of a
successful command names, outside the chunk's state folder: a redirection (`>`, `>>`), a `tee`
file, a file of `sed -i` in any valid option form (the script given by `-e`, `-eSCRIPT`,
`--expression=SCRIPT`, `-f`, or as the first operand), or a `cp` or `mv` destination. The
grader does not model control flow, so a target in a branch that may not run still counts:
`false && printf x > f; true` exits 0 without writing `f`, and `f` counts. The grader resolves a relative path from the session's directory, follows `cd`,
and expands variables the same command assigned. It leaves out a path it cannot resolve: one
that holds a variable the command never set, a command substitution, or a glob, a relative
path after a `cd` to such a place, and `/dev/` targets. A file written any other way, such
as by a script the command runs, is not seen. A coordinator's scratch file under `/tmp`
counts too, because it is a write outside the state folder. `unterminated-subagent` judges a free-text state by its first
word, its first run of letters, which ends at a `-`, `(`, space, or any other non-letter. So
past states such as `done: 0 act-on` and `abandoned-canceled(repo archived)` are terminal, and
`running bt-1` is not.

When a chunk has launches with no child session, its `report-only-merge` count is an upper
bound: a verifier may have run below a launch the grader could not follow. The summary says so.

### Which entry a state-row finding names

Each state-row class reads one row:

- `stale-verdict`: the PR's last ledger row.
- `report-only-merge`: the PR's ledger row at its merged head. With none, the unit that names
  it as `final_pr` or `intermediate_pr`. With neither, its last ledger row.
- `unterminated-subagent`: the unit's row.

The entry is the successful coordinator call that wrote that row last, by the time the
call was issued, across every graded coordinator session of the chunk. A call recorded with no
time counts as earlier than any timed one. A call writes the row in one of these ways:

- An `edit` or `write` of the chunk's file whose text holds the row. For units.tsv that is
  a line opening with the unit id; for ledger.tsv, a line naming both the row's pull request
  and its SHA, since several pull requests can share a head SHA. The pull request may be
  named in any form the state files use, such as `7`, `#7`, or `acme/app#7`.
- A chunk CLI call (`chunk.ts` run as a command) whose `--state`, or
  `IMPLEMENT_CHUNK_STATE` set in the same command, is the chunk's state folder: `unit
  set|add <id>`, or `ledger record|carry <pr> <sha>` for the row's pull request at its SHA. The same words
  printed by `echo`, or a call for another chunk, do not write the row.
- A shell statement that redirects into the chunk's file, appends with `tee -a`, or runs
  `sed -i` on it, and names the row the same way. The target must resolve, as for
  `root-edit`, to the file in this chunk's state folder. It counts only when the name and
  the write are in the same statement. A SHA in a note appended to decisions.md by the same
  command is not a write of the row.

With no such call, the entry is `-`. The usual causes are a coordinator that continued in a
session whose first user message is not the prompt, and a codemode call recorded without its
full arguments, whose cut ones end before the row.

## Test

`vp run test:evals` runs `test/grade.test.ts` and `test/writers.test.ts` on the synthetic
chunks under [`fixtures/`](fixtures/), with a stub `gh` on a `PATH` that cannot reach the real
one. `writers.test.ts` covers pull requests whose ledger rows share a head SHA and `sed -i` in
each option form. `grade.test.ts` gives the unrelated session a 4 GiB sparse tail, so a grader
that read it past its first user message would fail. `evals/lib/test/session.test.ts` counts the bytes a head
read takes from the kernel's `/proc/self/io`. It fails when the read takes more than one 4 KiB
chunk past the end of the first user message. Where `/proc/self/io` is missing, as on macOS,
that test is skipped.
