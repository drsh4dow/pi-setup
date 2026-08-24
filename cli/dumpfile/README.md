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

The wizard creates or adopts `dumpfile-prod`, deploys `dumpfile-sign`, attaches both domains, disables `r2.dev`, installs the local command, and exercises the real upload path. It pauses for the bucket-scoped R2 credential, response-header rule, and billing alert because those steps need a human in the Cloudflare dashboard.

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

Uploads are public, immutable, and retained indefinitely. Inspect evidence for credentials and personal data before publishing it.

## Operations

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

The tests exercise authentication, request parsing, immutable key generation, SigV4 metadata binding, forced downloads, PUT retry, public verification, file permissions, size rejection, and secret redaction. The wizard's last stage proves the deployed path with a real PNG upload and byte-for-byte public fetch.
