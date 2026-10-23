# shellcheck shell=bash
# Config: KEY=VALUE lines in shipit.conf, found in the current directory or at
# $SHIPIT_CONFIG. The file is parsed, never sourced. The directory holding it is the
# project: VERSION, the build output, dist/, and hosts/ live beside it.

# Every key shipit reads, with its default. README.md documents each one.
declare -gA CONFIG_DEFAULTS=(
  [app]=""
  [build_cmd]=""
  [build_dir]="build"
  [deploy_root]="/srv/app"
  [keep]="5"
  [ssh_user]=""
  [store_url]=""
)

declare -gA CONFIG=()

config_file() {
  printf '%s\n' "${SHIPIT_CONFIG:-$PWD/shipit.conf}"
}

project_dir() {
  dirname "$(config_file)"
}

# load_config FILE — reads FILE into CONFIG and validates it. Blank lines and lines
# starting with # are skipped; anything else must be KEY=VALUE with a known KEY.
load_config() {
  local file=$1 line key n=0
  [[ -f $file ]] || die "$E_CONFIG" "no config at $file"
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    if [[ $line =~ ^[[:space:]]*(#|$) ]]; then
      continue
    fi
    [[ $line =~ ^([a-z_]+)=(.*)$ ]] || die "$E_CONFIG" "$file:$n: expected KEY=VALUE"
    key=${BASH_REMATCH[1]}
    [[ -v CONFIG_DEFAULTS[$key] ]] || die "$E_CONFIG" "$file:$n: unknown key '$key'"
    CONFIG[$key]=${BASH_REMATCH[2]}
  done <"$file"
  validate_config
}

# config_get KEY — the configured value of KEY, or its default.
config_get() {
  local key=$1
  [[ -v CONFIG_DEFAULTS[$key] ]] || die "$E_CONFIG" "unknown config key '$key'"
  if [[ -v CONFIG[$key] ]]; then
    printf '%s\n' "${CONFIG[$key]}"
  else
    printf '%s\n' "${CONFIG_DEFAULTS[$key]}"
  fi
}

validate_config() {
  local app keep root
  app=$(config_get app)
  keep=$(config_get keep)
  root=$(config_get deploy_root)
  [[ $app =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "$E_CONFIG" "config: app must be a lowercase name, got '$app'"
  [[ $keep =~ ^[1-9][0-9]*$ ]] || die "$E_CONFIG" "config: keep must be a positive integer, got '$keep'"
  [[ $root =~ ^/[A-Za-z0-9._/-]+$ ]] || die "$E_CONFIG" "config: deploy_root must be an absolute path, got '$root'"
}
