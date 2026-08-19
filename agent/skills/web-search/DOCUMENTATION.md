# Documentation lookup

Use Context7 for library, framework, package, and API documentation. Reuse the current run directory or create one. Set the library, one documentation question, and a unique filesystem-safe artifact label:

```bash
run_dir="${run_dir:-$(mktemp -d /tmp/web-search.XXXXXX)}"
artifact='01-library-topic'
library='replace with the library or package name'
question='replace with one documentation topic'
```

Load [CAPTURE.md](CAPTURE.md), then resolve the library:

```bash
capture_json "$run_dir/${artifact}-ctx7-libraries.json" timeout 60s ctx7 library "$library" "$question" --json
```

Inspect the candidates. Repository identity determines which ID belongs to the canonical project. Use the requested version, available versions, and trust score to choose among that project's candidates. A matching title is not enough. Assign the chosen `id` to `library_id`. If `versions` contains the requested version, append it exactly with `library_id="$library_id/$version"`. Then query one topic:

```bash
capture_json "$run_dir/${artifact}-ctx7-docs.json" timeout 60s ctx7 docs "$library_id" "$question" --json
```

Context7 can read public documentation without a login. Inspect the saved JSON and preserve each decisive `codeId` or source URL. Before relying on a version-sensitive contract or other material claim, retrieve and inspect the canonical source through [GENERAL.md](GENERAL.md).

Keep one topic in each docs query. Use a new `artifact` only for a distinct topic. If no candidate belongs to the canonical project, the requested version is missing, or the result omits a required field, use the [developer or discovery route](GENERAL.md#routes) and mark the Context7 route `incomplete`.

The lookup is complete when the library identity is explicit, inspected snippets or canonical sources support every answer field, exact source identifiers remain available, and the result states any version gap or contradiction.
