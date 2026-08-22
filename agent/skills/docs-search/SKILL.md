---
name: docs-search
description: Use documentation online.
---

# Documentation search

Use Context7 to locate documentation.

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
