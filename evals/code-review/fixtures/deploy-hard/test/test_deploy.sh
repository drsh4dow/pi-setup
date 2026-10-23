#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_deploy_activates_the_release_on_every_host() {
  setup_project staging web1 web2
  build_version 1.0.0
  deploy_at 20240101000000 staging
  assert_status 0
  local host
  for host in web1 web2; do
    assert_eq 20240101000000 "$(current_of "$host")" "$host current"
    [[ -f $(on_host "$host" current/index.html) ]] || fail "$host: release not unpacked"
    [[ -f $(on_host "$host" artifacts/demo-1.0.0.tar.gz) ]] || fail "$host: artifact not uploaded"
    assert_eq 2 "$(cat "$(on_host "$host" .shipit-layout)")" "$host layout"
  done
}

test_deploy_keeps_the_newest_releases() {
  setup_project staging web1
  build_version 1.0.0
  local id
  for id in 20240101000000 20240102000000 20240103000000 20240104000000; do
    deploy_at "$id" staging
    assert_status 0
  done
  assert_eq "20240102000000 20240103000000 20240104000000" "$(releases_of web1)" "releases kept"
  assert_contains "$ERR" "web1: pruned 1 old release(s)"
}

test_deploy_releases_every_lock() {
  setup_project staging web1 web2
  build_version 1.0.0
  deploy_at 20240101000000 staging
  assert_status 0
  [[ ! -e $(on_host web1 .lock) && ! -e $(on_host web2 .lock) ]] || fail "a lock was left behind"
  deploy_at 20240102000000 staging
  assert_status 0
}

test_locked_host_stops_the_deploy_before_any_change() {
  setup_project staging web1 web2
  build_version 1.0.0
  mkdir -p "$(on_host web2 .lock)"
  deploy_at 20240101000000 staging
  assert_status 4
  assert_contains "$ERR" "web2 is locked"
  assert_eq none "$(current_of web1)" "web1 current"
  [[ ! -e $(on_host web1 .lock) ]] || fail "web1 lock was not released"
}

test_unreachable_host_stops_the_deploy_before_any_change() {
  setup_project staging web1 web2
  build_version 1.0.0
  touch "$STUB_HOSTS/web2/.unreachable"
  deploy_at 20240101000000 staging
  assert_status 1
  assert_eq none "$(current_of web1)" "web1 current"
}

test_failed_step_stops_the_deploy_at_that_host() {
  setup_project staging web1 web2 web3
  build_version 1.0.0
  touch "$STUB_HOSTS/web2/.scp-fails"
  deploy_at 20240101000000 staging
  assert_status 1
  assert_contains "$ERR" "step failed"
  assert_eq 20240101000000 "$(current_of web1)" "web1 current"
  assert_eq none "$(current_of web2)" "web2 current"
  assert_eq none "$(current_of web3)" "web3 current"
}

test_newer_layout_is_refused() {
  setup_project staging web1
  build_version 1.0.0
  mkdir -p "$(on_host web1 '')"
  printf '3\n' >"$(on_host web1 .shipit-layout)"
  deploy_at 20240101000000 staging
  assert_status 1
  assert_contains "$ERR" "written by a newer shipit"
  assert_eq none "$(current_of web1)" "web1 current"
}

test_layout_1_is_upgraded_in_place() {
  setup_project staging web1
  build_version 1.0.0
  mkdir -p "$(on_host web1 '')"
  printf '1\n' >"$(on_host web1 .shipit-layout)"
  printf 'old\n' >"$(on_host web1 demo-0.9.0.tar.gz)"
  deploy_at 20240101000000 staging
  assert_status 0
  [[ -f $(on_host web1 artifacts/demo-0.9.0.tar.gz) ]] || fail "old artifact not moved"
  assert_eq 2 "$(cat "$(on_host web1 .shipit-layout)")" "layout"
}

test_deploy_of_a_given_artifact() {
  setup_project staging web1
  build_version 1.0.0
  build_version 1.1.0
  deploy_at 20240101000000 staging "$PROJECT/dist/demo-1.0.0.tar.gz"
  assert_status 0
  [[ -f $(on_host web1 artifacts/demo-1.0.0.tar.gz) ]] || fail "1.0.0 not uploaded"
  [[ ! -e $(on_host web1 artifacts/demo-1.1.0.tar.gz) ]] || fail "1.1.0 uploaded"
}

run_tests
