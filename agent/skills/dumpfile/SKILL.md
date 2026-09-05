---
name: dumpfile
description: Use when an asset must be served online through a public URL, such as media attached to a pull request or other supporting evidence.
---

# Dumpfile

Run `dumpfile upload <path>` to upload an asset to R2. The command prints a read-only public URL for sharing videos, images, and other files.

Uploads are public and subject to 30-day object-age retention once the bucket policy is provisioned. R2 deletes asynchronously, usually within 24 hours after eligibility; links are not permanent. Only upload things permitted to be shared, and keep a separate copy of evidence needed later. Expiration cannot recall downloaded copies.

For setup, retention configuration checks, or a cache-header mismatch after upload, read `cli/dumpfile/README.md` in the pi-setup repository. Do not claim retention is deployed from a successful upload alone. Applying retention to existing uploads requires explicit owner approval.
