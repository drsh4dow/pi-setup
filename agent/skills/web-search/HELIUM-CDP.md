# Helium CDP fallback

Use the user's default Helium profile only when the isolated agent-browser route is blocked specifically because the site rejects an automated or development browser. This profile and its existing tabs are user-owned: open one new tab, operate only in that tab, and leave Helium running. Load [CAPTURE.md](CAPTURE.md) and assign a unique filesystem-safe attempt label such as `helium_attempt='01-helium'`.

## Reach a CDP endpoint

Set `helium_pid="$(pgrep -xo helium || true)"`, then use this bounded atomic poll to validate the recorded endpoint:

```bash
for _ in $(seq 1 40); do
  helium_port="$(head -n 1 "$HOME/.config/net.imput.helium/DevToolsActivePort" 2>/dev/null || true)"
  if test -z "$helium_port"; then
    sleep 0.25
    continue
  fi
  if capture_json "$run_dir/${helium_attempt}-cdp.json" curl -fsS --max-time 0.2 "http://127.0.0.1:$helium_port/json/version" 2> "$run_dir/${helium_attempt}-cdp.stderr"; then
    break
  fi
  sleep 0.05
done
test -s "$run_dir/${helium_attempt}-cdp.json"
```

A stale `DevToolsActivePort` file is not a live endpoint. If the poll fails while `helium_pid` is set, stop as `blocked`: attaching requires the user to relaunch Helium with CDP, and interrupting their browser is outside this fallback. If no Helium process exists, start `helium-browser --remote-debugging-port=0` in a background terminal and run the poll once more. A second failure closes this route as `blocked`.

## Use one pinned tab

Derive a collision-free agent-browser session, then create this tab manager. It installs cleanup before opening the tab, captures the returned target ID atomically, binds that exact target, and closes only that target when terminated:

```bash
browser_session="$(agent-browser session id --scope worktree --prefix "helium-${helium_attempt}-$(basename "$run_dir")")"
tab_json="$run_dir/${helium_attempt}-tab.json"
tab_state="$run_dir/${helium_attempt}-tab.state"
tab_manager="$run_dir/${helium_attempt}-tab-manager.sh"
test ! -e "$tab_json" && test ! -e "$tab_state" && test ! -e "$tab_manager"
cat > "${tab_manager}.tmp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
browser_session="$1"
helium_port="$2"
url="$3"
tab_json="$4"
tab_state="$5"
lease_deadline=$((SECONDS + 570))
read_target() {
  python -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["targetId"])' "$1" 2>/dev/null
}
cleanup() {
  trap - EXIT INT TERM
  local target
  target="$(read_target "$tab_json" || read_target "${tab_json}.tmp" || true)"
  test -z "$target" || timeout 30s agent-browser --session "$browser_session" --cdp "$helium_port" --pin-tab tab close "$target" >/dev/null 2>&1 || true
  rm -f -- "${tab_json}.tmp" "${tab_state}.tmp"
}
trap cleanup EXIT INT TERM
timeout 30s agent-browser --session "$browser_session" --cdp "$helium_port" --json tab new "$url" > "${tab_json}.tmp"
read_target "${tab_json}.tmp" >/dev/null
mv "${tab_json}.tmp" "$tab_json"
helium_target="$(read_target "$tab_json")"
timeout 30s agent-browser --session "$browser_session" --cdp "$helium_port" --pin-tab tab "$helium_target" >/dev/null
printf 'ready\n' > "${tab_state}.tmp"
mv "${tab_state}.tmp" "$tab_state"
lease_remaining=$((lease_deadline - SECONDS))
((lease_remaining > 0))
sleep "$lease_remaining"
SH
chmod 700 "${tab_manager}.tmp"
mv "${tab_manager}.tmp" "$tab_manager"
```

Start `bash "$tab_manager" "$browser_session" "$helium_port" "$url" "$tab_json" "$tab_state"` in a tracked background terminal and retain its terminal ID, then run:

```bash
for _ in $(seq 1 260); do
  grep -Fxq ready "$tab_state" 2>/dev/null && break
  sleep 0.25
done
grep -Fxq ready "$tab_state"
helium_target="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["targetId"])' "$tab_json")"
```

If the final check fails, terminate the manager and close this route as `blocked`.

The manager bounds tab ownership and cleanup to ten minutes from startup. Wrap every browser command in `timeout 30s` and pass the same `--session`, `--cdp`, and `--pin-tab` flags. Follow the loaded agent-browser core workflow inside the bound tab. On success, close with `timeout 30s agent-browser --session "$browser_session" --cdp "$helium_port" --pin-tab tab close "$helium_target"`, then terminate the manager. On any error, terminate the manager before reporting so its trap closes the target. Do not run `agent-browser close`, close other tabs, inspect unrelated profile state, or terminate Helium.

This route is complete when the required rendered evidence was inspected in the agent-created tab and that tab was closed. If no live CDP endpoint is available or the site still blocks access, report `blocked` and the human action that would reopen the route.
