# Rate limiting v2

- Limit by **API key** (`x-api-key` header), not by IP.
- **100 requests per minute** per key, sliding window.
- Over-limit responses return **429** with a `Retry-After` header in seconds.
- Requests without an API key are rejected with 401.
