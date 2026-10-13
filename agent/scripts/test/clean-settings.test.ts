import assert from "node:assert/strict";
import test from "node:test";
import { cleanSettings } from "../clean-settings.ts";

test("committed settings keep shared defaults and drop machine-local state", () => {
  const local = {
    fastMode: { enabled: false, providers: { anthropic: { models: ["claude-opus-5-5"] } } },
    $schema: "https://pi.dev/schemas/settings.schema.json",
    lastChangelogVersion: "1.2.0",
    packages: [
      "../../Projects/example/.pi",
      "/opt/pi-tools",
      "npm:@example/pi-tools@1.0.0",
      { source: "git:github.com/example/pi-tools@v1", skills: [] },
      { source: "./local-package" },
    ],
    defaultModel: "claude-opus-5-5",
    deviceId: "56db2cc9-59f0-4dbf-b318-126c9049b11c",
  };

  const committed = cleanSettings(JSON.stringify(local));

  assert.equal(
    committed,
    `${JSON.stringify(
      {
        $schema: "https://pi.dev/schemas/settings.schema.json",
        fastMode: { enabled: true, providers: { anthropic: { models: ["claude-opus-5-5"] } } },
        packages: [
          "npm:@example/pi-tools@1.0.0",
          { source: "git:github.com/example/pi-tools@v1", skills: [] },
        ],
        defaultModel: "claude-opus-5-5",
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(cleanSettings(committed), committed, "cleaning a committed file changes nothing");
});
