---
name: web-search
description: Search and extract current public web content with Firecrawl. Use for web discovery, reading a known URL, developer documentation or GitHub history, scientific papers, or bounded site mapping and crawling. Use agent-browser instead when the task needs clicks, forms, login, or visual inspection.
---

# Web search

Use the `firecrawl` CLI. Consult `firecrawl <command> --help` for current options rather than relying on remembered syntax.

## Route the request

- General discovery: `firecrawl search "<query>" --limit 5`
- Search and read the results in one call: add `--scrape`
- Known public URL: `firecrawl scrape "<url>" --only-main-content`
- Programming question, API contract, documentation, or GitHub issue/PR history: `firecrawl developer "<query>"`
- Scientific literature: start with `firecrawl research search-papers "<query>"`; inspect and read promising paper IDs with the corresponding `research` subcommands
- URLs on one site: `firecrawl map "<url>" --limit <n>`
- Content from several pages on one site: `firecrawl crawl "<url>" --wait --limit <n> --max-depth <n>`

Start with the narrowest route. Map before crawling when the relevant paths are unknown, and always bound search, map, and crawl calls.

## Evidence workflow

1. Search with a specific query and a small result limit.
2. Prefer primary sources; scrape the promising URLs rather than treating snippets as evidence.
3. Reformulate the query when results are weak instead of increasing the limit blindly.
4. Preserve exact source URLs in the answer or artifact so each material claim is traceable.
5. Use multiple independent sources when the claim is disputed, consequential, or time-sensitive.

For large output, write to a task-specific file with `--output` and read only the relevant sections. Keep transient output outside the repository unless it is part of the requested deliverable.

## Recovery

Run `firecrawl --status` when availability or authentication is unclear. If a request fails, inspect the error and command help; use `firecrawl doctor <job-id>` when a failed run provides a job ID. Switch to `agent-browser` when extraction cannot expose state that requires browser interaction.
