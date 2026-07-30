# OpenAI GPT-5.6 Fast mode

Research date: 2026-07-30. Primary sources only. Codex source observations are pinned to [`4642370`](https://github.com/openai/codex/tree/4642370542739d5dd080b0c87a9de06a6435d3db).

## Findings

### 1. Responses API wire value

The new public API spelling is:

```json
{"service_tier":"fast"}
```

on `POST https://api.openai.com/v1/responses`. `{"service_tier":"priority"}` is explicitly backward-compatible and has the same behavior on supported models. For GPT-5.6 and earlier, the response reports `service_tier: "priority"` even when the request used `"fast"`; `"default"` in the response means Standard processing (including a Fast request downgraded by ramp-rate controls). Sources: [launch post](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/), [Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode), [Responses endpoint reference](https://developers.openai.com/api/reference/resources/responses/methods/create/).

Therefore a third-party Pi extension calling the public Responses API should emit `service_tier: "fast"`. `"priority"` remains valid but is the legacy name, not the newly documented canonical spelling.

### 2. ChatGPT-authenticated Codex path

ChatGPT auth does use a different general transport from API-key auth, but current Codex source shows no separate Fast-specific endpoint, header, or entitlement request field:

- ChatGPT-family auth modes select base URL `https://chatgpt.com/backend-api/codex`; API-key auth selects `https://api.openai.com/v1` ([`codex-rs/model-provider-info/src/lib.rs#L245-L263`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/model-provider-info/src/lib.rs#L245-L263)). Appending Codex's `/responses` path yields the ChatGPT endpoint `https://chatgpt.com/backend-api/codex/responses` ([`codex-rs/core/src/client.rs#L159-L160`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/core/src/client.rs#L159-L160)).
- ChatGPT auth adds the ordinary bearer authorization and `ChatGPT-Account-ID` account/workspace header; it does not add a Fast-specific header ([`codex-rs/model-provider/src/auth.rs#L96-L108`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/model-provider/src/auth.rs#L96-L108)).
- Fast is still serialized as the ordinary Responses request member `service_tier`; both HTTP and WebSocket request structures carry it ([`codex-rs/codex-api/src/common.rs#L252-L276`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/codex-api/src/common.rs#L252-L276), [`#L279-L323`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/codex-api/src/common.rs#L279-L323)). Codex maps its Fast selection to wire value `"priority"`, not the new public API spelling `"fast"` ([`codex-rs/protocol/src/config_types.rs#L481-L510`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/protocol/src/config_types.rs#L481-L510)).
- Availability is catalog-driven client-side: a selected tier survives only if the resolved model advertises the tier ID; unsupported configured tiers are omitted with a warning ([`codex-rs/core/src/session/mod.rs#L881-L910`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/core/src/session/mod.rs#L881-L910)). Catalog entries also carry account-type visibility, so account/workspace identity affects which model metadata is returned/usable ([`codex-rs/models-manager/models.json#L1-L112`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/models-manager/models.json#L1-L112)).

The official Codex documentation calls this a **ChatGPT credit feature** available when signed in with ChatGPT, with plan credits/multipliers distinct from API token billing ([Codex Speed](https://developers.openai.com/codex/speed)). The inspected client contains no separate Fast-entitlement API or entitlement header. The defensible conclusion is: entitlement/enforcement is server/account/catalog mediated through normal ChatGPT auth and model metadata, not a client-minted entitlement. Server internals are not public, so the exact backend entitlement check cannot be established from the allowed sources.

### 3. Current meanings and aliases

| Term | Current meaning |
|---|---|
| API `fast` | Canonical public Responses/Chat Completions request value for premium low-latency processing; on GPT-5.6 Sol, up to 2.5× Standard speed at 2× API token price. |
| API `priority` | Legacy request spelling, now explicitly synonymous/backward-compatible with API Fast mode. GPT-5.6-and-earlier responses normalize Fast to `"priority"`. |
| Codex `/fast` / UI “Fast” | ChatGPT-credit mode: documented as 1.5× model speed; GPT-5.6/5.5 consume 2.5× credits and GPT-5.4 consumes 2×. This is aligned conceptually with API Fast but has subscription-credit economics rather than API pricing. |
| Codex config `service_tier = "fast"` | User-facing/config alias. Codex normalizes both config/request spellings `fast` and `priority` to runtime/wire `priority`. |
| Codex `[features].fast_mode = true` | Feature gate required for configured service tiers to be applied; if disabled Codex sends none. It is not itself the service-tier wire value. |
| Codex `default` | Internal request/config sentinel meaning explicitly use Standard/no catalog tier; Codex strips it rather than sending it to `/responses`. |
| `flex` | Separate slower/lower-cost API processing tier, unrelated to Fast/Priority; Codex preserves it as `flex` where a model advertises support. |

Sources: [launch post](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/), [API Fast guide](https://developers.openai.com/api/docs/guides/fast-mode), [Codex Speed](https://developers.openai.com/codex/speed), and Codex's exact alias mapping at [`config_types.rs#L481-L510`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/protocol/src/config_types.rs#L481-L510).

### 4. Support and validation implications for Pi

- Official API constraints: supported models only; multimodal/image requests are supported, but long-context requests, fine-tuned models, and embeddings are not. Fast availability is not guaranteed for every future model and can vary by region. A rapid traffic ramp can be serviced as `default` instead ([Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode)).
- Codex's current bundled catalog advertises tier ID `priority` / display name `Fast` for `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `gpt-5.4`; it does not advertise it for `gpt-5.4-mini`, `gpt-5.2`, or `codex-auto-review` ([`codex-rs/models-manager/models.json#L1-L642`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/models-manager/models.json#L1-L642)). The official Codex page summarizes support as GPT-5.6, GPT-5.5, and GPT-5.4.
- Codex validates dynamically against `model_info.service_tiers`; `additional_speed_tiers: ["fast"]` is deprecated compatibility metadata used only to recognize Fast-mode capability, while actual request validation checks tier IDs ([`codex-rs/protocol/src/openai_models.rs#L654-L677`](https://github.com/openai/codex/blob/4642370542739d5dd080b0c87a9de06a6435d3db/codex-rs/protocol/src/openai_models.rs#L654-L677)).
- Pi's provider-request hook does not expose Codex's model catalog, so the extension must keep a conservative snapshot of Codex-supported model IDs and update it when that catalog changes. The extension emits canonical `fast` for both API-key and ChatGPT-authenticated requests by project policy. Current Codex source emits `priority` to the private ChatGPT endpoint, so this intentionally does not reproduce Codex's catalog tier mapping.
