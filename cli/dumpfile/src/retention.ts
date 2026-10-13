import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { BUCKET_NAME } from "./contract.ts";

const rule = {
  id: "dumpfile-expire-30-days",
  enabled: true,
  conditions: { prefix: "" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } },
};

interface Runtime {
  readonly auth: string;
  readonly fetch: typeof fetch;
  readonly write: (text: string) => void;
}

const authSchema = Type.Object({
  type: Type.Union([Type.Literal("oauth"), Type.Literal("api_token")]),
  token: Type.String(),
});

// Values come from response.json(); check their shape without stripping extras.
const lifecycleRuleSchema = Type.Object({
  id: Type.String(),
  enabled: Type.Boolean(),
  conditions: Type.Record(Type.String(), Type.Unknown()),
  deleteObjectsTransition: Type.Optional(Type.Unknown()),
});

const lifecycleResponseSchema = Type.Object({
  success: Type.Literal(true),
  result: Type.Object({
    rules: Type.Optional(Type.Array(lifecycleRuleSchema)),
  }),
});

type Operation = "read" | "apply" | "verify";

// The message names the failed operation and a reason this module wrote. API errors and
// bodies can contain credentials, so they stay in the cause and never reach the output.
class RetentionFailure extends Error {
  constructor(operation: Operation, reason: string, options?: ErrorOptions) {
    super(`Retention ${operation} failed: ${reason}`, options);
  }
}

function parseAuth(text: string) {
  let auth: unknown;

  try {
    auth = JSON.parse(text);
  } catch {
    // JSON.parse quotes its input, which is the token, so its message is dropped.
    return undefined;
  }

  if (!Value.Check(authSchema, auth) || !auth.token) return undefined;

  return auth;
}

export async function main(args: readonly string[], runtime: Runtime): Promise<number> {
  const [mode, account, approval] = args;

  if (
    !account ||
    !/^[a-f0-9]{32}$/.test(account) ||
    !(
      (mode === "check" && args.length === 2) ||
      (mode === "apply" && args.length === 3 && approval === "--expire-existing-uploads")
    )
  ) {
    runtime.write(
      "Usage: retention.ts check <account-id> | apply <account-id> --expire-existing-uploads\nApply authorizes expiration of ALL existing and future dumpfile-prod objects after 30 days of object age.\n",
    );

    return 1;
  }

  const auth = parseAuth(runtime.auth);

  if (!auth) {
    runtime.write(
      "Supply Wrangler auth token --json on stdin; API key authentication is unsupported.\n",
    );

    return 1;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET_NAME}/lifecycle`;

  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
    "cf-r2-data-catalog-check": "true",
  };

  async function send(operation: Operation, init: RequestInit) {
    let response: Response;

    try {
      response = await runtime.fetch(url, { ...init, headers });
    } catch (cause) {
      throw new RetentionFailure(operation, "network error", { cause });
    }

    if (!response.ok) throw new RetentionFailure(operation, `HTTP ${response.status}`);

    try {
      const body: unknown = await response.json();

      return body;
    } catch (cause) {
      throw new RetentionFailure(operation, "response is not JSON", { cause });
    }
  }

  async function readRules(operation: Operation) {
    const body = await send(operation, { method: "GET" });

    if (!Value.Check(lifecycleResponseSchema, body))
      throw new RetentionFailure(operation, "unexpected lifecycle response");

    return body.result.rules ?? [];
  }

  try {
    let rules = await readRules("read");
    const expected = [...rules.filter((item) => item.id !== rule.id), rule];
    const configured = rules.filter((item) => item.id === rule.id);

    if (mode === "apply" && !isDeepStrictEqual(configured, [rule])) {
      const body = await send("apply", {
        method: "PUT",
        body: JSON.stringify({ rules: expected }),
      });

      if (!Value.Check(Type.Object({ success: Type.Literal(true) }), body))
        throw new RetentionFailure("apply", "Cloudflare did not report success");
      rules = await readRules("verify");

      if (!isDeepStrictEqual(rules, expected))
        throw new RetentionFailure("verify", "read-back differs from the applied configuration");
    }

    const matches = isDeepStrictEqual(
      rules.filter((item) => item.id === rule.id),
      [rule],
    );

    runtime.write(
      matches
        ? "30-day lifecycle configured. Expiry is asynchronous.\n"
        : "30-day lifecycle not configured.\n",
    );

    if (
      rules.some(
        (item) => item.id !== rule.id && item.enabled && item.deleteObjectsTransition !== undefined,
      )
    ) {
      runtime.write(
        "Other expiration rules remain; review their prefixes and ages for earlier deletion.\n",
      );
    }

    return matches ? 0 : 1;
  } catch (error) {
    if (!(error instanceof RetentionFailure)) throw error;
    runtime.write(
      `${error.message}. Check Wrangler credentials, API availability, and lifecycle configuration. No deployment is verified.\n`,
    );

    return 1;
  }
}

if (import.meta.main) {
  let auth = "";

  for await (const chunk of process.stdin) auth += chunk;
  process.exitCode = await main(process.argv.slice(2), {
    auth,
    fetch,
    write: (text) => process.stdout.write(text),
  });
}
