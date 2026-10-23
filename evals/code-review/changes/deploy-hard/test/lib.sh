# shellcheck shell=bash
# Test helpers. Every test runs in its own subshell with a fresh project, fresh fake
# hosts, and test/stubs ahead of the real ssh, scp, and curl on PATH.
#
# Fake hosts live in $STUB_HOSTS/HOST. The ssh and scp stubs map /srv/ paths into
# them, so deploy_root=/srv/demo on web1 is $STUB_HOSTS/web1/srv/demo. Dropping a file
# in $STUB_HOSTS/HOST makes the stubs misbehave for that host:
#   .unreachable   ssh and scp exit 255
#   .scp-fails     scp exits 1

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SHIPIT="$TEST_DIR/../bin/shipit"

fail() {
  printf '    %s\n' "$*" >&2
  exit 1
}

# assert_eq EXPECTED ACTUAL [WHAT]
assert_eq() {
  [[ $1 == "$2" ]] || fail "${3:-value}: expected '$1', got '$2'"
}

# assert_contains TEXT NEEDLE [WHAT]
assert_contains() {
  [[ $1 == *"$2"* ]] || fail "${3:-output} lacks '$2': $1"
}

# assert_not_contains TEXT NEEDLE [WHAT]
assert_not_contains() {
  [[ $1 != *"$2"* ]] || fail "${3:-output} has '$2': $1"
}

# assert_status CODE — the last shipit run exited with CODE.
assert_status() {
  [[ $STATUS == "$1" ]] || fail "expected exit $1, got $STATUS; stderr: $ERR"
}

# setup_project ENV HOST... — a project named demo (VERSION 1.0.0, one page in build/)
# with an inventory for ENV listing HOSTs, and an empty fake host for each HOST.
setup_project() {
  local env=$1 host
  shift
  TEST_TMP=$(mktemp -d)
  trap 'rm -rf "$TEST_TMP"' EXIT
  PROJECT="$TEST_TMP/project"
  export STUB_HOSTS="$TEST_TMP/hosts" STUB_STORE="$TEST_TMP/store" STUB_LOG="$TEST_TMP/stub.log"
  export PATH="$TEST_DIR/stubs:$PATH" SHIPIT_RETRY_DELAY=0
  unset SHIPIT_STORE_TOKEN SHIPIT_NOW SHIPIT_CONFIG
  mkdir -p "$PROJECT/build" "$PROJECT/hosts" "$STUB_HOSTS" "$STUB_STORE"
  : >"$STUB_LOG"
  cat >"$PROJECT/shipit.conf" <<'EOF'
# demo project
app=demo
deploy_root=/srv/demo
keep=3
store_url=https://store.example.test/artifacts
EOF
  printf '1.0.0\n' >"$PROJECT/VERSION"
  printf '<h1>demo</h1>\n' >"$PROJECT/build/index.html"
  : >"$PROJECT/hosts/$env.hosts"
  for host in "$@"; do
    printf '%s\n' "$host" >>"$PROJECT/hosts/$env.hosts"
    mkdir -p "$STUB_HOSTS/$host"
  done
}

# set_config KEY VALUE — sets KEY in shipit.conf, replacing an earlier value.
set_config() {
  local conf="$PROJECT/shipit.conf"
  grep -v "^$1=" "$conf" >"$conf.new" || true
  printf '%s=%s\n' "$1" "$2" >>"$conf.new"
  mv "$conf.new" "$conf"
}

set_version() {
  printf '%s\n' "$1" >"$PROJECT/VERSION"
}

# shipit ARG... — runs shipit in the project. Sets STATUS, OUT, and ERR.
shipit() {
  STATUS=0
  (cd "$PROJECT" && "$SHIPIT" "$@") >"$TEST_TMP/out" 2>"$TEST_TMP/err" || STATUS=$?
  OUT=$(cat "$TEST_TMP/out")
  ERR=$(cat "$TEST_TMP/err")
}

# shipit_ok ARG... — runs shipit and fails the test unless it exits 0.
shipit_ok() {
  shipit "$@"
  assert_status 0
}

# build_version VERSION — builds an artifact of the project at VERSION.
build_version() {
  set_version "$1"
  shipit_ok build
}

# deploy_at RELEASE_ID ENV [ARG...] — deploys with the clock set to RELEASE_ID.
deploy_at() {
  local id=$1
  shift
  export SHIPIT_NOW=$id
  shipit deploy "$@"
  unset SHIPIT_NOW
}

# enable_health_check [ATTEMPTS] — a health_cmd that fails on hosts marked with
# make_unhealthy, tried ATTEMPTS times (default 2) with no wait between tries.
enable_health_check() {
  set_config health_cmd 'test ! -e /srv/unhealthy'
  set_config health_attempts "${1:-2}"
  set_config health_interval 0
}

# make_unhealthy HOST — makes the enable_health_check health_cmd fail on HOST.
make_unhealthy() {
  mkdir -p "$STUB_HOSTS/$1/srv"
  touch "$STUB_HOSTS/$1/srv/unhealthy"
}

# host_events — "activate HOST" and "health HOST" for each activation and health check
# in the stub log, in the order they ran.
host_events() {
  local tool host command
  while read -r tool host command; do
    if [[ $tool != ssh ]]; then
      continue
    fi
    case $command in
      *current.tmp*) printf 'activate %s\n' "$host" ;;
      *unhealthy*) printf 'health %s\n' "$host" ;;
    esac
  done <"$STUB_LOG"
}

# on_host HOST PATH — PATH under HOST's deploy_root, on the fake host.
on_host() {
  printf '%s/%s/srv/demo/%s\n' "$STUB_HOSTS" "$1" "$2"
}

# current_of HOST — the release HOST's current link points at, or "none".
current_of() {
  local link
  link=$(on_host "$1" current)
  if [[ -L $link ]]; then
    basename "$(readlink "$link")"
  else
    printf 'none\n'
  fi
}

# releases_of HOST — HOST's release ids, oldest first, on one line.
releases_of() {
  local dir
  dir=$(on_host "$1" releases)
  if [[ -d $dir ]]; then
    find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd ' ' -
  fi
}

# run_tests — runs every test_* function in the calling file, each in a subshell
# with errexit on, and records the results for test/run.sh.
run_tests() {
  local fn status failed=0
  for fn in $(declare -F | awk '$3 ~ /^test_/ { print $3 }'); do
    set +e
    (
      set -e
      "$fn"
    )
    status=$?
    if (( status == 0 )); then
      printf 'ok   %s\n' "$fn" | tee -a "${TEST_RESULTS:-/dev/null}"
    else
      printf 'FAIL %s\n' "$fn" | tee -a "${TEST_RESULTS:-/dev/null}"
      failed=1
    fi
  done
  return "$failed"
}
