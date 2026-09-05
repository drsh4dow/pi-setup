# Cloudflare dumpfile app

Research date: 2026-08-21. Retention and provisioning sources rechecked 2026-09-05 for audit #19. Primary sources only.

## Decision context

The app needs one private operation and one public operation. An authenticated agent asks for permission to upload one object. Anyone can then read that object at a stable URL. Large object bytes should travel from the agent to R2, not through a Worker.

The recommended first version is an authenticated Worker that generates a random object key and a short-lived presigned R2 `PutObject` URL. The agent uploads directly to R2 and prints the corresponding custom-domain URL. This separates upload authorization from public delivery and keeps the Worker below Cloudflare's request-body limits.

## Current Cloudflare facts

### Public R2 delivery

R2 can expose a bucket through a custom domain or a Cloudflare-managed `r2.dev` hostname. The two settings are independent. Cloudflare calls `r2.dev` a non-production option and reserves custom domains for production features such as cache, WAF rules, access controls, and URL-level analytics ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)). The `r2.dev` endpoint has variable request and bandwidth throttling. Cloudflare says throttling can begin at hundreds of requests per second and recommends a custom domain for production use ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/#rate-limiting-on-managed-public-buckets-through-r2dev)).

Use `files.example.com` as the public custom domain. Keep `r2.dev` disabled after initial setup. A custom domain must belong to a zone in the same Cloudflare account as the bucket ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains)). Custom-domain delivery can use Cloudflare Cache, while direct `r2.dev` delivery cannot use the same cache, WAF, or analytics controls ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)). R2 has no Internet egress charge for either Standard or Infrequent Access storage ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Cache hits can reduce R2 Class B reads, but the current no-store policy forgoes that saving for new uploads. Cached data can briefly lag a replaced object ([how R2 works](https://developers.cloudflare.com/r2/how-r2-works/#read-path)). Immutable keys avoid that replacement problem.

R2 is strongly consistent. Cloudflare commits object metadata before returning upload success, after which subsequent reads see the object ([how R2 works](https://developers.cloudflare.com/r2/how-r2-works/#write-path)). This permits the CLI to verify the public URL immediately after a successful upload.

### Presigned uploads

An R2 presigned URL authorizes exactly one S3 operation against one bucket and key for an expiry between 1 second and 7 days. Supported operations are `GET`, `HEAD`, `PUT`, and `DELETE`; HTML-form `POST` uploads are not supported ([presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). Presigned URLs work only on the R2 S3 API hostname, `<ACCOUNT_ID>.r2.cloudflarestorage.com`, not on a custom domain ([presigned URL restrictions](https://developers.cloudflare.com/r2/api/s3/presigned-urls/#presigned-url-alternative-with-workers)). The upload URL and the final public URL therefore have different hosts.

Cloudflare describes a presigned URL as a bearer token. Anyone who obtains it can perform its signed operation until expiry ([presigned URL security](https://developers.cloudflare.com/r2/api/s3/presigned-urls/#security-considerations)). A signer can bind `Content-Type` into the signature, causing a request with another value to fail, but this validates the header rather than inspecting the bytes ([presigned URL security](https://developers.cloudflare.com/r2/api/s3/presigned-urls/#security-considerations)).

Browser uploads need an R2 CORS policy even when the URL is presigned. Command-line uploads do not. CORS must allow the upload origin, `PUT`, and every signed or transmitted header ([R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-presigned-url)). The proposed CLI does not need CORS, so version one should configure no bucket CORS policy. Add an exact-origin policy later only if a browser client is approved.

### Object and request limits

R2 supports objects up to 5 TiB. A single-part upload is limited to 5 GiB. Multipart upload supports up to 4.995 TiB and 10,000 parts ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/)). Cloudflare recommends single `PUT` for small and medium files and multipart for large files or resumability; its current guide uses about 100 MB as the practical dividing line, although the hard single-part limit remains 5 GiB ([upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/)). Incomplete multipart uploads expire after seven days by default ([object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).

A request entering a Worker is limited to 100 MB on Free and Pro zones, 200 MB on Business, and 500 MB by default on Enterprise ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#request-limits)). Passing video bytes through a Worker would therefore reject files that R2 can accept directly. It also adds a needless data hop.

Version one should accept files up to 5 GiB through one presigned `PUT`. Multipart support can follow when actual recordings exceed that limit or unreliable links make resumability necessary. Multipart signing requires create, part upload, completion, and abort operations, so adding it before observed need would enlarge both the API and failure states.

### Metadata, content type, and cache

R2's S3 API accepts `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, and `Expires` as `PutObject` system metadata ([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/#object-level-operations)). Object metadata is limited to 8,192 bytes and keys to 1,024 bytes ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/)). The signer should bind the chosen content type and cache control into the presigned request. The public custom domain then returns stored object metadata.

Use `Cache-Control: no-store`. This avoids advertising a cache lifetime beyond origin retention. Keys still never change. Do not store the local filename. Version one should allow `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`, and `video/quicktime`. Reject HTML, SVG, XML, JavaScript, and unknown types. SVG and HTML can execute active content in a browser, and a client-provided MIME header does not prove file contents. Host files on a dedicated cookieless subdomain that is not a parent of an authenticated application. Add `X-Content-Type-Options: nosniff` with a custom-domain response header rule before launch.

## Approach comparison

### Long-lived R2 S3 credentials in every agent

Each agent could use an S3-compatible CLI with an R2 access key and secret. This is the least server code, and standard S3 clients can automatically use multipart upload ([upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/#s3-sdk)). R2 API tokens can be scoped to object read/write for selected buckets ([R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)).

It loses on authority. Object write credentials also permit calls other than a single generated-key upload, including overwriting arbitrary known keys and using multipart operations. Distributing a durable R2 secret to every autonomous environment increases the chance and effect of leakage. Rotation becomes a fleet operation. There is no central place to enforce media type, size, key format, or per-agent policy. Do not choose this approach.

### Upload bytes through a Worker with an R2 binding

A Worker can receive a request and write its body through an R2 binding. This centralizes authentication and validation, and Cloudflare exposes `put`, `get`, `head`, `delete`, `list`, and multipart methods through the Workers API ([Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).

It fails the large-video requirement. The inbound request is subject to the zone's 100 MB to 500 MB Worker body limit ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#request-limits)). Streaming does not remove that ingress limit. It also routes every byte through compute that only needs to authorize metadata. Do not choose this approach.

### Authenticated signing endpoint, then direct R2 upload

The Worker authenticates a small JSON request, chooses the key and metadata, and returns a short-lived presigned `PUT`. The agent sends bytes directly to the R2 S3 endpoint. Cloudflare's first-party upload guide recommends this pattern for client-side direct uploads because it avoids exposing API credentials to the client ([upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/#presigned-urls)).

This wins because the agent receives authority for one operation on one unpredictable key for minutes, not bucket-wide durable authority. The Worker enforces policy without carrying file bytes. The public URL is known before upload and remains independent of the expiring upload URL. Its one meaningful version-one limitation is the 5 GiB single-part ceiling.

## Threat model and controls

Public reads are intentional. The risks are unauthorized writes, harmful content, cost abuse, accidental mutation, and broken PR links.

| Threat                         | Version-one control                                                                                                                                                                                                                              | Residual issue or later control                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent upload secret leaks      | Store the bearer token in the agent's secret store, never in shell history, command arguments, logs, or PR text. Store only SHA-256 digests of 32-byte random tokens in Worker secrets, each labeled by a non-secret token ID. Support rotation. | A leaked token can request uploads until revoked. Move to separately revocable per-agent credentials when the fleet grows.                                                                                                         |
| Presigned URL leaks            | Five-minute expiry, `PUT` only, one generated key, signed content type and cache control. Redact query strings from logs.                                                                                                                        | The holder can upload or replace that one key during the five-minute window. A one-time issuance store can close this later.                                                                                                       |
| Caller chooses a dangerous key | The server generates the full key. The request schema has no key field. Use 16 random bytes encoded as 32 lowercase hex characters.                                                                                                              | None expected if randomness comes from `crypto.getRandomValues`.                                                                                                                                                                   |
| Overwrite, delete, or list     | The public endpoint exposes reads only. The signer never signs `DELETE`, `GET`, `HEAD`, list, or caller-selected keys. Its R2 credential stays only in Worker secrets.                                                                           | The signing credential remains high value. Scope it to the one bucket and rotate it on suspected exposure.                                                                                                                         |
| Content-type spoofing          | Allowlist types, sign `Content-Type`, isolate the public hostname, set `nosniff`, and reject active formats.                                                                                                                                     | Header checks do not inspect bytes. Add magic-byte inspection in a post-upload scanner only if abuse appears. Scanning requires quarantine or a publish step.                                                                      |
| Storage or request cost abuse  | Authentication, 5 GiB declared-size cap, short signing expiry, a Workers Rate Limiting binding keyed by token ID, billing alerts, and daily review of bytes and operations.                                                                      | `PutObject` does not make a declaration of size trustworthy by itself, and Workers rate limits are not exact global accounting. Enforce an R2/account budget operationally; add upload records and post-upload deletion if needed. |
| Abandoned data                 | Expire completed objects after 30 days of object age using native R2 lifecycle. Preserve incomplete multipart cleanup.                                                                                      | Old PR links will break. Obtain explicit approval before applying the policy retroactively; keep needed evidence elsewhere.                                                                       |
| Broken GitHub links            | Stable custom domain, immutable random keys, no overwrite, and infrastructure under an owner-controlled zone.                                                                                                     | Routine lifecycle expiry after 30 days of object age, domain loss, account deletion, or manual object deletion breaks links. Back up needed evidence or accept this operational risk.                                                                                                   |
| Secrets in observability       | Log token ID, key, size, type, outcome, and latency. Never log `Authorization`, S3 credentials, or presigned query strings.                                                                                                                      | Cloudflare request logs may include URLs. The signing route itself carries no secret in its URL.                                                                                                                                   |

The signing endpoint should reject malformed JSON, size outside 1 byte through 5 GiB, and content types outside the allowlist. These are boundary checks, not malware detection. Rate limiting is a launch blocker. A dashboard or deletion UI is not.

## Smallest sensible first version

### Cloudflare resources and names

Create:

- one Standard-class R2 bucket, `dumpfile-prod`;
- one public custom domain, `files.example.com`, attached directly to the bucket;
- one Worker, `dumpfile-sign`, at `upload.example.com/v1/*`;
- one bucket-scoped R2 access key held only as encrypted Worker secrets for SigV4 signing;
- one or more upload bearer tokens stored as Worker secrets, with a non-secret token ID for logs;
- one Response Header Transform Rule for `X-Content-Type-Options: nosniff` on `files.example.com` ([response header rules](https://developers.cloudflare.com/rules/transform/response-header-modification/));
- one Workers Rate Limiting binding for `POST /v1/uploads`, keyed by the authenticated token ID ([rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).

Keep upload and public delivery on separate hostnames. Do not route public `GET` requests through the Worker or build a public list endpoint. Keep the custom-domain bucket public and `r2.dev` disabled.

### API contract

`POST https://upload.example.com/v1/uploads`

Headers:

```http
Authorization: Bearer <agent-upload-token>
Content-Type: application/json
```

Request:

```json
{
  "size": 183742991,
  "contentType": "video/mp4"
}
```

Response, `201 Created`:

```json
{
  "key": "2026/08/21/9f40cc8f0f2d4f39a77540d5a336ae1c.mp4",
  "publicUrl": "https://files.example.com/2026/08/21/9f40cc8f0f2d4f39a77540d5a336ae1c.mp4",
  "upload": {
    "method": "PUT",
    "url": "https://<account>.r2.cloudflarestorage.com/dumpfile-prod/...?...",
    "headers": {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store"
    },
    "expiresAt": "2026-08-21T12:05:00Z"
  }
}
```

Use [RFC 9457 problem details](https://www.rfc-editor.org/rfc/rfc9457.html) for `400`, `401`, `413`, `415`, and `429` errors. Never echo a token or signed URL in an error.

Generate keys as `YYYY/MM/DD/<32-lowercase-hex-characters>.<server-mapped-extension>`, using 16 bytes from `crypto.getRandomValues`. The date prefix helps operational inspection. Randomness prevents guessing and makes collisions negligible. The server maps MIME type to extension. The local filename never crosses the signing API boundary.

### Upload sequence and CLI

The command should be one noninteractive operation:

```sh
dumpfile upload ./checkout-flow.mp4
# https://files.example.com/2026/08/21/9f40cc8f0f2d4f39a77540d5a336ae1c.mp4
```

The CLI reads `DUMPFILE_TOKEN` and `DUMPFILE_API_URL` from environment or a mode-0600 config file. It determines MIME type from a small extension allowlist, reads file size, requests a signed upload, performs `PUT` with the exact returned headers, then sends `HEAD` to `publicUrl`. It prints only the final URL to stdout. Progress and errors go to stderr. `--json` may return key, URL, bytes, type, and verification status for agent tooling. Do not accept a token flag because process listings and shell history can expose it.

On `PUT` failure, the CLI may request one fresh URL and retry once. On public `HEAD` failure, it should retry with bounded backoff for network errors, then fail without printing a success URL. R2's strong consistency means repeated not-found responses indicate a real upload or URL problem rather than expected propagation ([how R2 works](https://developers.cloudflare.com/r2/how-r2-works/#write-path)).

No CORS policy is needed for this CLI. No database, queue, upload-complete endpoint, deletion endpoint, web UI, malware scanner, or multipart coordinator belongs in version one.

### Retention and observability

Audit #19 changes the retention decision to native R2 expiration after 30 days of object age. Keep the default seven-day incomplete multipart cleanup and all unrelated lifecycle rules. [Cloudflare's lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) says actions typically execute within 24 hours of eligibility; processing existing objects can take longer. This is not an exact deletion deadline or a promise that downloaded copies disappear.

The implementation uses the [R2 lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/) through `cli/dumpfile/src/retention.ts`, with an enabled rule named `dumpfile-expire-30-days`, empty prefix, and `deleteObjectsTransition.condition` of `{ "type": "Age", "maxAge": 2592000 }`. The [Wrangler lifecycle commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/#r2-bucket-lifecycle-set) document full-configuration replacement. Installed Wrangler 4.125.0 confirms the age is seconds and uses this REST representation. Reading and merging before writing preserves unrelated rules; a second read verifies the result. Run one configuration writer at a time because replacement is not an atomic merge.

[Wrangler auth token --json](https://developers.cloudflare.com/changelog/2025-12-18-wrangler-auth-token/) supplies the current OAuth or API token over stdin. The setup wizard performs a read-only check and requires an exact typed approval before applying expiration to existing uploads. The standalone apply command requires `--expire-existing-uploads`. All existing bucket objects are in scope, including ones already older than 30 days. No production rule was applied or checked during implementation. See [operations and demonstration commands](../../cli/dumpfile/README.md#check-or-apply-30-day-retention).

New uploads use `Cache-Control: no-store`; a one-year immutable lifetime would allow stale public responses long after origin expiration. Cloudflare [default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) respects `no-store` unless cache configuration overrides it. Existing objects retain legacy metadata and previously cached or downloaded copies are not recalled by R2 deletion. Check cache overrides and obtain separate approval for any edge purge. Deploy the Worker and CLI together because both versions verify their own cache policy. Keep `upload.expiresAt` as the signing deadline; do not add an exact object-deletion timestamp.

Emit structured Worker logs for signing decisions: timestamp, token ID, generated key, declared bytes, content type, status, and request ID. Enable Worker Logs with short retention appropriate to the account, and create alerts for authentication failures, rate-limit events, Worker errors, R2 storage growth, and spend. Cloudflare caps log data emitted by one Worker invocation at 256 KB, which is ample for one compact event ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#log-size)).

## Cost model

Cloudflare currently prices R2 Standard storage at $0.015 per GB-month, Class A operations at $4.50 per million, and Class B operations at $0.36 per million. The monthly free tier includes 10 GB-month, 1 million Class A operations, and 10 million Class B operations. Internet egress is free ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Each single-part upload is one Class A `PutObject`; each uncached `HEAD` or `GET` is a Class B operation ([R2 operation classes](https://developers.cloudflare.com/r2/pricing/#class-a-operations)).

For updateable estimates, let:

- `S` be average stored GB during the month;
- `U` be single-part uploads;
- `R` be uncached R2 reads and heads.

Ignoring taxes and account-specific contracts:

```text
R2 monthly cost = max(S - 10, 0) * $0.015
                + max(U - 1,000,000, 0) / 1,000,000 * $4.50
                + max(R - 10,000,000, 0) / 1,000,000 * $0.36
```

Example A assumes 100 uploads of 200 MB retained for the full month and 10,000 uncached reads. Stored data is about 20 GB. R2 cost is about `(20 - 10) * $0.015 = $0.15`; operations remain in the free tier. Example B assumes 1,000 uploads of 500 MB retained for the full month and 1 million uncached reads. Stored data is about 500 GB. R2 cost is about `(500 - 10) * $0.015 = $7.35`; operations remain in the free tier. Custom-domain Internet delivery adds no R2 egress charge under the published pricing ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

Workers Free includes 100,000 requests per day with 10 ms CPU per invocation. Workers Paid has a $5 monthly minimum, includes 10 million requests and 30 million CPU milliseconds per month, then charges $0.30 per million requests and $0.02 per million CPU milliseconds ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers)). A low-volume signer can fit the Free request allowance, but measure SigV4 signing and rate-limit calls against the CPU allowance. Budget $5 per month if the account needs Workers Paid. At 100,000 uploads per month, one signing request per upload remains inside the Paid included request allowance.

Multipart changes the Class A formula. Each create, uploaded part, and completion is a Class A operation ([R2 pricing](https://developers.cloudflare.com/r2/pricing/#class-a-operations)). Cache-hit pricing and WAF product charges depend on the owner's existing Cloudflare plan and ruleset. Confirm them in the account before launch rather than assuming they are free.

## Implementation phases and proof

### Phase 0: owner choices and account setup

Recommended defaults are `files.example.com`, `upload.example.com`, 30-day object-age expiration, a 5 GiB declared-size maximum, five-minute signatures, the MIME allowlist above, and one token per independently revocable agent environment. The owner must supply the zone, explicitly approve retroactive expiration of existing artifacts, choose the initial agents, and set a monthly spend alert. Implement the defaults, but keep retroactive expiration behind explicit approval.

Create the bucket, custom domain, scoped R2 credentials, Worker route, secrets, response-header rule, and Workers Rate Limiting binding as infrastructure configuration. Record recovery ownership for the domain and Cloudflare account.

Verification:

1. Upload a harmless fixture through the dashboard, fetch it from the custom domain, and confirm `r2.dev` is disabled.
2. Confirm an unknown key returns not found and no bucket index is exposed.
3. Confirm the response has the expected `Content-Type`, no-store cache policy, and `X-Content-Type-Options: nosniff`.

### Phase 1: signer

Implement strict request parsing, token authentication, generated keys, MIME and size policy, SigV4 presigning, and redacted structured logs. Unit-test the schema and key generator. Test that every error omits credentials and signed query strings.

End-to-end proof:

1. Request a signature with a valid token, upload a file larger than 100 MB directly to the returned R2 URL, and fetch the public URL. This proves bytes bypass the Worker ingress path.
2. Repeat with PNG, JPEG, WebP, GIF, MP4, WebM, and QuickTime fixtures. Verify bytes, length, type, cache header, and `nosniff` at the public URL.
3. Try no token, a wrong token, zero bytes, more than 5 GiB declared size, HTML, SVG, unknown MIME, and malformed JSON. Confirm the documented status codes.
4. Change a signed `Content-Type`, key, method, and cache header. Confirm R2 rejects each modified request.
5. Wait past expiry and confirm the upload URL returns `403 ExpiredRequest`, as documented by Cloudflare ([R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-presigned-url)).
6. Confirm public `GET` and `HEAD` work without authentication, while no public write, delete, or list path exists.

### Phase 2: agent CLI

Implement the single command, exact-header upload, retry policy, public `HEAD` verification, stdout contract, stderr progress, and JSON mode. Test paths with spaces and filenames containing Unicode or shell metacharacters. Confirm the token never appears in process arguments or normal logs.

Run the real flow from the same kind of autonomous agent environment used for coding work. Upload a screen recording, paste the printed URL into a test GitHub PR comment, open it in a logged-out browser, and seek through the video. Re-run from a second agent token and verify logs distinguish the token IDs.

### Phase 3: launch controls

Exercise the rate limit, token revocation, R2 credential rotation, spend alert, and manual object removal runbook. Inspect Worker logs and Cloudflare analytics for the test uploads. Verify that log exports contain neither bearer tokens nor signed URL query strings. Only then use links in PRs, with needed evidence backed up elsewhere before lifecycle expiry.

### Later, only after measured need

Add multipart direct upload when files exceed 5 GiB or upload reliability is poor. Add per-agent issuance records and one-time completion if presigned URL replay causes a real problem. Add magic-byte inspection, quarantine, abuse reporting, richer analytics, or administrative deletion only when observed usage justifies their state and operating cost.

## Launch blockers

The launch blockers are a custom public domain, direct-to-R2 upload, authenticated signing, generated immutable keys, a strict media allowlist, active-content rejection, `nosniff`, a 5 GiB declared-size cap, five-minute signatures, rate limiting, secret redaction, explicitly approved native 30-day object-age expiration, spend alerts, and the end-to-end checks above.

Multipart upload, browser CORS, a web UI, malware scanning, a database, self-service deletion, and content deduplication can wait.

## Recommended decision

Build a small authenticated Worker that returns a five-minute presigned R2 `PUT` for a server-generated immutable key. Upload bytes directly to R2, serve them publicly from `files.example.com`, and have the CLI print that stable URL only after a public `HEAD` succeeds. Launch with single-part files up to 5 GiB, 30-day object-age expiration, no browser CORS, strict media types, isolated public hosting, rate limits, and spend alerts. Do not distribute R2 credentials to agents and do not proxy file bytes through the Worker.
