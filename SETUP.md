# Set up pi-setup

Install this Pi configuration on the user's machine with mise, then check it
with the doctor until nothing fails. Pi loads its configuration from `~/.pi`,
so the repository is cloned there. Login and API keys stay with the user.

## Ask before you change anything

Linux and macOS are supported. On Windows, stop and tell the user that native
Windows is not supported and WSL is untested.

Look at `~/.pi` first:

- If it does not exist, continue.
- If it is a clone of this repository (`git -C ~/.pi remote -v` names
  `pi-setup`), reuse it. Run `git -C ~/.pi pull --ff-only` when the user agrees.
- Otherwise it holds the user's own Pi configuration, often with their login in
  `agent/auth.json` and their history in `agent/sessions/`. Stop and ask. Offer
  to move it to `~/.pi.backup-<date>` and copy `agent/auth.json` and
  `agent/sessions/` into the new checkout afterwards. Never delete it. Step 2
  of the install says how to swap it.

Then ask the user these questions in one message:

1. **Clone or fork?** Recommend a fork when they will change skills or
   settings, so their changes have a remote: `gh repo fork drsh4dow/pi-setup
   --clone=false`, then clone the fork.
2. **Which optional tiers?** Core is always installed. Each tier is a folder
   under [`mise/`](mise/) that pins the tools it lists.

   | Tier      | Enables                                         | Installs                   |
   | --------- | ----------------------------------------------- | -------------------------- |
   | `browser` | the `agent-browser` skill, for checking web UIs | agent-browser and Chrome   |
   | `formal`  | `statechart` and the TLA+ verification skills   | Java and TLC, about 305 MB |
   | `mail`    | the `mailbox` skill                             | himalaya                   |
   | `video`   | the `catchup-video` skill                       | uv and ffmpeg              |

3. **Share the skills with other agents?** Only when `~/.agents/skills` does
   not exist: setup can link it to this checkout's skills, so agents that read
   that folder (Claude Code, Codex, opencode) see them too.

## Install

1. Check mise with `mise --version`. Setup needs 2026.9.14 or newer. If mise
   is missing, install it with `curl https://mise.run | sh`, which puts it at
   `~/.local/bin/mise`, or with `brew install mise` on macOS. Then run
   `export PATH="$HOME/.local/bin:$PATH"`, because your shell does not have it
   on PATH yet. If mise is older, run `mise self-update`.
2. Clone the repository, or the user's fork:

   ```bash
   git clone https://github.com/drsh4dow/pi-setup.git ~/.pi
   ```

   When the user agreed to move an existing `~/.pi` aside, clone to
   `~/.pi.new` first and swap both in one command, since a running Pi,
   possibly you, writes to `~/.pi/agent` again right after a move:

   ```bash
   git clone https://github.com/drsh4dow/pi-setup.git ~/.pi.new
   backup=~/.pi.backup-$(date +%F)
   mv ~/.pi "$backup" && mv ~/.pi.new ~/.pi
   cp -R "$backup/agent/auth.json" "$backup/agent/sessions" ~/.pi/agent/
   ```

3. Run setup with the tiers the user chose, and `--link-agent-skills` if they
   asked for it:

   ```bash
   cd ~/.pi && mise run setup formal browser --link-agent-skills
   ```

   Setup links each tier into mise's global `conf.d` as `pi-setup-<tier>`, so
   its tools are on PATH in every project. It then installs the tools, runs
   `vp install`, which builds the bundled CLIs and creates
   `agent/settings.json`, and downloads Chrome for the browser tier. It refuses
   to replace anything it did not create. A rerun skips what is in place, and
   tiers from earlier runs stay.

   The root `mise.toml` holds only the `setup` and `doctor` tasks, and
   `mise run` trusts the config of the task it runs. The tier files become
   global mise config, which mise trusts. Show the user `mise/*/mise.toml` if
   they want to see what installs. Setup can take several minutes, so give it
   a long timeout.

   When setup fails, read its error, fix the cause, and run it again. On minimal
   Debian and Ubuntu systems, Node.js needs `libatomic1`.

## Verify

4. Run the doctor:

   ```bash
   cd ~/.pi && mise run doctor
   ```

   It prints one line per check, `ok`, `warn`, `skip`, or `FAIL`. Under a
   finding it can fix, a `fix:` line holds the shell command that fixes it.
   Advice that is not a command is in the finding's own text. The doctor exits
   0 when no check fails, 1 when one does, and 2 when it cannot run, with the
   reason on stderr.

5. Run the fix under each `FAIL`, or follow the finding's advice when it has
   no fix, then run the doctor again. Repeat until it
   exits 0. When a check still fails after two fixes, stop and show the user
   the doctor's output.

   - The doctor reads a new login shell, the way a new terminal starts. Your
     own shell may still miss the tools after a fix. That is expected, and the
     doctor's result is what counts.
   - The `shell` fix appends mise's activation line to the user's shell
     profile. Apply it and tell the user which file changed.
   - A fix that needs `sudo`, such as a system package, is yours to run when
     you can. Otherwise give the user the command.
   - `warn` and `skip` lines do not block setup. Leave them for the hand-off.

## Hand off

Tell the user:

- Which tiers are installed, and every file setup and the fixes changed:
  `~/.pi`, the `pi-setup-*` links in mise's `conf.d`, the shell profile line,
  and the `~/.agents/skills` link when it was made.
- To open a new terminal, start `pi`, and run `/login`.
- Each remaining `warn` line with its fix. The web-search skill needs
  `PERPLEXITY_API_KEY` and `EXA_API_KEY` in their shell profile. Ask them to
  set the keys themselves, and never ask them to paste a key into the chat.
- To run `/skill:setup-sh4dow-skills` once in each repository they work in.
- To add a tier later with `mise run setup <tier>`, and to update with
  `git -C ~/.pi pull && mise run setup`, then `mise run doctor`.
- That the [README](README.md#workflow) describes how to work with this setup.
