#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_build_packs_build_dir_and_prints_the_path() {
  setup_project staging web1
  shipit_ok build
  assert_eq "$PROJECT/dist/demo-1.0.0.tar.gz" "$OUT" "artifact path"
  assert_contains "$(tar -tzf "$PROJECT/dist/demo-1.0.0.tar.gz")" "./index.html"
  (cd "$PROJECT/dist" && sha256sum --check --status demo-1.0.0.tar.gz.sha256) || fail "checksum does not match"
}

test_build_is_reproducible() {
  setup_project staging web1
  shipit_ok build
  local first
  first=$(cat "$PROJECT/dist/demo-1.0.0.tar.gz.sha256")
  touch "$PROJECT/build/index.html"
  shipit_ok build
  assert_eq "$first" "$(cat "$PROJECT/dist/demo-1.0.0.tar.gz.sha256")" "checksum of a rebuild"
}

test_build_runs_build_cmd_first() {
  setup_project staging web1
  set_config build_cmd 'printf "made\n" > build/made.txt'
  shipit_ok build
  assert_contains "$(tar -tzf "$PROJECT/dist/demo-1.0.0.tar.gz")" "./made.txt"
}

test_build_rejects_a_bad_version() {
  setup_project staging web1
  set_version banana
  shipit build
  assert_status 3
  assert_contains "$ERR" "is not a version"
}

test_build_needs_build_dir() {
  setup_project staging web1
  rm -r "$PROJECT/build"
  shipit build
  assert_status 3
  assert_contains "$ERR" "nothing to pack"
}

test_build_leaves_no_staging_directory() {
  setup_project staging web1
  export TMPDIR="$TEST_TMP/tmp"
  mkdir -p "$TMPDIR"
  shipit_ok build
  assert_eq "" "$(ls -A "$TMPDIR")" "leftovers in TMPDIR"
}

run_tests
