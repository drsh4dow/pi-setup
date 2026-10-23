# shellcheck shell=bash
# The artifact store: an HTTP endpoint at store_url that takes PUTs, authenticated with
# the bearer token in SHIPIT_STORE_TOKEN.

SHIPIT_RETRY_DELAY=${SHIPIT_RETRY_DELAY:-2}

# cmd_upload [ARTIFACT] — uploads ARTIFACT (default: the newest in dist/) and its
# checksum to STORE_URL/APP/.
cmd_upload() {
  (( $# <= 1 )) || die "$E_USAGE" "usage: shipit upload [ARTIFACT]"
  local url token artifact app file
  url=$(config_get store_url)
  [[ -n $url ]] || die "$E_CONFIG" "config: store_url is not set"
  token=${SHIPIT_STORE_TOKEN:-}
  [[ -n $token ]] || die "$E_CONFIG" "SHIPIT_STORE_TOKEN is not set"
  app=$(config_get app)
  artifact=$(resolve_artifact "${1:-}")
  for file in "$artifact" "$artifact.sha256"; do
    retry 3 "$SHIPIT_RETRY_DELAY" run curl -fsS -T "$file" \
      -H "Authorization: Bearer $token" "${url%/}/$app/$(basename "$file")" ||
      die "$E_STEP" "upload of $(basename "$file") failed"
  done
  log_info "uploaded $(basename "$artifact") to ${url%/}/$app/"
}
