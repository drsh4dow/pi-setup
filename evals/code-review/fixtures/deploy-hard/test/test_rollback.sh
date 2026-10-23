#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# deploy_releases ENV ID... — deploys the built artifact once per ID.
deploy_releases() {
  local env=$1 id
  shift
  for id in "$@"; do
    deploy_at "$id" "$env"
    assert_status 0
  done
}

test_rollback_returns_to_the_previous_release() {
  setup_project staging web1 web2
  build_version 1.0.0
  deploy_releases staging 20240101000000 20240102000000
  shipit_ok rollback staging
  assert_eq 20240101000000 "$(current_of web1)" "web1 current"
  assert_eq 20240101000000 "$(current_of web2)" "web2 current"
}

test_rollback_twice_goes_further_back() {
  setup_project staging web1
  build_version 1.0.0
  deploy_releases staging 20240101000000 20240102000000 20240103000000
  shipit_ok rollback staging
  shipit_ok rollback staging
  assert_eq 20240101000000 "$(current_of web1)" "web1 current"
}

test_rollback_to_a_given_release() {
  setup_project staging web1
  build_version 1.0.0
  deploy_releases staging 20240101000000 20240102000000 20240103000000
  shipit_ok rollback staging --to 20240101000000
  assert_eq 20240101000000 "$(current_of web1)" "web1 current"
}

test_rollback_without_an_older_release_fails() {
  setup_project staging web1
  build_version 1.0.0
  deploy_releases staging 20240101000000
  shipit rollback staging
  assert_status 1
  assert_contains "$ERR" "no release older than the current one"
  assert_eq 20240101000000 "$(current_of web1)" "web1 current"
}

test_rollback_checks_every_host_before_switching() {
  setup_project staging web1 web2
  build_version 1.0.0
  deploy_releases staging 20240101000000 20240102000000
  rm -r "$(on_host web2 releases/20240101000000)"
  shipit rollback staging --to 20240101000000
  assert_status 1
  assert_eq 20240102000000 "$(current_of web1)" "web1 current"
}

test_rollback_rejects_a_malformed_release_id() {
  setup_project staging web1
  build_version 1.0.0
  deploy_releases staging 20240101000000
  shipit rollback staging --to ../../etc
  assert_status 2
}

run_tests
