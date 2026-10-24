# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi). You
and the agent agree on what to build, and agents build it ticket by ticket.
Then they test it on the running app, before the merge and again after
deploy. Clone it to `~/.pi` and Pi loads it as is.

## Install

Requires [Vite+](https://viteplus.dev/guide/).

```bash
git clone https://github.com/drsh4dow/pi-setup.git ~/.pi   # move an existing ~/.pi aside first
cd ~/.pi && vp install
vp install -g @earendil-works/pi-coding-agent
pi                                                          # then /login
```

Run `/skill:setup-sh4dow-skills` once in each repository. It records where the
issues live, where the domain docs are, and which checks the code must pass.
Web search needs `PERPLEXITY_API_KEY` and `EXA_API_KEY`.

## Workflow

1. **Agree on the problem.** Alternate `/skill:grill-with-docs` with
   prototypes until you and the agent describe the problem the same
   way. The agent writes each term you agree on into `GLOSSARY.md` and each
   decision into a short decision record (ADR). Then run `/skill:to-spec` and
   `/skill:to-tickets`, which files the tickets under the spec.
2. **Build it.** `/implement-chunk <spec ticket>` asks its questions first.
   Then it gives each ticket to a subagent, reviews and tests every PR, and
   hands you a few final PRs to merge.
3. **Test it on the real app.** Agents start your app and use it like a user,
   through a skill in the repo called `verify-<app>`. Create it with
   `/skill:create-verification-skill`. When the app changes, update it with
   `/skill:maintain-verification-skill`.
4. **Check it after deploy.** `implement-chunk` tests each merged ticket on
   the deployed app. If one fails, it tells you right away and attaches
   screenshots and logs. You decide on reverts and deploys.

To keep the codebase easy to work in:

- `/skill:improve-codebase-architecture` finds modules that expose more than
  they do.
- `/skill:create-formal-verification-skill` writes a formal model of a state
  machine, a retry loop, or a race, and checks every order of events.
  `/skill:maintain-formal-verification-skill` updates the model when the code
  changes.
- `/skill:correct` turns a mistake agents keep making into a type, lint rule,
  or test.
- `/skill:reflect` turns what a session taught into skill edits.

Most skills don't appear in `/skill:`. The agent loads them on its own when
they apply: `principle-*` skills when it writes code, `how` and `why` when it
reads code, and `domain-modeling` when you discuss terms. For the full list of
skills, extensions, and prompts, and who starts each, see
[docs/inventory.md](docs/inventory.md).

## Defaults

The default model is Opus 5.5 with high thinking and Fast mode. Codemode is on,
and code review also uses `gpt-6.1-sol`. [`agent/SYSTEM.md`](agent/SYSTEM.md)
holds only the guardrails. Everything else lives in skills. Shared defaults
are in [`agent/default.settings.json`](agent/default.settings.json). Your own
`agent/settings.json` stays out of git.

## Development

```bash
vp run verify     # everything CI runs
vp run test:e2e   # live Pi tests, needs credentials
```

See [docs/development.md](docs/development.md).

## Credits

Inspired by [pstack](https://github.com/cursor/plugins/tree/main/pstack),
[Matt Pocock's skills](https://github.com/mattpocock/skills),
[Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills), and
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).
MIT licensed.
