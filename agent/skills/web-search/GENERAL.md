# General web search

Use the narrowest route that can answer the question. Preserve a parent route's artifact directory or create a collision-free one:

```bash
run_dir="${run_dir:-$(mktemp -d /tmp/web-search.XXXXXX)}"
```

Before retrieval, load [CAPTURE.md](CAPTURE.md). Assign a unique filesystem-safe `artifact` label and only the task inputs named by the selected route. For example: `artifact='01-pathlib'; query='Python pathlib read_text behavior'`.

## Routes

- General discovery (`query`): `capture "$run_dir/${artifact}-search.md" timeout 90s firecrawl search "$query" --limit 5`
- Known page (`url`): `capture "$run_dir/${artifact}-page.md" timeout 90s firecrawl scrape "$url" --only-main-content`
- Programming behavior, error, or GitHub issue/PR trail (`query`): `capture "$run_dir/${artifact}-developer.md" timeout 90s firecrawl developer "$query" --limit 5`
- Unknown paths on one site (`url`, `path_hint`): `capture "$run_dir/${artifact}-map.txt" timeout 90s firecrawl map "$url" --search "$path_hint" --limit 20 --timeout 60`
- Several pages on one site (`url`): `capture_json "$run_dir/${artifact}-crawl.json" timeout 150s firecrawl crawl "$url" --wait --limit 10 --max-depth 2 --timeout 120`
- Content requiring clicks, authentication, visual state, or rendered interaction (`url`): run `capture "$run_dir/${artifact}-agent-browser-core.md" timeout 30s agent-browser skills get core` and load it. Derive `browser_session="$(agent-browser session id --scope worktree --prefix "web-search-$(basename "$run_dir")")"`; wrap every browser command, including close, in `timeout 30s`, and pass both `--session "$browser_session"` and `--idle-timeout 60s` every time so launch options remain stable. Follow the loaded workflow and always close with those same options. If the site specifically rejects that isolated development browser, use [HELIUM-CDP.md](HELIUM-CDP.md) as the terminal fallback.

Inspect an artifact's size before loading it and read only the decisive sections. Search snippets and `firecrawl developer` passages select candidates; they are not evidence. A successful Firecrawl or browser command may emit an ID or launch diagnostic on stderr, so judge success by exit status and expected content.

Map only when the canonical path is unknown; crawl only when the answer spans several pages. Crawl output is JSON. Verify every returned `metadata.sourceURL`; unexpected probe or query URLs do not establish coverage.

## Evidence

Prefer the canonical primary source. Preserve its exact URL and inspect the decisive passage before making a material claim. Add an independent source only when it can change a disputed, time-sensitive, or impact-bearing conclusion.

A successful command with missing expected content is incomplete. Reformulate once with an exact identifier, domain, or source class; then switch routes only when the new route can expose the missing evidence. Report `incomplete`, the routes exhausted, and what evidence would reopen the question rather than treating absence from search results as proof.

The search is complete when every material claim has an inspected source or an explicit inferred/incomplete label, every source has an exact URL, and contradictions or missing fields are visible.

## Recovery

Run `firecrawl --status` when availability or authentication is unclear. When a run with a job ID needs diagnosis, assign `job_id` and a new `artifact`, then run `capture "$run_dir/${artifact}-doctor.txt" timeout 60s firecrawl doctor "$job_id"`; diagnosis can be slower than retrieval. Inspect the failing command's current `--help` only when it rejects the documented syntax.
