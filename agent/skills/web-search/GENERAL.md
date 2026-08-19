# General web search

Use the narrowest route that can answer the question. Reuse the current artifact directory or create one:

```bash
run_dir="${run_dir:-$(mktemp -d /tmp/web-search.XXXXXX)}"
```

Before retrieval, load [CAPTURE.md](CAPTURE.md). Set a unique filesystem-safe `artifact` label and only the inputs used by the chosen route. For example, `artifact='01-pathlib'; query='Python pathlib read_text behavior'`.

## Routes

- For general discovery, set `query` and run `capture "$run_dir/${artifact}-search.md" timeout 90s firecrawl search "$query" --limit 5`.
- For a known page, set `url` and run `capture "$run_dir/${artifact}-page.md" timeout 90s firecrawl scrape "$url" --only-main-content`.
- For programming behavior, an error, or a GitHub issue or pull-request trail, set `query` and run `capture "$run_dir/${artifact}-developer.md" timeout 90s firecrawl developer "$query" --limit 5`.
- For an unknown path on one site, set `url` and `path_hint`, then run `capture "$run_dir/${artifact}-map.txt" timeout 90s firecrawl map "$url" --search "$path_hint" --limit 20 --timeout 60`.
- For several pages on one site, set `url` and run `capture_json "$run_dir/${artifact}-crawl.json" timeout 150s firecrawl crawl "$url" --wait --limit 10 --max-depth 2 --timeout 120`.

For content that requires clicks, authentication, visual state, or rendered interaction, set `url`. Run `capture "$run_dir/${artifact}-agent-browser-core.md" timeout 30s agent-browser skills get core` and load the result. Derive `browser_session="$(agent-browser session id --scope worktree --prefix "web-search-$(basename "$run_dir")")"`. Wrap every browser command, including close, in `timeout 30s`. Pass `--session "$browser_session"` and `--idle-timeout 60s` every time so launch options stay fixed. Follow the loaded workflow and close with the same options. If the site rejects that isolated development browser, use [HELIUM-CDP.md](HELIUM-CDP.md) as the last fallback.

Check an artifact's size before loading it and read only the decisive sections. Search snippets and `firecrawl developer` passages identify candidates. They are not evidence. Firecrawl and browser commands may print an ID or launch diagnostic on stderr even when they succeed, so judge the command by its exit status and expected output.

Map only when the canonical path is unknown; crawl only when the answer spans several pages. Crawl output is JSON. Verify every returned `metadata.sourceURL`; unexpected probe or query URLs do not establish coverage.

## Evidence

Prefer the canonical primary source. Preserve its exact URL and inspect the decisive passage before making a material claim. Add an independent source only when it could change a disputed, time-sensitive, or high-impact conclusion.

A successful command that omits expected content is incomplete. Reformulate once with an exact identifier, domain, or source type. Switch routes only when another route can expose the missing evidence. Never treat absence from search results as proof. Report `incomplete`, the routes tried, and the evidence that would reopen the question.

The search is complete when every material claim has an inspected source or an explicit `inferred` or `incomplete` label, every source has an exact URL, and the result shows contradictions and missing fields.

## Recovery

Run `firecrawl --status` when availability or authentication is unclear. To diagnose a run with a job ID, set `job_id` and a new `artifact`, then run `capture "$run_dir/${artifact}-doctor.txt" timeout 60s firecrawl doctor "$job_id"`. Diagnosis can take longer than retrieval. Inspect the failing command's current `--help` only when it rejects the documented syntax.
