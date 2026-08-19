# Documentation lookup

Use Context7 for library, framework, package, and API documentation. Preserve a parent run directory or create one, then assign the task inputs and a unique filesystem-safe artifact label:

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

Inspect the candidates and select the ID owned by the canonical project, using repository identity, available versions, trust score, and task version rather than title alone. Assign its `id` to `library_id`. When its `versions` contains the requested version, append that exact version: `library_id="$library_id/$version"`. Then query one topic:

```bash
capture_json "$run_dir/${artifact}-ctx7-docs.json" timeout 60s ctx7 docs "$library_id" "$question" --json
```

Context7 works for public docs without login. Its JSON contains snippets and source identifiers; inspect the artifact rather than loading it blindly. Preserve each decisive `codeId` or source URL. For a version-sensitive contract or material claim, retrieve and inspect that canonical source through [GENERAL.md](GENERAL.md) before concluding.

Keep each docs query to one topic; assign a new `artifact` and run another only when the task actually asks a distinct topic. If resolution has no canonical candidate, the requested version is absent, or the docs result lacks the required field, use [GENERAL.md's developer or discovery route](GENERAL.md#routes) and label the Context7 route `incomplete`.

The lookup is complete when the selected library identity is explicit, every answer field is supported by an inspected snippet or canonical source, exact source identifiers are preserved, and version gaps or contradictions are visible.
