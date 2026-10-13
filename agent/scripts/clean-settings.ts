#!/usr/bin/env node

// Git clean filter for agent/settings.json, registered by `vp install`. Pi keeps one global
// settings file and writes machine-local state into it, so commits and diffs see that file
// without the local state while the working copy keeps it.
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";

const settingsSchema = Type.Record(Type.String(), Type.Unknown());

const packagesSchema = Type.Array(
  Type.Union([Type.String(), Type.Object({ source: Type.String() })]),
);

// Pi installs npm, git, and URL sources the same way on every machine; any other source is a
// path on this machine.
const portableSource = /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git@)/;

export function cleanSettings(text: string): string {
  const settings: unknown = JSON.parse(text);

  if (!Value.Check(settingsSchema, settings))
    throw new Error("agent/settings.json must contain a JSON object");

  // Pi moves $schema when it rewrites the file; pinning it first keeps diffs stable.
  const { $schema, ...rest } = settings;
  const cleaned = $schema === undefined ? rest : { $schema, ...rest };

  // Pi writes this machine's identity and the last changelog it showed.
  delete cleaned.deviceId;
  delete cleaned.lastChangelogVersion;

  if (Object.hasOwn(cleaned, "packages")) {
    const packages = cleaned.packages;

    if (!Value.Check(packagesSchema, packages))
      throw new Error("agent/settings.json packages must list package sources");

    cleaned.packages = packages.filter((entry) =>
      portableSource.test(Value.Check(Type.String(), entry) ? entry : entry.source),
    );
  }

  // The fast-mode toggle saves its state here; the repository default is on.
  const fastMode = cleaned.fastMode;

  if (Value.Check(settingsSchema, fastMode)) cleaned.fastMode = { ...fastMode, enabled: true };

  return `${JSON.stringify(cleaned, null, 2)}\n`;
}

if (import.meta.main) process.stdout.write(cleanSettings(readFileSync(0, "utf8")));
