#!/usr/bin/env bash
# shellcheck source=test/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# deploy_baseline ENV — deploys 1.0.0 as release 20240101000000, then builds 1.1.0 for
# the deploy under test.
deploy_baseline() {
  build_version 1.0.0
  deploy_at 20240101000000 "$1"
  assert_status 0
  build_version 1.1.0
}

test_batches_go_out_in_inventory_order() {
  setup_project staging web1 web2 web3
  enable_health_check
  build_version 1.0.0
  deploy_at 20240101000000 staging --batch-size 2
  assert_status 0
  assert_contains "$ERR" "batch 1 of 2: web1 web2"
  assert_contains "$ERR" "batch 2 of 2: web3"
  assert_eq "activate web1
activate web2
health web1
health web2
activate web3
health web3" "$(host_events)" "order of activations and health checks"
}

test_batch_size_comes_from_config() {
  setup_project staging web1 web2 web3 web4
  set_config batch_size 2
  build_version 1.0.0
  deploy_at 20240101000000 staging
  assert_status 0
  assert_contains "$ERR" "batch 2 of 2: web3 web4"
}

test_batch_size_must_be_positive() {
  setup_project staging web1
  build_version 1.0.0
  deploy_at 20240101000000 staging --batch-size 0
  assert_status 2
  assert_eq none "$(current_of web1)" "web1 current"
}

test_healthy_deploy_activates_every_host() {
  setup_project staging web1 web2 web3
  enable_health_check
  deploy_baseline staging
  deploy_at 20240102000000 staging --batch-size 2
  assert_status 0
  local host
  for host in web1 web2 web3; do
    assert_eq 20240102000000 "$(current_of "$host")" "$host current"
  done
}

test_health_check_is_retried() {
  setup_project staging web1
  set_config health_cmd 'test -e /srv/demo/warm || { touch /srv/demo/warm; exit 1; }'
  set_config health_attempts 3
  set_config health_interval 0
  build_version 1.0.0
  deploy_at 20240101000000 staging
  assert_status 0
  assert_contains "$ERR" "not healthy yet (attempt 1 of 3)"
  assert_contains "$ERR" "web1: healthy"
}

test_health_failure_leaves_later_batches_untouched() {
  setup_project staging web1 web2 web3
  enable_health_check
  deploy_baseline staging
  make_unhealthy web1
  deploy_at 20240102000000 staging --batch-size 1
  assert_status 5
  assert_contains "$ERR" "web1: health check failed; rolling back 1 host(s)"
  assert_eq 20240101000000 "$(current_of web1)" "web1 current"
  assert_eq 20240101000000 "$(releases_of web2)" "web2 releases"
  assert_eq 20240101000000 "$(releases_of web3)" "web3 releases"
}

test_health_failure_rolls_back_earlier_batches() {
  setup_project staging web1 web2 web3 web4
  enable_health_check
  deploy_baseline staging
  make_unhealthy web3
  deploy_at 20240102000000 staging --batch-size 3
  assert_status 5
  assert_contains "$ERR" "web3: health check failed"
  local host
  for host in web1 web2 web3 web4; do
    assert_eq 20240101000000 "$(current_of "$host")" "$host current"
  done
}

test_rolled_back_deploy_prunes_nothing() {
  setup_project staging web1
  set_config keep 2
  enable_health_check
  deploy_baseline staging
  deploy_at 20240102000000 staging
  assert_status 0
  make_unhealthy web1
  deploy_at 20240103000000 staging
  assert_status 5
  assert_eq "20240101000000 20240102000000 20240103000000" "$(releases_of web1)" "web1 releases"
  rm "$STUB_HOSTS/web1/srv/unhealthy"
  deploy_at 20240104000000 staging
  assert_status 0
  assert_eq "20240103000000 20240104000000" "$(releases_of web1)" "web1 releases"
}

run_tests
