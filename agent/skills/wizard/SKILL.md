---
name: wizard
description: Generate an interactive bash wizard for steps only a human can perform. Use when provisioning infrastructure, credentials, CI secrets, third-party dashboards, or one-off migrations need the user's hands.
---

# Wizard

Generate a bash script for the parts of a procedure that require human interaction. Use [template.sh](template.sh) for progress, URL opening, hidden secret entry, idempotent `.env` updates, and GitHub secret or variable writes. Author the stages; keep the reusable library above the `STAGES` marker unchanged.

A wizard is ephemeral by default: built for one run, saved to a scratch or `scripts/` path, deleted when the job's done. Commit it only when the user wants a repeatable setup path that should live in the repo.

## Process

### 1. Scope the procedure

Work out every manual step the human must take and every value that gets captured along the way. Read the repo first, don't ask cold:

- For setup: inspect relevant environment examples, documentation, service configuration, and CI references. Capture only values required by the requested procedure; reuse existing configuration rather than reprovisioning it.
- For a migration or transition: the current state, the target state, and the irreversible actions between them.

Infer routine choices and prepare the wizard before asking for stage approval. Ask only when an unresolved choice materially changes the procedure. Automate steps the agent can already perform within the task; reserve the wizard for steps that need the user's interaction.

**Done when:** every stage is named in order, and for each captured value you know (a) where the human gets it, (b) where it's written (`.env`, a GitHub secret, both, or nowhere; some stages are pure actions), and (c) whether it's secret (hidden entry) or public.

### 2. Map each stage's journey

For each stage, write the precise path a human follows: which URL to open, what to do there, where a value is shown, which variable it fills: e.g. "Dashboard → Developers → API keys → Reveal test key → copy". Verify uncertain UI paths or commands against current documentation or the actual interface. Ask the user only for a material detail you cannot establish; mark any unverified step rather than inventing it.

**Done when:** every stage traces to concrete instructions a stranger could follow.

### 3. Author the wizard

Copy `template.sh` to the target path. Replace the example stage with one `stage` per step, in dependency order. Use the library helpers: `stage`, `say`/`step`, `open_url`, `ask`/`ask_secret`, `write_env`, `set_secret`/`set_var`, `pause`/`confirm`. Set `TOTAL_STAGES` to the number of stages you wrote.

Hold the bar the template sets: open the URL before asking for its value, use `ask_secret` for anything secret, `write_env` every persisted value, `set_secret` only the values CI actually needs, and `confirm` before any irreversible action. Each `stage` clears the screen so only the current step is visible: keep a stage to one focused task so nothing the human needs scrolls away. Don't touch the library above the marker.

### 4. Verify and hand off

- `bash -n <script>`; run `shellcheck` if available.
- `chmod +x <script>`.
- Don't run it end-to-end yourself: it opens browsers and blocks on human input. Trace it statically instead: every value from step 1 is captured and lands where step 1 said, and every `set_secret` name exactly matches a `secrets.*` reference in CI.
- Deliver the reviewable script, its stages, and how to run it. If a repeatable setup path is requested, document its invocation in the README; commit when committing is included in the task.
