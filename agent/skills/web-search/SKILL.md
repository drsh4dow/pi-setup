---
name: web-search
description: Find and read live web sources when the answer needs evidence unavailable in the current context.
disable-model-invocation: false
user-invokable: false
---

# Web search

Web retrieval runs inside `codemode` scripts. Search, fetch, and filter in the
same script, and return only what the answer needs: titles, URLs, dates, and
the decisive passages. Codemode cuts output past 10,000 tokens from the middle,
so a script that returns whole results loses part of what it retrieved.

| Need                                      | Route                                      |
| ----------------------------------------- | ------------------------------------------ |
| Discover sources                          | `tools.mcp__perplexity__perplexity_search` |
| Read known URLs                           | `tools.mcp__exa__web_fetch_exa`            |
| GitHub issues, PRs, code, or repositories | `gh search` through `tools.bash`           |
| Login, forms, clicks, or visual state     | the `agent-browser` skill                  |

GitHub allows 30 search requests a minute across `gh search` commands, so
start with two or three targeted queries and read the items they find.

Both tools resolve to an MCP result, including failures, which set `isError`.
Its `content[0].text` holds the Markdown output. `describeTool()` lists the
parameters this skill leaves out.

## Search

Call `perplexity_search({ query, max_results, max_tokens_per_page,
search_domain_filter, search_recency_filter })`. The defaults, 10 results with
up to 1,024 tokens of page excerpt each, return about 40,000 characters, so set
both to what the question needs; `max_tokens_per_page` accepts 256 to 2,048.

Put identifiers, versions, dates, and source types in the query, and run
independent queries in parallel within one script. Restrict official sources
and papers with `search_domain_filter`, for example `arxiv.org` and
`openreview.net`, and time-sensitive questions with `search_recency_filter`.
Keep the default `web` search type, which the benchmarks behind this setup
measured.

Results are numbered `N. **Title**` blocks, each with a `URL:` line and a page
excerpt. Split them and keep the lines that bear on the question:

```js
const terms = /rate limit|429|retry-after/i;
const r = await tools.mcp__perplexity__perplexity_search({
  query,
  max_results: 5,
});
return r.content[0].text
  .split(/\n(?=\d+\. \*\*)/)
  .slice(1)
  .map((result) =>
    result
      .split("\n")
      .filter((line, i) => i < 2 || terms.test(line))
      .join("\n"),
  );
```

Fetch the page when its excerpt stops short of the decisive passage.

## Fetch

Call `web_fetch_exa({ urls, maxCharacters })` with every URL in one batch. It
returns the pages in one text, each starting with a `# Title` line and a `URL:`
line, so split it with `/\n(?=# .*\nURL: )/`. Set `maxCharacters` to the length
the question needs, since the default of 3,000 characters per page truncates
long documents.

Fetch each page once. For a long page, `store()` its text and return its
headings, then `load()` it in later scripts to return the sections the answer
needs.

A batch leaves out pages it could not fetch, so match the returned `URL:` lines
against the request. Check a missing page's status code with
`curl -sL -o /dev/null -w '%{http_code}'`: report a 404 as gone, and read any
other failure with `agent-browser`. Use `agent-browser` as well for an empty or
shell page, and when the page's current state matters, such as prices, status,
or a change published today, since Exa may serve a cached copy.

## Establish the answer

Read the decisive passage in the source that owns the claim, in its search
excerpt or its fetched page. Excerpts from other sites and extracted fields are
leads, not sufficient evidence by themselves.

Cite canonical URLs for material claims. Add another source only when it could
change a disputed, time-sensitive, or consequential conclusion. Mark inference,
contradictions, and material evidence gaps explicitly.

A negative search establishes only what those queries found. Refine scope or
identifiers before concluding that evidence is unavailable. Finish once the
inspected evidence adequately answers the request; further searching needs a
concrete unresolved question.
