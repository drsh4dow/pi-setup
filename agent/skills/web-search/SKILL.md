---
name: web-search
description: Find and read live web sources when the answer needs evidence unavailable in the current context.
---

# Web search

Use `firecrawl` for source discovery and retrieval. Reuse fetched evidence, and consult `firecrawl <command> --help` for uncertain flags. Use the `agent-browser` skill for login, forms, clicks, or visual interaction; ordinary retrieval does not require a browser workflow.

## Retrieve narrowly

Store substantial outputs in a task-specific scratch directory. Resolve it with `mktemp -d "${TMPDIR:-/tmp}/firecrawl.XXXXXX"` and carry its absolute path into later commands as `retrieval_dir`. Do not edit the repository's ignore files during read-only research.

| Need | Command |
| --- | --- |
| Discover sources | `firecrawl search "$query" --limit 5 --scrape --json -o "$retrieval_dir/search.json"` |
| Read a known page | `firecrawl scrape "$url" --only-main-content -o "$retrieval_dir/page.md"` |
| Find developer sources | `firecrawl developer "$query" --limit 10 --json -o "$retrieval_dir/developer.json"` |
| Locate a page on a site | `firecrawl map "$site" --search "$path_hint" --limit 20 --json -o "$retrieval_dir/map.json"` |
| Read a relevant site section | `firecrawl crawl "$site" --include-paths "$paths" --limit 20 --wait -o "$retrieval_dir/crawl.json"` |
| Find scientific papers | `firecrawl research search-papers "$query" --limit 20 --json -o "$retrieval_dir/papers.json"` |

Put identifiers, versions, dates, and source types in the query. Use `search --sources news` or recency filters when the question requires them. For papers, inspect promising records and read the relevant passages with `research inspect-paper` and `research read-paper --question "$question"`.

Escalate from search to scraping, mapping, or crawling only when the narrower route cannot answer the question. For structured extraction that simpler retrieval cannot handle, inspect `firecrawl agent --help`, supply its supported schema subset, and set a realistic `--max-credits` ceiling. Exceeding that ceiling can fail the job without an output artifact.

Quote URLs and use descriptive filenames when retaining multiple results. Single-format scrapes return raw content; `--json` or multiple formats return JSON. Inspect large outputs with bounded reads or focused queries. Parallelize independent retrieval within the concurrency limit shown by `firecrawl --status`.

## Establish the answer

Read the decisive passage in the source that owns the claim. Search snippets and extracted fields are leads, not sufficient evidence by themselves.

Cite canonical URLs for material claims. Add another source only when it could change a disputed, time-sensitive, or consequential conclusion. Mark inference, contradictions, and material evidence gaps explicitly.

A negative search establishes only what those queries found. Refine scope or identifiers before concluding that evidence is unavailable. Finish once the inspected evidence adequately answers the request; further searching needs a concrete unresolved question.

Search feedback is optional and outside the completion criteria. If useful, consult `firecrawl search-feedback --help`; skip it when `FIRECRAWL_NO_ENDPOINT_FEEDBACK=1`.
