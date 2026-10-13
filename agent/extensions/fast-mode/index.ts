// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Data, Effect, FileSystem, Schema, Semaphore } from "effect";
import { lock } from "proper-lockfile";

export const SETTINGS_FIELD = "fastMode";

export const KEYBINDING_FIELD = "pi-fast-mode";

export const DEFAULT_SHORTCUT = "ctrl+alt+m";

export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

// The subagents skill launches every subagent with `--name "subagent: <short assignment>"`.
export const SUBAGENT_SESSION_PREFIX = "subagent:";

const Keybindings = Schema.fromJsonString(
  Schema.Struct({
    [KEYBINDING_FIELD]: Schema.optional(Schema.Unknown),
  }),
);

const RequestFields = Schema.Record(Schema.String, Schema.Unknown);

const SettingsObject = Schema.Record(Schema.String, Schema.Unknown);

// Decodes only the field this extension writes and keeps every other setting as-is.
const GlobalSettingsFile = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ [SETTINGS_FIELD]: Schema.optional(SettingsObject) }), [
    SettingsObject,
  ]),
  // Pi writes settings.json with two-space indentation.
  { space: 2 },
);

const ProviderConfig = Schema.Struct({
  request: RequestFields,
  models: Schema.Array(Schema.String),
  // Absent means enabled: only an explicit false keeps subagent sessions at normal speed.
  subagentsEnabled: Schema.optional(Schema.Boolean),
});

type ProviderConfig = typeof ProviderConfig.Type;

const FastModeConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  providers: Schema.Record(Schema.String, ProviderConfig),
});

export type FastModeConfig = typeof FastModeConfig.Type;

type RequestFields = typeof RequestFields.Type;

export const FastModeSettings = Schema.Struct({
  [SETTINGS_FIELD]: Schema.optional(FastModeConfig),
});

const isFastModeSettings = Schema.is(FastModeSettings);

const isModelRequest = Schema.is(Schema.Struct({ model: Schema.String }));

const isRequestFields = Schema.is(RequestFields);

const isArray = Schema.is(Schema.Array(Schema.Unknown));

const isString = Schema.is(Schema.String);

type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

type PiModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;

export function readConfig(settings: PiSettings): FastModeConfig | undefined {
  return isFastModeSettings(settings) ? settings[SETTINGS_FIELD] : undefined;
}

function isSubagentSession(sessionName: string | undefined): boolean {
  return sessionName?.startsWith(SUBAGENT_SESSION_PREFIX) === true;
}

// The provider entry that lists the model, regardless of the session.
function listingProvider(
  config: FastModeConfig | undefined,
  model: PiModel,
): ProviderConfig | undefined {
  if (!config || !Object.hasOwn(config.providers, model.provider)) return undefined;
  const provider = config.providers[model.provider];

  return provider.models.includes(model.id) ? provider : undefined;
}

function disabledForSubagents(provider: ProviderConfig, sessionName: string | undefined): boolean {
  return provider.subagentsEnabled === false && isSubagentSession(sessionName);
}

export function fastRequestFields(
  config: FastModeConfig | undefined,
  model: PiModel | undefined,
  sessionName: string | undefined,
): RequestFields | undefined {
  if (!model) return undefined;
  const provider = listingProvider(config, model);

  if (!provider || disabledForSubagents(provider, sessionName)) return undefined;

  return provider.request;
}

export function withFastRequest<Payload>(
  config: FastModeConfig | undefined,
  model: PiModel | undefined,
  sessionName: string | undefined,
  payload: Payload,
) {
  const fields = fastRequestFields(config, model, sessionName);

  if (!fields || !isModelRequest(payload) || !isRequestFields(payload)) return payload;

  if (payload.model !== model?.id) return payload;

  return {
    ...payload,
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => {
        const current = payload[key];

        return [
          key,
          isArray(current) && isArray(value) ? [...new Set([...current, ...value])] : value,
        ];
      }),
    ),
  };
}

export function describeRequestFields(fields: RequestFields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${isString(value) ? value : JSON.stringify(value)}`)
    .join(", ");
}

export const loadShortcuts = Effect.fn("loadShortcuts")(
  function* (agentDir: string) {
    const fs = yield* FileSystem.FileSystem;

    const parsed = yield* Schema.decodeEffect(Keybindings)(
      yield* fs.readFileString(join(agentDir, "keybindings.json")),
    );

    const value = parsed[KEYBINDING_FIELD];

    if (value === false || value === null) return [];

    const values = Schema.is(Schema.Array(Schema.Unknown))(value) ? value : [value];

    const shortcuts = values.flatMap((item) => {
      if (!Schema.is(Schema.String)(item)) return [];
      const shortcut = item.trim();

      return shortcut && !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()) ? [shortcut] : [];
    });

    return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
  },
  Effect.orElseSucceed(() => [DEFAULT_SHORTCUT]),
);

class SettingsSaveError extends Data.TaggedError("SettingsSaveError")<{
  operation: "lock" | "read" | "decode" | "encode" | "write";
  path: string;
  cause: unknown;
}> {
  override get message(): string {
    const reason = this.cause instanceof Error ? this.cause.message : String(this.cause);

    return `could not ${this.operation} ${this.path}: ${reason}`;
  }
}

// Pi rewrites settings.json under this lock from every running process, so the toggle takes it too.
// The options match Pi's FileSettingsStorage: the same lock path and about 200 ms of retries.
const lockSettings = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        lock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 20 } }),
      catch: (cause) => new SettingsSaveError({ operation: "lock", path, cause }),
    }),
    // release() must get no arguments: its optional first parameter is a completion callback.
    (release) => Effect.tryPromise(() => release()).pipe(Effect.ignore),
  );

const saveEnabled = Effect.fn("saveEnabled")(function* (agentDir: string, enabled: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(agentDir, "settings.json");

  const failed = (operation: SettingsSaveError["operation"]) => (cause: unknown) =>
    new SettingsSaveError({ operation, path, cause });

  yield* lockSettings(path);

  const settings = (yield* fs.exists(path).pipe(Effect.mapError(failed("read"))))
    ? yield* Schema.decodeEffect(GlobalSettingsFile)(
        yield* fs.readFileString(path).pipe(Effect.mapError(failed("read"))),
      ).pipe(Effect.mapError(failed("decode")))
    : {};

  const encoded = yield* Schema.encodeEffect(GlobalSettingsFile)({
    ...settings,
    [SETTINGS_FIELD]: { ...settings[SETTINGS_FIELD], enabled },
  }).pipe(Effect.mapError(failed("encode")));

  yield* fs.writeFileString(path, encoded).pipe(Effect.mapError(failed("write")));
}, Effect.scoped);

function announceState(
  ctx: ExtensionContext,
  config: FastModeConfig | undefined,
  sessionName: string | undefined,
  enabled: boolean,
): void {
  if (!enabled) {
    ctx.ui.notify("Fast mode disabled.", "info");

    return;
  }

  const model = ctx.model;
  const fields = fastRequestFields(config, model, sessionName);

  if (fields) {
    ctx.ui.notify(`Fast mode enabled (${describeRequestFields(fields)}).`, "info");

    return;
  }

  if (model && listingProvider(config, model)) {
    ctx.ui.notify(
      `Fast mode enabled, but the ${SETTINGS_FIELD} setting disables ${model.provider} in subagent sessions.`,
      "warning",
    );

    return;
  }

  ctx.ui.notify(
    `Fast mode enabled, but ${model ? `${model.provider}/${model.id}` : "unknown model"} is not listed in the ${SETTINGS_FIELD} setting.`,
    "warning",
  );
}

// The indicator appears only when requests to the current model receive the fast fields.
function showIndicator(
  ctx: ExtensionContext,
  config: FastModeConfig | undefined,
  sessionName: string | undefined,
  enabled: boolean,
) {
  if (ctx.mode !== "tui") return;
  const active = enabled && fastRequestFields(config, ctx.model, sessionName) !== undefined;

  // The footer orders extension statuses by key; "speed" sorts after "session-timer",
  // so the indicator follows the session time.
  // U+FE0E asks for the text glyph: U+26A1 otherwise renders as a color emoji that ignores dim.
  ctx.ui.setStatus("speed", active ? ctx.ui.theme.fg("dim", "\u26a1\ufe0e Fast") : undefined);
}

export default function fastModeExtension(
  pi: ExtensionAPI,
  agentDir = getAgentDir(),
): Promise<void> {
  let enabled = false;
  const config = () => readConfig(pi.getSettings());
  // Read on every use so a `/name` change applies to the next request.
  const sessionName = () => pi.getSessionName();

  // Pi runs shortcut handlers without waiting for earlier ones, so each toggle reads the
  // state, saves its inverse, and commits it before the next toggle starts.
  const toggles = Semaphore.makeUnsafe(1);

  const toggle = (ctx: ExtensionContext) =>
    Effect.runPromise(
      Effect.suspend(() => {
        const nextEnabled = !enabled;

        return saveEnabled(agentDir, nextEnabled).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              enabled = nextEnabled;
              const currentConfig = config();
              const currentSessionName = sessionName();
              announceState(ctx, currentConfig, currentSessionName, enabled);
              showIndicator(ctx, currentConfig, currentSessionName, enabled);
            }),
          ),
        );
      }).pipe(
        (transition) => toggles.withPermit(transition),
        Effect.catchTag("SettingsSaveError", (error) =>
          Effect.sync(() =>
            ctx.ui.notify(`Could not save Fast mode setting: ${error.message}`, "error"),
          ),
        ),
        Effect.provide(BunFileSystem.layer),
      ),
    );

  pi.registerCommand("fast", {
    description: "Toggle Fast mode",
    handler: (_args, ctx) => toggle(ctx),
  });

  // Pi builds a fresh settings manager from disk for every session and reloads it on /reload,
  // so this sees toggles saved by earlier sessions and other Pi processes.
  // Pi records `--name` before extensions start, so subagent sessions are named by now.
  pi.on("session_start", (_event, ctx) => {
    const currentConfig = config();
    enabled = currentConfig?.enabled === true;
    showIndicator(ctx, currentConfig, sessionName(), enabled);
  });
  // Pi updates ctx.model before emitting model_select.
  pi.on("model_select", (_event, ctx) => showIndicator(ctx, config(), sessionName(), enabled));
  pi.on("session_info_changed", (event, ctx) => showIndicator(ctx, config(), event.name, enabled));
  pi.on("before_provider_request", (event, ctx) =>
    enabled ? withFastRequest(config(), ctx.model, sessionName(), event.payload) : undefined,
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const shortcuts = yield* loadShortcuts(agentDir);

      for (const shortcut of shortcuts) {
        pi.registerShortcut(
          // SAFETY: The SDK's matchesKey parses arbitrary strings and ignores unknown keys; KeyId restricts autocomplete only.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The SDK accepts arbitrary strings at runtime but exposes an autocomplete-only union.
          shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
          {
            description: "Toggle Fast mode",
            handler: (ctx) => toggle(ctx),
          },
        );
      }
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
}
