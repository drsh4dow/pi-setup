#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, processes running in it, and the
# most recent Pi session that operated in it. Emits a table sorted by size with
# a suggested bucket. Never deletes anything; deletion stays a human-gated step
# in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref the MERGED column checks against (e.g. origin/integration).
#   Without it the base is origin/HEAD, then origin/main, then origin/master.
#   origin/HEAD is the remote's default branch, not necessarily the branch PRs
#   merge into; pass -b when they differ.
#
# LAST_CHAT is the date of the newest mtime among Pi session files (*.jsonl)
# under ${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions: any file in the worktree's
# own session directory, or a file in the main worktree's session directory that
# mentions the worktree path.
# LIVE lists the PIDs whose cwd is the worktree or inside it, read from
# /proc/*/cwd, or "-" for none. It is "?" where /proc is absent (macOS). Any
# live PID buckets the worktree hold-in-use unless it is already hold-wip.
set -u

base=""
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*) break ;;
	esac
done

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')

if [ -z "$base" ]; then
	for cand in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
		[ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null && { base="$cand"; break; }
	done
	[ -z "$base" ] && { echo "error: no base ref (origin/HEAD, origin/main, origin/master all missing); pass -b <ref>" >&2; exit 1; }
	echo "warn: no -b given; MERGED checks against $base" >&2
fi

# The base drives the merge check. The fetch is best-effort (stale is fine for
# a first pass) and runs before the check, since -b may name a branch not
# fetched yet. The explicit refspec creates it even in a single-branch clone.
case "$base" in
origin/*) git fetch origin "+refs/heads/${base#origin/}:refs/remotes/$base" --quiet 2>/dev/null \
	|| echo "warn: could not fetch $base; merged column may be stale" >&2 ;;
esac
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "error: base ref not found: $base" >&2; exit 1; }

# PR state by branch, fetched once as [{number, state, head}] with a lowercase
# state. Origin when its CLI can read this repo's PRs, otherwise gh. Empty when
# neither can.
prs=$(mktemp)
if command -v origin >/dev/null 2>&1 \
	&& raw=$(origin pr list --author "@me" --state all --limit 1000 \
		--json number,status,headRef 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: .status, head: .headRef}]' > "$prs" 2>/dev/null
elif raw=$(gh pr list --author "@me" --state all --limit 1000 \
	--json number,state,headRefName 2>/dev/null); then
	printf '%s' "$raw" | jq '[.[] | {number, state: (.state | ascii_downcase), head: .headRefName}]' > "$prs" 2>/dev/null
fi
[ -s "$prs" ] || echo "[]" > "$prs"

# Session dir: <agent-dir>/sessions/--<cwd without its leading /, with / \ : as ->--.
sessions="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
session_dir() { printf '%s/--%s--' "$sessions" "$(printf '%s' "$1" | sed 's#^[/\\]##; s#[/\\:]#-#g')"; }
main_sessions=$(session_dir "$main_wt")
now=$(date +%s)

if stat -c '%Y' / >/dev/null 2>&1; then mtime_fmt=(-c '%Y %n'); else mtime_fmt=(-f '%m %N'); fi
day() { date -d "@$1" '+%Y-%m-%d' 2>/dev/null || date -r "$1" '+%Y-%m-%d'; }

procs=""
if [ -d /proc ]; then
	procs=$(for p in /proc/[0-9]*; do
		pid=${p#/proc/}
		[ -e "$p/cwd" ] || continue
		{ read -r stat < "$p/stat"; } 2>/dev/null || continue
		read -r _ ppid _ <<< "${stat##*) }"
		case " $pid $ppid " in *" $$ "*|*" $BASHPID "*) continue ;; esac
		cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
		printf '%s\t%s\n' "$pid" "$cwd"
	done)
fi

echo "# base: $base"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tLIVE\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash-merged branches are not ancestors of the base, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" "$base" 2>/dev/null && merged=YES || merged=no

	# Distinguish real WIP (tracked edits) from disposable untracked scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	pr=$([ -n "$branch" ] && jq -r --arg b "$branch" \
		'.[] | select(.head==$b) | "#\(.number)/\(.state)"' "$prs" 2>/dev/null | head -1)
	[ -z "$pr" ] && pr="-"

	# Match path followed by "/" or a quote so glint-482 does not match
	# glint-482-r37.
	last="-"; last_ts=0
	own_sessions=$(session_dir "$wt")
	f=$( { [ -d "$own_sessions" ] && find "$own_sessions" -maxdepth 1 -name '*.jsonl' -print0
		[ -d "$main_sessions" ] && rg -l -0 -F -g '*.jsonl' -e "${wt}/" -e "${wt}\"" "$main_sessions"
	} 2>/dev/null | xargs -0 stat "${mtime_fmt[@]}" 2>/dev/null | sort -rn | head -1)
	if [ -n "$f" ]; then last_ts=$(echo "$f" | awk '{print $1}')
		last=$(day "$last_ts" 2>/dev/null); fi
	recent=$([ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ] && echo yes || echo no)

	if [ -d /proc ]; then
		live=$(printf '%s\n' "$procs" | WT="$wt" awk -F'\t' '$2 == ENVIRON["WT"] || index($2, ENVIRON["WT"] "/") == 1 {print $1}' | paste -sd, -)
		[ -z "$live" ] && live="-"
	else live="?"; fi

	if [[ $dirty == wip:* ]]; then bucket=hold-wip
	elif [ "$live" != "-" ] && [ "$live" != "?" ]; then bucket=hold-in-use
	elif [[ $pr == */open || $pr == */draft ]]; then bucket=hold-open-pr
	elif [ "$recent" = yes ]; then bucket=verify-recent-chat
	elif [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
	else bucket=review; fi

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$live" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh

rm -f "$prs"
