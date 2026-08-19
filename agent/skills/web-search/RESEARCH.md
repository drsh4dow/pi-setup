# Web research

Use this route when a non-security answer needs several source types or scientific literature. Before retrieval, write down the decision question, required fields, and source types. Reuse the current run directory or create one:

```bash
run_dir="${run_dir:-$(mktemp -d /tmp/web-search.XXXXXX)}"
artifact='01-research-branch'
query='replace with the natural-language research question'
paper_id='replace with an arxiv:, doi:, pmid:, or pmcid: ID'
question='replace with the exact claim to verify'
```

## Source routes

Load [CAPTURE.md](CAPTURE.md) before retrieval.

- For web pages, developer sources, site exploration, or rendered content, read [GENERAL.md](GENERAL.md) and use its matching route for each source type.
- For scientific discovery, run `capture "$run_dir/${artifact}-papers.md" timeout 90s firecrawl research search-papers "$query" --limit 8`. Try at most two query framings. Use a new `artifact` and reformulate only when the first query misses a required field.
- For paper metadata, run `capture "$run_dir/${artifact}-paper.md" timeout 60s firecrawl research inspect-paper "$paper_id"`.
- For a citation graph, run `capture "$run_dir/${artifact}-related.md" timeout 90s firecrawl research related-papers "$paper_id" --intent "$question" --limit 8` only when neighboring papers could change the conclusion. Skip it when the original paper directly defines the claim.
- For full-text passages, run `capture "$run_dir/${artifact}-passages.md" timeout 90s firecrawl research read-paper "$paper_id" --question "$question" --limit 3`.

Search results and abstracts identify candidates. Inspect at most three candidates for each query framing. If passage extraction damages fractions, roots, subscripts, equations, or tables, verify the exact notation or values in the canonical HTML or PDF.

Resolve source IDs through their canonical owners: `https://arxiv.org/abs/ID`, `https://doi.org/ID`, `https://pubmed.ncbi.nlm.nih.gov/ID/`, or `https://pmc.ncbi.nlm.nih.gov/articles/ID/`. Inspect the resolved source. Preserve its exact final URL and revision when available. A metadata ID alone does not satisfy the URL requirement.

## Investigation

1. Prefer primary sources. Record each exact URL, immutable revision when one exists, and decisive passage.
2. Label claims as `observed`, `source-derived`, or `inferred`. Add independent corroboration only when it could change a disputed, time-sensitive, or high-impact conclusion.
3. Reconcile contradictions. When a field remains missing, report `incomplete`, the routes tried, and the evidence that would reopen it.

Delegate independent source types when delegation is available. Otherwise investigate them sequentially. Give each branch a unique subdirectory under `$run_dir`. The main agent must inspect every decisive source before writing the synthesis.

The research is complete when every required field and material claim has inspected evidence or an explicit `inferred` or `incomplete` label, exact source URLs remain available, and the result shows contradictions and coverage gaps. For transport recovery, follow [GENERAL.md's recovery path](GENERAL.md#recovery).
