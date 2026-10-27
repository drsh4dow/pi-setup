#!/usr/bin/env bash
# Installs this Pi setup's tools and dependencies. SETUP.md runs it through mise run setup.
# Usage: mise run setup [--link-agent-skills] [TIER...]
# Each TIER is a folder under mise/. Setup links it, and always core, into mise's global conf.d as
# pi-setup-<tier>, so its tools are on PATH in every project. Tiers linked by an earlier run stay.
# Rerunning is safe: each step skips what is already in place.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
conf_d="${MISE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mise}/conf.d"
# mise run passes its own path, since a fresh install may not be on PATH yet.
mise="${PI_SETUP_MISE:-mise}"
tiers=(core)
link_agent_skills=false

for arg in "$@"; do
  case "$arg" in
    --link-agent-skills) link_agent_skills=true ;;
    -*)
      echo "setup: unknown option $arg. Usage: mise run setup [--link-agent-skills] [TIER...]" >&2
      exit 2
      ;;
    *)
      if [ ! -f "$repo/mise/$arg/mise.toml" ]; then
        echo "setup: no tier named $arg. The tiers are: $(ls "$repo/mise" | tr '\n' ' ')" >&2
        exit 2
      fi
      tiers+=("$arg")
      ;;
  esac
done

# Links $2 to $1 unless it already is that link. Anything else at $2 belongs to the user.
link() {
  local target="$1" path="$2"
  if [ -L "$path" ] && [ "$(cd "$path" && pwd -P)" = "$(cd "$target" && pwd -P)" ]; then return; fi
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "setup: $path already exists and is not a link to $target. Move it aside, then rerun setup." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$path")"
  ln -s "$target" "$path"
  echo "setup: linked $path -> $target"
}

for tier in "${tiers[@]}"; do link "$repo/mise/$tier" "$conf_d/pi-setup-$tier"; done

# From an empty directory, so only global config decides what mise installs.
neutral="$(mktemp -d)"
trap 'rm -rf "$neutral"' EXIT
(cd "$neutral" && MISE_CEILING_PATHS="$neutral" "$mise" install)

# mise exec reads the config again, so it sees the tiers linked above. vp creates the Node.js
# shims that mise/core/mise.toml puts on PATH; a rerun keeps the existing ones.
(cd "$neutral" && MISE_CEILING_PATHS="$neutral" "$mise" exec -- vp env setup)

# Node.js runs the install scripts, so a Node.js that cannot start would fail deep inside
# vp install. In this checkout, vp downloads the Node.js version package.json pins.
if ! said="$(cd "$repo" && "$mise" exec -- node --version 2>&1)"; then
  echo "setup: Node.js does not start: $said" >&2
  echo "On minimal Debian and Ubuntu, sudo apt-get install -y libatomic1 fixes a missing libatomic.so.1. Then rerun setup." >&2
  exit 1
fi
(cd "$repo" && "$mise" exec -- vp install --frozen-lockfile)

if [ -e "$conf_d/pi-setup-browser" ]; then
  (cd "$neutral" && MISE_CEILING_PATHS="$neutral" "$mise" exec -- agent-browser install)
fi

if $link_agent_skills; then link "$repo/agent/skills" "$HOME/.agents/skills"; fi

echo "setup: done. Next: mise run doctor"
