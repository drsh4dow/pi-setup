---
name: docs-search
description: Use when a library or API question needs current or version-specific documentation.
---

# Documentation search

Read [the evidence standard](../web-search/EVIDENCE.md). Use Context7 to locate documentation, then verify material or version-sensitive claims against the canonical project source.

## Lookup

1. Resolve the library with one focused question:

   ```bash
   ctx7 library "$library" "$question" --json
   ```

2. Choose the candidate whose repository belongs to the canonical project. A matching title alone is insufficient. When `versions` contains the requested version, query `"$library_id/$version"`.
3. Query one topic:

   ```bash
   ctx7 docs "$library_id" "$question" --json
   ```

4. Preserve the decisive source URL or `codeId`. For a material contract, inspect the linked canonical documentation or repository page with `firecrawl scrape`.

Use a separate query only when the question contains a distinct topic. If Context7 cannot identify the canonical project, lacks the requested version, or omits a required field, use `firecrawl developer` or the `web-search` skill and mark the Context7 result `incomplete`.

Finish when the project identity and version are explicit, every answer field has inspected support, and any version gap or contradiction is stated.
