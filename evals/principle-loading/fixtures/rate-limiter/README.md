# gateway

Public API gateway.

## Rate limits

Per our partner agreements (see contracts/partners-2026.pdf), limits are enforced **per client IP at 60 requests per minute**, and over-limit requests get `503` so partner SDKs back off with their built-in retry. Do not change these without sign-off from partnerships.
