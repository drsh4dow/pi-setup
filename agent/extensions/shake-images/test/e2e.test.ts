import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import {
  capture,
  e2eUnavailable,
  isDead,
  type PiSession,
  prompt,
  readStderr,
  runTask,
  sendKeys,
  startPi,
  stop,
  waitFor,
  waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

/** 1x1 PNGs (red, green, blue) — three distinct real images, no fixture files. */
const PNG_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  [
    "shot-a.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ],
  [
    "shot-b.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
  ],
  [
    "shot-c.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  ],
];

/**
 * Counts image blocks the agent actually put in context. The harness parks the
 * throwaway session log next to the workspace, and the log keeps the original
 * (unpruned) messages, which is exactly what the context hook receives.
 */
function imageBlocksInTranscript(session: PiSession): number {
  const directory = join(session.cwd, "..", "sessions");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .reduce(
      (total, name) =>
        total +
        (readFileSync(join(directory, name), "utf8").match(/"type":"image"/g)
          ?.length ?? 0),
      0,
    );
}

describe("shake-images (real pi in tmux)", { skip }, () => {
  let session: PiSession;

  before(async () => {
    session = await startPi();
    // Written as bytes: the harness `files` option pipes strings, which would
    // corrupt PNG data.
    for (const [name, base64] of PNG_FIXTURES) {
      writeFileSync(join(session.cwd, name), Buffer.from(base64, "base64"));
    }
  });

  after(async () => {
    if (session) await stop(session);
  });

  test("registers /shake-images with its description", async () => {
    assert.equal(isDead(session), false);
    assert.doesNotMatch(readStderr(session), /uncaughtException/);

    const banner = capture(session, true);
    assert.match(
      banner,
      /\[Extensions\][\s\S]*shake-images/,
      `shake-images missing from the startup extension list:\n${banner}`,
    );

    await sendKeys(session, "-l", "/shake-im");
    const pane = await waitFor(
      session,
      /shake-images\s+.*Keep only the latest two images/,
      {
        description: "/shake-images completion entry",
      },
    );
    assert.match(pane, /Keep only the latest two images in model context/);

    // Dismiss the completion popup and clear the prompt so the next test types
    // into an empty input.
    await sendKeys(session, "Escape");
    await sendKeys(session, "C-u");
    await waitFor(session, (text) => !text.includes("/shake-im"), {
      description: "prompt input to clear",
      timeoutMs: 15_000,
    });
  });

  test("/shake-images notifies that pruning is enabled", async () => {
    await prompt(session, "/shake-images");
    const pane = await waitFor(
      session,
      /Image context pruned to the latest two images/,
      { scrollback: true, description: "/shake-images notification" },
    );
    assert.match(pane, /Image context pruned to the latest two images/);
    assert.equal(isDead(session), false);
    assert.doesNotMatch(readStderr(session), /uncaughtException/);
  });

  test("a turn that loads three images still completes with pruning on", async () => {
    // With pruning enabled the context hook rewrites every request after the
    // third image lands, so this turn only finishes if the pruned transcript is
    // still a valid conversation.
    await runTask(
      session,
      "Use the read tool on shot-a.png, then shot-b.png, then shot-c.png. " +
        "After reading all three, create a file named shake-e2e.txt whose entire contents are exactly: shake-e2e-ok",
      300_000,
    );

    assert.equal(
      (await waitForFile(session, "shake-e2e.txt", 30_000)).trim(),
      "shake-e2e-ok",
    );

    const pane = capture(session, true);
    for (const [name] of PNG_FIXTURES) {
      assert.match(
        pane,
        new RegExp(`read ${name.replace(".", "\\.")}`),
        `no read tool call for ${name}:\n${pane}`,
      );
    }

    // The prune path only engages once a third image block is in context, so
    // the assertion above is only meaningful if `read` really produced images.
    assert.ok(
      imageBlocksInTranscript(session) >= 3,
      "expected at least three image blocks in the session transcript; " +
        "without them the context hook never had anything to prune",
    );

    assert.equal(isDead(session), false);
    assert.doesNotMatch(readStderr(session), /uncaughtException/);
  });

  test("shuts down cleanly with the session_shutdown hook registered", async () => {
    // session_shutdown removes the extension's temp image directory; a throw
    // there would surface on stderr as pi tears down.
    await prompt(session, "/quit");
    await waitFor(session, () => isDead(session), {
      description: "pi to exit after /quit",
      timeoutMs: 30_000,
    });
    assert.doesNotMatch(readStderr(session), /uncaughtException/);
    assert.doesNotMatch(readStderr(session), /ENOENT|EACCES/);
  });
});
