# Human in the loop

Run the HITL loop when a step needs a human: a click, a device, a sign-in. Pi's bash tool and background terminals have no terminal for input, so the script runs in a pane the user sees and writes the answers to a file. A background terminal waits for that file and wakes you when it appears.

1. Copy [`scripts/hitl-loop.template.sh`](scripts/hitl-loop.template.sh) into this bug's state folder and replace the steps between the `edit` markers. Pick a new answers path for each run, such as `<dir>/answers-1.env`, because the waiter returns as soon as the file exists.
2. Open the script in a pane the user sees, taking the first case that applies:
   - `$HERDR_PANE_ID` is set: `herdr pane split --current --direction right` prints JSON whose `result.pane.pane_id` is the new pane. Then run `herdr pane run <pane_id> "bash <script> <answers>"`.
   - `$TMUX` is set: `tmux split-window -h bash <script> <answers>`.
   - `ghostty` is on `PATH` on Linux: `ghostty +new-window -e bash <script> <answers>`.
   - Otherwise, give the user the command `bash <script> <answers>` to run in their own terminal.
3. Start a background terminal with `until [ -e <answers> ]; do sleep 1; done; cat <answers>`. Tell the user what the pane asks of them, and end the turn. The terminal's completion wakes you with the answers.
4. After the answers arrive, close a herdr pane with `herdr pane close <pane_id>`. The tmux and Ghostty panes close when the script exits. If the user abandons the loop, stop the waiter with `bg_kill`.
