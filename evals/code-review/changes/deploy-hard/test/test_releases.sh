#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_releases_lists_each_host_newest_first() {
  setup_project staging web2 web1
  build_version 1.0.0
  deploy_at 20240101000000 staging
  build_version 1.1.0
  deploy_at 20240102000000 staging
  shipit_ok releases staging
  assert_eq "web2 20240102000000 1.1.0 current
web2 20240101000000 1.0.0 -
web1 20240102000000 1.1.0 current
web1 20240101000000 1.0.0 -" "$OUT" "releases"
}

test_releases_marks_a_rolled_back_host() {
  setup_project staging web1
  build_version 1.0.0
  deploy_at 20240101000000 staging
  deploy_at 20240102000000 staging
  shipit_ok rollback staging
  shipit_ok releases staging
  assert_eq "web1 20240102000000 1.0.0 -
web1 20240101000000 1.0.0 current" "$OUT" "releases"
}

test_releases_without_a_recorded_version() {
  setup_project staging web1
  build_version 1.0.0
  deploy_at 20240101000000 staging
  rm "$(on_host web1 releases/20240101000000/.shipit-release)"
  shipit_ok releases staging
  assert_eq "web1 20240101000000 - current" "$OUT" "releases"
}

test_releases_of_a_fresh_host_is_empty() {
  setup_project staging web1
  shipit_ok releases staging
  assert_eq "" "$OUT" "releases"
}

run_tests
