---
name: docs-search
description: Resolve uncertain or version-sensitive library and API behavior from authoritative documentation.
---

# Documentation search

Reuse authoritative evidence already gathered. Prefer installed source or local docs when they answer the version-specific question. Use Context7 for external lookup when needed; its text output lists candidate IDs and renders documentation as Markdown.

## Lookup

1. Resolve the library with one focused question:

   ```bash
   ctx7 library "$library" "$question"
   ```

2. Choose the candidate whose repository belongs to the canonical project. A matching title alone is insufficient. When `versions` contains the requested version, query `"$library_id/$version"`.
3. Query one topic:

   ```bash
   ctx7 docs "$library_id" "$question"
   ```

If Context7 is unavailable or lacks the relevant version, consult the installed source or canonical project documentation. Use [web-search](../web-search/SKILL.md) when locating or retrieving an official source requires live retrieval. State a version gap rather than treating unrelated documentation as authoritative.
