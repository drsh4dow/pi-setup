# Web research

Use this route when a non-security answer requires several source families or scientific literature. Define the decision question, required fields, and source families before retrieval. Create a collision-free run directory when one does not already exist:

```bash
run_dir="${run_dir:-$(mktemp -d /tmp/web-search.XXXXXX)}"
artifact='01-research-branch'
query='replace with the natural-language research question'
paper_id='replace with an arxiv:, doi:, pmid:, or pmcid: ID'
question='replace with the exact claim to verify'
```

## Source routes

Load [CAPTURE.md](CAPTURE.md) before retrieval.

- Web pages, developer sources, site exploration, or rendered content: read [GENERAL.md](GENERAL.md) and use its matching route for each source family.
- Scientific discovery: run `capture "$run_dir/${artifact}-papers.md" timeout 90s firecrawl research search-papers "$query" --limit 8`. Use at most two distinct framings; assign a new `artifact` and reformulate only when the first framing misses a required field.
- Metadata: `capture "$run_dir/${artifact}-paper.md" timeout 60s firecrawl research inspect-paper "$paper_id"`
- Citation graph: only when neighboring papers can change the conclusion, run `capture "$run_dir/${artifact}-related.md" timeout 90s firecrawl research related-papers "$paper_id" --intent "$question" --limit 8`. Skip it for a claim directly defined by the original paper.
- Full-text passages: `capture "$run_dir/${artifact}-passages.md" timeout 90s firecrawl research read-paper "$paper_id" --question "$question" --limit 3`

Search results and abstracts select candidates. Inspect at most three candidates per framing. When passage extraction mangles fractions, roots, subscripts, equations, or tables, verify the exact notation or values against canonical HTML or PDF.

Resolve source IDs through their canonical owners: `https://arxiv.org/abs/ID`, `https://doi.org/ID`, `https://pubmed.ncbi.nlm.nih.gov/ID/`, or `https://pmc.ncbi.nlm.nih.gov/articles/ID/`. Inspect the resolved source and preserve its exact final URL and revision when available; metadata IDs alone do not satisfy the URL requirement.

## Investigation

1. Prefer primary sources. Record each exact URL, immutable revision when one exists, and decisive passage.
2. Label claims as observed, source-derived, or inferred. Add independent corroboration only when it can change a disputed, time-sensitive, or impact-bearing conclusion.
3. Reconcile contradictions explicitly. When a field remains missing, report `incomplete`, the routes exhausted, and the evidence that would reopen it.

For independent source families, delegate bounded branches when delegation is available; otherwise run them sequentially. Give each branch a unique subdirectory under `$run_dir`. The main agent inspects every decisive source before synthesis.

The research is complete when every required field and material claim has inspected evidence or an explicit inferred/incomplete label, exact source URLs are preserved, and contradictions and coverage gaps are visible. For transport recovery, follow [GENERAL.md's recovery path](GENERAL.md#recovery).
