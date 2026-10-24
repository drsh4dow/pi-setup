# @acme/http-client

A small fetch wrapper with timeouts and retries, shared by Acme's services.

```ts
import { createClient } from "@acme/http-client";

const client = createClient({ baseUrl: "https://api.acme.test", retryCount: 2 });
const user = await client.getJson("/users/42");
```

## Options

| Option       | Default | Meaning                                                     |
| ------------ | ------- | ----------------------------------------------------------- |
| `baseUrl`    | none    | Prefix for every request path.                              |
| `timeoutMs`  | 10000   | Abort a request that takes longer than this.                |
| `retryCount` | 3       | How many times to retry a request that failed with a 5xx.   |

## Releasing

Tag the release commit `vX.Y.Z` and push the tag. The release workflow publishes the
package and creates the GitHub release with notes from `CHANGELOG.md`.
