---
name: docs-search
description: Use documentation online.
---

# Documentation search

Use Context7's text output to locate documentation. It lists candidate IDs and renders documentation as Markdown, ready to read as-is.

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
