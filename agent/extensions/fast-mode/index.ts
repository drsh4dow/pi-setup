// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, Schema } from "effect";
import { lock } from "proper-lockfile";

export const SETTINGS_FIELD = "fastMode";

export const KEYBINDING_FIELD = "pi-fast-mode";

export const DEFAULT_SHORTCUT = "ctrl+alt+m";

export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

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

const FastModeConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  providers: Schema.Record(
    Schema.String,
    Schema.Struct({ request: RequestFields, models: Schema.Array(Schema.String) }),
  ),
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

export function fastRequestFields(
  config: FastModeConfig | undefined,
  model: PiModel | undefined,
): RequestFields | undefined {
  if (!config || !model) return undefined;
  const { providers } = config;

  // Account-scoped providers such as `openai-codex@work` share their base provider's entry.
  const name = [model.provider, model.provider.split("@")[0]].find((candidate) =>
    Object.hasOwn(providers, candidate),
  );

  const provider = name === undefined ? undefined : providers[name];

  return provider?.models.includes(model.id) ? provider.request : undefined;
}

export function withFastRequest<Payload>(
  config: FastModeConfig | undefined,
  model: PiModel | undefined,
  payload: Payload,
) {
  const fields = fastRequestFields(config, model);

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

// Pi rewrites settings.json under this lock from every running process, so the toggle takes it too.
// The options match Pi's FileSettingsStorage: the same lock path and about 200 ms of retries.
const lockSettings = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(() =>
      lock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 20 } }),
    ),
    // release() must get no arguments: its optional first parameter is a completion callback.
    (release) => Effect.tryPromise(() => release()).pipe(Effect.ignore),
  );

const saveEnabled = Effect.fn("saveEnabled")(function* (agentDir: string, enabled: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(agentDir, "settings.json");
  yield* lockSettings(path);

  const settings = (yield* fs.exists(path))
    ? yield* Schema.decodeEffect(GlobalSettingsFile)(yield* fs.readFileString(path))
    : {};

  yield* fs.writeFileString(
    path,
    yield* Schema.encodeEffect(GlobalSettingsFile)({
      ...settings,
      [SETTINGS_FIELD]: { ...settings[SETTINGS_FIELD], enabled },
    }),
  );
}, Effect.scoped);

function announceState(
  ctx: ExtensionContext,
  config: FastModeConfig | undefined,
  enabled: boolean,
): void {
  if (!enabled) {
    ctx.ui.notify("Fast mode disabled.", "info");

    return;
  }

  const model = ctx.model;
  const fields = fastRequestFields(config, model);

  if (fields) {
    ctx.ui.notify(`Fast mode enabled (${describeRequestFields(fields)}).`, "info");

    return;
  }

  ctx.ui.notify(
    `Fast mode enabled, but ${model ? `${model.provider}/${model.id}` : "unknown model"} is not listed in the ${SETTINGS_FIELD} setting.`,
    "warning",
  );
}

function showIndicator(ctx: ExtensionContext, enabled: boolean) {
  if (ctx.mode !== "tui") return;

  // The footer orders extension statuses by key; "speed" sorts after "session-timer",
  // so the indicator follows the session time.
  // U+FE0E asks for the text glyph: U+26A1 otherwise renders as a color emoji that ignores dim.
  ctx.ui.setStatus("speed", enabled ? ctx.ui.theme.fg("dim", "\u26a1\ufe0e Fast") : undefined);
}

export default function fastModeExtension(
  pi: ExtensionAPI,
  agentDir = getAgentDir(),
): Promise<void> {
  let enabled = false;
  const config = () => readConfig(pi.getSettings());

  const toggle = (ctx: ExtensionContext) => {
    const nextEnabled = !enabled;

    return Effect.runPromise(
      saveEnabled(agentDir, nextEnabled).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            enabled = nextEnabled;
            announceState(ctx, config(), enabled);
            showIndicator(ctx, enabled);
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => ctx.ui.notify("Could not save Fast mode setting.", "error")),
        ),
        Effect.provide(BunFileSystem.layer),
      ),
    );
  };

  pi.registerCommand("fast", {
    description: "Toggle Fast mode",
    handler: (_args, ctx) => toggle(ctx),
  });

  // Pi builds a fresh settings manager from disk for every session and reloads it on /reload,
  // so this sees toggles saved by earlier sessions and other Pi processes.
  pi.on("session_start", (_event, ctx) => {
    enabled = config()?.enabled === true;
    showIndicator(ctx, enabled);
  });
  pi.on("before_provider_request", (event, ctx) =>
    enabled ? withFastRequest(config(), ctx.model, event.payload) : undefined,
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
