# sh4dow mode

`/sh4dow <ticket reference> [base branch] [target environment]` opens a new session whose header names the current session as its parent, sends `The chunk: <arguments>` as its first message, and runs the coordinator on the sh4dow mode prompt: the core plus the coordinator part, with no collaboration cases and no skill table. The mode lives in the session's `sh4dow-mode` entry, so it holds on every later run, after `/reload`, and when the session is resumed in a new process. Every other session, the parent included, keeps the general prompt, and `/implement-chunk` still expands its template.

## Sub-features

- `sh4dow-open` opens the linked session and starts the coordinator on the ticket.
- `sh4dow-prompt` records the sh4dow prompt as the new session's `system` message: `preamble` is `agent/system/generated/sh4dow.md`, and there is no `skills` section.
- `sh4dow-reload` keeps the sh4dow prompt after `/reload`.
- `sh4dow-resume` keeps it when another Pi process resumes the session.
- `sh4dow-general` leaves the parent session and a `/new` session on the general prompt.
- `sh4dow-refuse` refuses `/sh4dow` inside a sh4dow session, and `/sh4dow` with no ticket reference.
- `sh4dow-brand-new` covers `/sh4dow` typed as the first message of a brand-new session.
- `implement-chunk` still expands the `/implement-chunk` template in a general session.

## How to get to it (user POV)

- Type `/sh4dow drsh4dow/implement-chunk-fixture#1` in a session with history.
- Type the same as the first message of a brand-new session (`/new`, or a fresh launch).
- Type `/sh4dow` again inside the sh4dow session.
- Type `/reload`, or `/resume` the sh4dow session from another Pi.
- Type `/implement-chunk drsh4dow/implement-chunk-fixture#1`.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor.
- The public fixture `drsh4dow/implement-chunk-fixture` exists, and its issue 1 is titled "Tip calculator for the bill helper page".
- Every prompt that starts a coordinator carries a stop in its own text, because control-pi isolates only the agent directory and a coordinator reaches the live state folders and GitHub. `/sh4dow` takes the stop after the ticket reference, `STOP: for this test, name the ticket and call no tools`, and `/implement-chunk` takes `STOP: reply only with the word EXPANDED and call no tools`. Judge each coordinator turn from its session file, and press `$CP keys RUN Escape` at once if a tool call shows anyway.
- Read each session's recorded prompt from `$($CP path RUN sessions)`: replay its `message` entries with `role: "system"` in order, each patching `sections` by name (`null` removes one). Compare `preamble` byte for byte with `agent/system/generated/sh4dow.md` and `agent/SYSTEM.md`, and copy each session file into the evidence directory.

- **History.** Run `$CP send RUN 'Reply with exactly: general-ok. Make no tool calls.'` and `$CP wait-turn RUN 120`. Snap it. The session file now exists, and its prompt is the general one with a `skills` section.
- **Open a coordinator.** Run `$CP send RUN '/sh4dow drsh4dow/implement-chunk-fixture#1 STOP: for this test, name the ticket and call no tools'` and `$CP wait-idle RUN 120`, then snap. A new session file appears, and it records no tool call. Its header's `parentSession` is the history session's file, a `custom` entry `{"customType":"sh4dow-mode","data":{"version":1}}` precedes the first user message `The chunk: drsh4dow/implement-chunk-fixture#1 STOP: for this test, name the ticket and call no tools`, and its prompt's `preamble` is the sh4dow prompt with sections `preamble, cwd, tools, rules` and no `skills`. The history session's prompt is still the general one.
- **Refuse inside.** Run `$CP send RUN '/sh4dow drsh4dow/implement-chunk-fixture#2'` and `$CP wait RUN 'already runs in sh4dow mode' 30`. The notice reads `/sh4dow refused: this session already runs in sh4dow mode. Type /sh4dow in a general session.`, and no session file appears.
- **Reload.** Run `$CP send RUN /reload` and `$CP wait RUN 'Reloaded keybindings' 60`, then `$CP send RUN 'Reply with exactly: reloaded-ok. Make no tool calls.'` and `$CP wait-turn RUN 120`. No system message after the first sets another `preamble`, and none adds `skills`.
- **Resume in a new process.** Launch a second run, `RUN2`, and copy the sh4dow session file, unchanged, into `$($CP path RUN2 sessions)`. In `RUN2`, run `$CP send RUN2 /resume`, `$CP keys RUN2 Tab` (the session's folder is RUN's workspace, so it shows under All), `$CP wait RUN2 'The chunk: drsh4dow' 30`, and `$CP keys RUN2 Enter`, then send `Reply with exactly: resumed-ok. Make no tool calls.` and wait for `resumed-ok`. The resumed file still records only the sh4dow prompt. Keep RUN running until this step ends, because Pi resumes into the session's recorded directory.
- **Fresh session.** In RUN, run `$CP send RUN /new`, `$CP wait RUN 'New session' 30`, then send `Reply with exactly: fresh-ok. Make no tool calls.` and `wait-turn`. The new file has no `parentSession` and records the general prompt.
- **Brand-new session.** Run `$CP send RUN /new`, wait for `New session`, and type `/sh4dow drsh4dow/implement-chunk-fixture#1 STOP: for this test, name the ticket and call no tools` as its first message, then `$CP wait-idle RUN 120`. Its session file records no tool call. The sh4dow session's header names the `/new` session's file, which does not exist on disk. Run `$CP send RUN /resume` and `$CP wait RUN 'Sort: Threaded' 30`, wait until the list shows the sessions, and snap: the brand-new case's sh4dow session is a top-level row, while the first sh4dow session sits under `Reply with exactly: general-ok…` behind `└─`. Press Escape, run `$CP send RUN /tree`, and snap: the tree lists the session's own entries from `[system]` on. Resuming the sh4dow session works as in Resume in a new process.
- **`/implement-chunk`.** Run `$CP send RUN /new`, wait for `New session`, then `$CP send RUN '/implement-chunk drsh4dow/implement-chunk-fixture#1 STOP: reply only with the word EXPANDED and call no tools'` and `$CP wait-turn RUN 120`. The newest session file records no tool call, its first user message starts `# Implement a chunk` and holds `The chunk: drsh4dow/implement-chunk-fixture#1`, and its prompt is the general one.
- **Stop.** Run `$CP stop RUN2` and `$CP stop RUN`.

## Gotchas

- The fixture's chunk is finished, so a coordinator without the stop reads the fixture's old state folder in the live `~/.local/state/pi-agent/implement-chunk-fixture/implement-chunk/1/` within seconds, and a general-mode `/implement-chunk` coordinator once appended to its `decisions.md`. Diff that folder before and after the drive.
- Never wait on `bash` or another word the startup header prints, such as `! bash`: the wait returns at once.
- The TUI shows `/implement-chunk …` collapsed, so `# Implement a chunk` never appears on screen. Read the expansion from the session file.
- `wait-turn` follows the session file the last `send` started from, and `/sh4dow` opens a different file, so wait with `wait-idle` after `/sh4dow`.
- A delegate cannot run `pi --print` to resume, because the delegate guard refuses it. The second run is the new process.
- Pi writes a session file only once it holds a reply, so `/sh4dow` typed as the first message of a brand-new session links a parent file that never reaches disk. Nothing opens that file.
- Resuming a sh4dow session whose recorded working directory is gone prints the session info and exits without a reply. This is accepted behavior.
- `/reload` and a resume write no new system message when the prompt is unchanged. The proof is the absence of any later `preamble` or `skills` patch.
