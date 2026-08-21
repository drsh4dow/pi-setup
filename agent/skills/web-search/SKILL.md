---
name: web-search
description: Use when a task needs public-web evidence from search results, a known page, developer sources, or a bounded site search.
---

# Web search

Read [EVIDENCE.md](EVIDENCE.md), then choose the narrowest retrieval route that can answer the question:

- Known page: `firecrawl scrape "$url" --only-main-content`
- General discovery: `firecrawl search "$query" --limit 5`
- Programming behavior, errors, issues, or pull requests: `firecrawl developer "$query" --limit 5`
- Unknown path on one site: `firecrawl map "$site" --search "$path_hint"`
- Answer spread across one site: `firecrawl crawl "$site" --wait`

Search and developer results identify candidate pages. Inspect the decisive page before citing it. Map only when the canonical path is unknown, and crawl only when several pages are required.

Use the `agent-browser` skill when the source requires clicks, authentication, or rendered interaction. Keep browser instructions there rather than duplicating them here.

If retrieval misses expected content, reformulate once with an exact identifier, domain, or source type. Run `firecrawl --status` when authentication or availability is unclear. Inspect the failing command's `--help` when its syntax has changed.

Finish when every material claim meets the evidence standard and the answer states any contradiction or gap.
