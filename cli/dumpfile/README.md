# Dumpfile

Dumpfile publishes supporting evidence for pull requests and human review. A Cloudflare Worker authorizes one immutable R2 object, the CLI uploads bytes directly to R2, and the CLI prints the public URL only after a `HEAD` request verifies its metadata.

## Setup

Requirements:

- Bun
- a Cloudflare account that owns `drsh4dow.dev`
- R2 enabled on that account
- `$HOME/.local/bin` on `PATH`

Run the repeatable setup wizard:

```sh
./cli/dumpfile/setup.sh
```

The wizard creates or adopts `dumpfile-prod`, deploys `dumpfile-sign`, attaches both domains, disables `r2.dev`, installs the local command, and exercises the real upload path. It checks native R2 retention and asks for explicit approval before applying it to existing uploads. Declining leaves lifecycle rules unchanged and reports retention as unverified. It also pauses for the bucket-scoped R2 credential, response-header rule, and billing alert because those steps need a human in the Cloudflare dashboard.

The wizard stores public setup state in `~/.config/dumpfile/setup.env` and client configuration in `~/.config/dumpfile/config.env`. The client file has mode `0600` and contains:

```dotenv
DUMPFILE_API_URL=https://upload.drsh4dow.dev
DUMPFILE_R2_ACCOUNT_ID=<Cloudflare account ID>
DUMPFILE_TOKEN=<pi-local bearer token>
```

`DUMPFILE_API_URL`, `DUMPFILE_R2_ACCOUNT_ID`, and `DUMPFILE_TOKEN` environment variables override the file. `DUMPFILE_CONFIG_FILE` selects another config file. The CLI rejects a config file readable by group or other users.

## Upload

```sh
dumpfile upload ./artifacts/checkout.png
dumpfile upload ./artifacts/checkout.webm --json
```

The plain command writes progress to stderr and one verified URL to stdout. JSON mode returns the key, URL, byte count, content type, and verification status.

PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, QuickTime, MP3, M4A, Ogg, WAV, FLAC, PDF, and plain text render inline. Every other extension uploads as `application/octet-stream` with `Content-Disposition: attachment`. The single-`PUT` transport limit is 5 GiB.

Uploads are public and immutable, with a 30-day object-age retention policy once provisioned. R2 normally deletes eligible objects within another 24 hours, but deletion can take longer. Links are not permanent; keep a separate copy of evidence you need later. Inspect evidence for credentials and personal data before publishing it. Retention cannot recall downloaded copies.

## Operations

### Check or apply 30-day retention

The repository implements retention; it does not prove the production bucket has it. Worker deployment alone does not configure lifecycle rules.

Read-only configuration check, with the account ID from setup state or `wrangler whoami`:

```sh
set -o pipefail
ACCOUNT_ID=<32-character-account-id>
bunx wrangler auth token --json | bun cli/dumpfile/src/retention.ts check "$ACCOUNT_ID"
bunx wrangler r2 bucket lifecycle list dumpfile-prod
```

`check` exits zero only when the enabled `dumpfile-expire-30-days` rule matches the managed configuration. Inspect any reported other expiration rules for earlier deletion. The managed rule covers the entire bucket because existing dumpfile keys have date prefixes, not one shared upload prefix. Its native R2 condition is `Age`, `maxAge: 2592000` seconds. The upload authorization's `upload.expiresAt` still means the five-minute PUT signature deadline, not object deletion time. JSON upload output deliberately has no deletion timestamp.

Applying is a destructive policy change. Obtain the account owner's approval for **all existing and future objects in dumpfile-prod** first. Objects already older than 30 days become eligible immediately. Export or relocate evidence that must survive before approval; this command has no grandfathering mode. Removing the rule later cannot restore deleted objects.

Only after that approval:

```sh
bunx wrangler auth token --json | bun cli/dumpfile/src/retention.ts apply "$ACCOUNT_ID" --expire-existing-uploads
```

The command reads the bucket configuration, replaces only its named rule, preserves other rules including incomplete multipart cleanup, and reads back the applied configuration. Repeating it makes no write when that rule already matches. It uses Wrangler's current OAuth or API token on stdin, never writes that token to disk, and does not support global API key authentication. OAuth must have R2 permission; API tokens need Workers R2 Storage Write for apply and Read for check.

Use one operator and a lifecycle-configuration maintenance window. Cloudflare replaces the full rules array, so another dashboard, Terraform, or CLI writer between read and write can lose changes. The API has no documented conditional update here. Read-back detects a mismatching result but cannot roll back expired objects. This tool preserves unrelated rules; it does not override their earlier deadlines or bucket locks.

### Cache-policy rollout

New uploads carry signed `Cache-Control: no-store` rather than a one-year immutable cache lifetime. This prevents compliant caches from retaining new responses after origin deletion; it does not erase old cached or downloaded copies. Check Cloudflare Cache Rules for overrides. Previously uploaded objects retain their old metadata, and existing edge copies require an owner-approved cache purge if they must stop serving. Browser copies advertised as immutable for a year cannot be recalled.

Deploy the changed Worker and update the local CLI together. The current CLI checks for `no-store`; against the previous Worker it can upload successfully but then fail public metadata verification without printing a URL. The previous CLI similarly rejects new `no-store` responses. Do not repeatedly retry that version mismatch because each attempt may leave another upload. Run the setup wizard to deploy both, declining the retention approval prompt if retroactive expiration is not authorized. The wizard replaces an old proof URL when its cache header differs, without deleting the old object.

### Rotate the client token

Rerun `./cli/dumpfile/setup.sh` and choose rotation in stage 4. The wizard deploys the new digest before replacing local configuration. If setup stops after deployment but before the local write, rerun it and rotate again.

### Redeploy the Worker

The setup wizard is the supported deployment path because it supplies all secrets together. For a credential-free bundle check:

```sh
bunx wrangler deploy --dry-run --config cli/dumpfile/wrangler.jsonc
```

### Remove an object

There is no public deletion API and clients never receive delete authority. An account owner can remove a known key:

```sh
bunx wrangler r2 object delete 'dumpfile-prod/<key>' --remote
```

Deletion breaks every PR link to that object. Use it only for accidental disclosure or abuse.

### Revoke access

Delete or replace `DUMPFILE_TOKEN_SHA256` in the Worker, then remove `~/.config/dumpfile/config.env`. R2 credentials remain only in Worker secrets. Rotate the bucket-scoped credential from Cloudflare and rerun setup if those secrets may have leaked.

### Repair a missing `nosniff` header

In the `drsh4dow.dev` zone, open **Rules** and choose **Create rule**, then **Response Header Transform Rule**. Confirm Cloudflare lists it under **Response Header Transform Rules**, not **Request Header Transform Rules**. Deploy a response rule with:

- name: `Dumpfile nosniff`
- condition: Hostname equals `files.drsh4dow.dev`
- action: set static `X-Content-Type-Options` to `nosniff`

Check the live result before retrying an upload:

```sh
curl -sSI "https://files.drsh4dow.dev/__dumpfile_header_probe_$(date +%s)" \
  | grep -i '^x-content-type-options: nosniff'
```

## Verification

Credential-free checks run with the repository suite:

```sh
bun run test:dumpfile
bun run verify
```

The tests include failure-path fixture cleanup, read-only retention checks, explicit apply approval, idempotence, rule preservation, API failures, and remote configuration read-back. They also exercise authentication, request parsing, immutable key generation, SigV4 metadata binding, forced downloads, PUT retry, public verification, file permissions, size rejection, and secret redaction. The wizard's last stage proves the deployed path with a real PNG upload and byte-for-byte public fetch.

### Rerunnable operational demonstration

After an authorized Worker rollout, record these steps with an approved local image or video. These commands perform a real upload, not a simulated 30-day wait:

```sh
set -o pipefail
bunx wrangler auth token --json | bun cli/dumpfile/src/retention.ts check "$ACCOUNT_ID"
# A nonzero check means retention is not verified. Record that limitation.
dumpfile upload ./artifacts/demo.png --json
# Copy the returned URL, then inspect headers and compare bytes.
URL=<returned-public-url>
curl -fsSI "$URL"
FETCHED=$(mktemp)
trap 'rm -f "$FETCHED"' EXIT
curl -fsS "$URL" > "$FETCHED"
cmp ./artifacts/demo.png "$FETCHED"
```

Show `Content-Type`, `Content-Disposition`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`, then open the public URL in a browser. Keep auth-token command output piped and credentials out of the recording. Label local retention tests as simulated API checks. A matching production configuration verifies the policy, not the passage of 30 days or exact deletion timing. No production retention application or verification was performed as part of implementation.
