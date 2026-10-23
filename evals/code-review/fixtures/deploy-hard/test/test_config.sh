#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_unknown_key_is_rejected() {
  setup_project staging web1
  set_config colour blue
  shipit build
  assert_status 3
  assert_contains "$ERR" "unknown key 'colour'"
}

test_malformed_line_is_rejected() {
  setup_project staging web1
  printf 'keep 4\n' >>"$PROJECT/shipit.conf"
  shipit build
  assert_status 3
  assert_contains "$ERR" "expected KEY=VALUE"
}

test_keep_must_be_a_positive_integer() {
  setup_project staging web1
  set_config keep 0
  shipit build
  assert_status 3
  assert_contains "$ERR" "keep must be a positive integer"
}

test_missing_config_is_reported() {
  setup_project staging web1
  rm "$PROJECT/shipit.conf"
  shipit build
  assert_status 3
  assert_contains "$ERR" "no config at"
}

test_deploy_root_defaults_to_srv_app() {
  setup_project staging web1
  grep -v '^deploy_root=' "$PROJECT/shipit.conf" >"$PROJECT/conf.new"
  mv "$PROJECT/conf.new" "$PROJECT/shipit.conf"
  build_version 1.0.0
  deploy_at 20240101000000 staging
  assert_status 0
  [[ -L $STUB_HOSTS/web1/srv/app/current ]] || fail "no current link under /srv/app"
}

test_help_lists_every_command() {
  setup_project staging web1
  shipit_ok help
  local command
  for command in build upload deploy rollback releases; do
    assert_contains "$OUT" "  $command "
  done
}

test_unknown_command_is_a_usage_error() {
  setup_project staging web1
  shipit launch
  assert_status 2
}

run_tests
