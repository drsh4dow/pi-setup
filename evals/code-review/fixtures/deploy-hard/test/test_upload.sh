#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_upload_puts_artifact_and_checksum_in_the_store() {
  setup_project staging web1
  build_version 1.2.0
  export SHIPIT_STORE_TOKEN=t0k3n
  shipit_ok upload
  [[ -f $STUB_STORE/artifacts/demo/demo-1.2.0.tar.gz ]] || fail "artifact not in the store"
  [[ -f $STUB_STORE/artifacts/demo/demo-1.2.0.tar.gz.sha256 ]] || fail "checksum not in the store"
  assert_contains "$(cat "$STUB_LOG")" "Authorization: Bearer t0k3n" "curl calls"
}

test_upload_picks_the_highest_version() {
  setup_project staging web1
  build_version 1.9.0
  build_version 1.10.0
  export SHIPIT_STORE_TOKEN=t0k3n
  shipit_ok upload
  [[ -f $STUB_STORE/artifacts/demo/demo-1.10.0.tar.gz ]] || fail "1.10.0 not uploaded"
  [[ ! -e $STUB_STORE/artifacts/demo/demo-1.9.0.tar.gz ]] || fail "1.9.0 uploaded"
}

test_upload_needs_a_token() {
  setup_project staging web1
  build_version 1.0.0
  shipit upload
  assert_status 3
  assert_contains "$ERR" "SHIPIT_STORE_TOKEN is not set"
}

test_upload_retries_a_failed_put() {
  setup_project staging web1
  build_version 1.0.0
  export SHIPIT_STORE_TOKEN=t0k3n
  printf '2\n' >"$STUB_STORE/.failures"
  shipit_ok upload
  assert_contains "$ERR" "attempt 1 of 3 failed"
  [[ -f $STUB_STORE/artifacts/demo/demo-1.0.0.tar.gz ]] || fail "artifact not in the store"
}

test_upload_failure_masks_the_token() {
  setup_project staging web1
  build_version 1.0.0
  export SHIPIT_STORE_TOKEN=t0k3n
  printf '9\n' >"$STUB_STORE/.failures"
  shipit upload
  assert_status 1
  assert_contains "$ERR" "Bearer ***"
  assert_not_contains "$ERR" "t0k3n"
}

run_tests
