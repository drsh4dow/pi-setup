# Set up pi-setup

Install this Pi configuration on the user's machine with mise, then check it
with the doctor until nothing fails. Pi loads its configuration from `~/.pi`,
so the repository is cloned there. Login and API keys stay with the user.

## Ask before you change anything

Linux on x86_64 and macOS on Apple silicon are supported and tested in CI.
Other Linux architectures and Intel Macs are untested. On Windows, stop and
tell the user that native Windows is not supported and WSL is untested.

Look at `~/.pi` first:

- If it does not exist, continue.
- If it is a clone of this repository (`git -C ~/.pi remote -v` names
  `pi-setup`), ask whether to reuse it, and whether to update it first with
  `git -C ~/.pi pull --ff-only`. Skip step 2 of the install when they reuse it.
- Otherwise it holds the user's own Pi configuration, often with their login in
  `agent/auth.json` and their history in `agent/sessions/`. Stop and ask. Offer
  to move it to `~/.pi.backup-<date>` and copy `agent/auth.json` and
  `agent/sessions/` into the new checkout afterwards. Never delete it. Step 2
  of the install says how to swap it.

Then ask the user these questions in one message:

1. **Clone or fork?** Recommend a fork when they will change skills or
   settings, so their changes have a remote: `gh repo fork drsh4dow/pi-setup
   --clone=false`, then clone the fork.
2. **Which optional tiers?** Core is always installed and takes about 2.2 GB.
   Each tier is a folder under [`mise/`](mise/) that pins the tools it lists.
   The sizes are disk use on Linux x86_64, with mise's download cache.

   | Tier      | Enables                                         | Installs                                    | Disk    |
   | --------- | ----------------------------------------------- | ------------------------------------------- | ------- |
   | `browser` | the `agent-browser` skill, for checking web UIs | agent-browser and Chrome                    | ~450 MB |
   | `formal`  | `statechart` and the TLA+ verification skills   | Java and TLC                                | ~460 MB |
   | `mail`    | the `mailbox` skill                             | himalaya                                    | ~30 MB  |
   | `video`   | the `catchup-video` skill                       | uv, ffmpeg, and the cairo and pango headers | ~1.1 GB |

   On Debian and Ubuntu, the browser tier adds Google's apt repository and
   installs Google Chrome from it. Ubuntu 23.10 and later let only that Chrome
   use its sandbox, so the Chrome agent-browser downloads cannot start there.
   Tell the user before they choose this tier.

3. **Share the skills with other agents?** Only when `~/.agents/skills` does
   not exist: setup can link it to this checkout's skills, so agents that read
   that folder (Claude Code, Codex, opencode) see them too.

## Install

1. Check mise with `mise --version`. Setup needs 2026.9.14 or newer.
   - When mise is installed, use it, whichever way it was installed. mise
     warns against a second installation, since an older one on PATH can stay
     in use.
   - When it is older, update it the way it was installed: with the package
     manager that installed it, such as `sudo pacman -Syu mise` or
     `brew upgrade mise`, or with `mise self-update` for an install from
     mise.run. Package builds turn `self-update` off.
   - When it is missing, install it with `curl https://mise.run | sh`, the
     method mise recommends on Linux and macOS. It puts mise at
     `~/.local/bin/mise`, which is not on PATH yet. Each of your commands may
     start a new shell, so begin every later command that runs mise with
     `export PATH="$HOME/.local/bin:$PATH";`.
2. Clone the repository, or the user's fork:

   ```bash
   git clone https://github.com/drsh4dow/pi-setup.git ~/.pi
   ```

   When the user agreed to move an existing `~/.pi` aside, clone to
   `~/.pi.new` first, then swap the two in one command. A running Pi writes to
   `~/.pi/agent`, and that Pi may be you, so a separate move leaves a new
   `~/.pi` behind. The command stops when the backup path is taken, and copies
   the login and the sessions only when they exist:

   ```bash
   git clone https://github.com/drsh4dow/pi-setup.git ~/.pi.new
   backup=~/.pi.backup-$(date +%Y%m%d-%H%M%S)
   if [ -e "$backup" ]; then echo "$backup exists" >&2; else
     mv ~/.pi "$backup" && mv ~/.pi.new ~/.pi &&
       for name in auth.json sessions; do
         [ ! -e "$backup/agent/$name" ] || cp -R "$backup/agent/$name" ~/.pi/agent/
       done
   fi
   ```

3. Run setup with the tiers the user chose, and `--link-agent-skills` if they
   asked for it:

   ```bash
   cd ~/.pi && mise run setup formal browser --link-agent-skills
   ```

   Setup links each tier into mise's global `conf.d` as `pi-setup-<tier>`, so
   its tools are on PATH in every project. It refuses to replace anything it
   did not create. A rerun skips what is in place, and tiers from earlier runs
   stay. In order, it:

   - installs the system libraries the tiers declare in `[bootstrap.packages]`,
     such as the libatomic Node.js needs and Google Chrome on Debian and
     Ubuntu, with this machine's package manager and sudo. Without
     passwordless sudo it stops and prints the command that installs them.
     Give that command to the user to run in their own terminal, where sudo
     can ask for a password, then run setup again.
   - installs the tools the tiers pin.
   - runs `vp install`, which builds the bundled CLIs and creates
     `agent/settings.json`.
   - downloads Chrome for Testing for the browser tier, except where Google
     Chrome is installed.

   The root `mise.toml` holds only the `setup` and `doctor` tasks, and
   `mise run` trusts the config of the task it runs. The tier files become
   global mise config, which mise trusts. Show the user `mise/*/mise.toml` if
   they want to see what installs. Setup can take several minutes, so give it
   a long timeout.

   When setup fails, read its error, fix the cause, and run it again.

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

   - The doctor reads the shell a new terminal starts: a login shell on macOS,
     and an interactive non-login shell on Linux. Your own shell may still miss
     the tools after a fix. That is expected, and the doctor's result is what
     counts.
   - The `shell` fix appends mise's activation line to the user's shell
     profile. Apply it and tell the user which file changed.
   - A fix that installs system packages, `mise bootstrap packages apply`,
     uses this machine's package manager and sudo. Run it when sudo works
     without a password. Otherwise give the user the command.
   - `warn` and `skip` lines do not block setup. Leave them for the hand-off.

## Hand off

Tell the user:

- Which tiers are installed, and every change setup and the fixes made:
  `~/.pi`, the `pi-setup-*` links in mise's `conf.d`, the system packages
  and apt repositories mise installed, the shell profile line, and the
  `~/.agents/skills` link when it was made.
- To open a new terminal, start `pi`, and run `/login`.
- Each remaining `warn` line with its fix. The web-search skill needs
  `PERPLEXITY_API_KEY` and `EXA_API_KEY` in their shell profile. Ask them to
  set the keys themselves, and never ask them to paste a key into the chat.
- To run `/skill:setup-sh4dow-skills` once in each repository they work in.
- To add a tier later with `cd ~/.pi && mise run setup <tier>`, and to
  update with `cd ~/.pi && git pull && mise run setup && mise run doctor`.
- That the [README](README.md#workflow) describes how to work with this setup.
