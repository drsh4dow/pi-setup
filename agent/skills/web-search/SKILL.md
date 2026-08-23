---
name: web-search
description: Use to Search, scrape, and interact with the web.
---

# Web search

Use `firecrawl` for live web retrieval. Use `firecrawl <command> --help` when a flag is unclear.

## Pick the narrowest route

| Need                                                  | Start with                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Discover sources or answer a general question         | `firecrawl search "$query" --limit 5 --scrape --json -o .firecrawl/search-{topic}.json`                                            |
| Read a known page                                     | `firecrawl scrape "$url" --only-main-content -o .firecrawl/{site}-{page}.md`                                                       |
| Search issues, merged PRs, READMEs, or developer docs | `firecrawl developer "$query" --limit 10 --json -o .firecrawl/developer-{topic}.json`                                              |
| Find scientific papers                                | `firecrawl research search-papers "$query" --limit 20 --json -o .firecrawl/papers-{topic}.json`                                    |
| Find a page inside a known site                       | `firecrawl map "$site" --search "$path_hint" --limit 20 --json -o .firecrawl/map-{site}.json`                                      |
| Read several pages from one site section              | `firecrawl crawl "$site" --include-paths "$paths" --limit 20 --wait -o .firecrawl/crawl-{site}.json`                               |
| Extract structured data from complex sites            | `firecrawl agent "$prompt" --urls "$urls" --schema-file "$schema" --max-credits "$budget" --wait --json -o .firecrawl/agent-{topic}.json` |
| Download a site to files                              | `firecrawl x download "$site" --include-paths "$paths" --limit 100 -y`                                                             |
| Watch for future changes                              | `firecrawl monitor create --name "$name" --goal "$goal" --schedule "$schedule" --page "$url"`                                      |

Agent schema files use Firecrawl's supported JSON Schema subset; omit the `$schema` declaration. Set `--max-credits` as a realistic hard ceiling: the job fails without an output artifact if it exceeds that budget.

Use `search --sources news` for news, `--tbs qdr:d|w|m|y` for recency, and `--country` or `--location` for regional results. Put repository, version, error text, source type, and other scope directly in a `developer` query. For papers, run several distinct query framings, inspect promising records with `research inspect-paper`, and verify relevant passages with `research read-paper --question "$question"`. A local PDF, DOCX, or spreadsheet is not a web task; parse it with `firecrawl parse "$file"`.

Escalate only as needed:

1. Search with `--scrape` when no URL is known, then inspect the included page content.
2. Scrape when a URL came from `developer`, `map`, or another lead without full content.
3. Map a site when the path is unknown, then scrape the matching page.
4. Crawl only when the answer spans several pages.

Reuse fetched content instead of scraping the same URL twice. A plain search result or snippet is only a lead.

## Interact only after scraping

`firecrawl scrape` handles static pages and JavaScript-rendered apps. If the fetched page still needs a small click or pagination step, continue the scrape's browser session:

```bash
firecrawl scrape "$url" --json -o .firecrawl/start.json
scrape_id=$(jq -r '.metadata.scrapeId' .firecrawl/start.json)
firecrawl interact -s "$scrape_id" "Click the pricing tab"
firecrawl interact -s "$scrape_id" "Return the plan names and prices"
firecrawl interact stop "$scrape_id"
```

Pass the saved scrape ID to every interaction and to `stop`. Firecrawl's implicit "last scrape" state is shared across processes, so another concurrent scrape can replace it.

Use the `agent-browser` skill for login, forms, visual checks, or multi-step browser automation.

## Inspect and answer from evidence

Search results, snippets, abstracts, and extracted fields do not establish a claim. Read the decisive passage in the source that owns the claim.

For every material claim:

- Prefer the canonical primary source and preserve its exact URL.
- Add an independent source when it could change a disputed, time-sensitive, or high-impact conclusion.
- Mark unsupported reasoning as an inference.
- State material contradictions and evidence gaps instead of silently choosing a source.

A negative search proves only that those queries found nothing. Reformulate with an exact identifier, domain, date, or source type before reporting a gap.

## Keep retrieval artifacts usable

Quote URLs because the shell interprets `?` and `&`. Run `mkdir -p .firecrawl`, save outputs there unless the user asks for inline output, and add the directory to `.gitignore` if needed. Use stable, descriptive names:

```text
.firecrawl/search-{topic}.json
.firecrawl/search-{topic}-scraped.json
.firecrawl/{site}-{path}.md
```

Single-format scrapes return raw content. Multiple formats and `--json` return JSON. Inspect large files with bounded reads, `rg`, or `jq`; do not load an entire crawl into context. Run independent scrapes in parallel up to the concurrency limit reported by `firecrawl --status`.

After using search results, send feedback with the search ID from the JSON output. The first feedback for a search refunds one credit:

```bash
firecrawl search-feedback "$search_id" --rating good --valuable-sources "$url" --silent
```

Rate the result `partial` or `bad` and add `--missing-content "$topic"` when appropriate. If `FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` is set, skip feedback.

Finish when the narrowest suitable route has answered the request, the decisive source passages have been inspected, material claims cite their source URLs, and the answer states any contradiction or unresolved gap.
