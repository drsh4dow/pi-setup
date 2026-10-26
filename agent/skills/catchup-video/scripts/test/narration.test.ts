import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { type Beat, narrate, splitPhrases, stripTags, wordsMatch } from "../narration.ts";

const ELEVEN_KEY = "eleven-secret-key-123";
const GEMINI_KEY = "gemini-secret-key-456";

// The stub voice: two tones with a pause between, as a 24 kHz WAV, one length per text, so the
// stub listener can tell which text a clip it hears was made from.
const texts: string[] = [];
function speech(text: string): Buffer {
  if (!texts.includes(text)) texts.push(text);
  const second = 1.2 + 0.5 * texts.indexOf(text);
  return spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    `sine=frequency=220:duration=1.2,apad=pad_dur=0.4[a];sine=frequency=330:duration=${second}[b];[a][b]concat=n=2:v=0:a=1`,
    "-ar", "24000", "-ac", "1", "-f", "wav", "-"], { maxBuffer: 1 << 24 }).stdout;
}
/** The text whose stub clip is closest in length to a 48 kHz WAV the listener sent. */
const textOf = (wav: Buffer) => {
  const secs = (wav.length - 44) / 2 / 48_000;
  return texts.reduce((best, t, i) => (Math.abs(2.8 + 0.5 * i - secs) < Math.abs(2.8 + 0.5 * texts.indexOf(best) - secs) ? t : best), texts[0] ?? "");
};

type Call = { path: string; model: string; key: string | undefined; text: string };

/** A local ElevenLabs and Gemini: each answers with what the test configures. */
function stub(answer: { eleven: (c: Call) => [number, unknown]; tts: (c: Call) => [number, unknown]; heard: (c: Call) => string }) {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const url = req.url ?? "";
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? "elevenlabs";
      const json = JSON.parse(body);
      const parts: unknown = json?.contents?.[0]?.parts;
      const first = Array.isArray(parts) ? parts[0] : undefined;
      const audio = Array.isArray(parts) ? parts[1]?.inlineData?.data : undefined;
      const call: Call = {
        path: url, model, key: String(req.headers["xi-api-key"] ?? req.headers["x-goog-api-key"]),
        // What a TTS request asks to say, or what the clip a listener request carries was made from.
        text: typeof audio === "string" ? textOf(Buffer.from(audio, "base64")) : String(first?.text ?? json?.text ?? ""),
      };
      calls.push(call);
      let status = 200;
      let out: unknown;
      if (model === "elevenlabs") [status, out] = answer.eleven(call);
      else if (model.endsWith("-tts")) [status, out] = answer.tts(call);
      else out = { candidates: [{ content: { parts: [{ text: answer.heard(call) }] } }] };
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  return { calls, server };
}

const audio = (c: Call): [number, unknown] =>
  [200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: speech(c.text).toString("base64") } }] } }] }];
const BEATS: Beat[] = [
  { name: "intro", say: "Fifty gifts load per page, | and search got faster.", show: "50 gifts load per page, | and search got faster.", pause: null },
  { name: "end", say: "That is all for today.", show: "That is all for today.", pause: null },
];

describe("narration falls through its providers", () => {
  let base = "";
  let state: ReturnType<typeof stub>;
  let heard = (_: Call) => "";
  let tts = audio;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-narration-"));
  before(async () => {
    state = stub({
      eleven: (c) => [401, { detail: { status: "payment_issue", message: `key ${c.key} has no credit` } }],
      tts: (c) => tts(c),
      heard: (c) => heard(c),
    });
    await new Promise<void>((done) => state.server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  });
  after(() => state.server.close());

  const run = async (cache: string, beats = BEATS) => {
    const lines: string[] = [];
    const timing = await narrate({
      beats, outDir: path.join(dir, "out"), voice: "Iapetus", offline: false, log: (l) => lines.push(l),
      env: { ELEVENLABS_API_KEY: ELEVEN_KEY, GEMINI_API_KEY: GEMINI_KEY, CATCHUP_VIDEO_CACHE: path.join(dir, cache),
        CATCHUP_ELEVENLABS_URL: base, CATCHUP_GEMINI_URL: base },
    });
    return { timing, log: lines.join("\n") };
  };

  test("ElevenLabs refusing hands the beats to Gemini's Iapetus, and no key reaches the log", async () => {
    heard = (c) => c.text;
    state.calls.length = 0;
    const { timing, log } = await run("a");
    assert.equal(timing.provider, "gemini");
    assert.equal(timing.model, "gemini-3.8-flash-tts");
    assert.equal(timing.voice, "Iapetus");
    assert.equal(state.calls[0]?.model, "elevenlabs");
    assert.ok(!log.includes(ELEVEN_KEY) && !log.includes(GEMINI_KEY), log);
    assert.match(log, /payment_issue/);
    const [intro] = timing.beats;
    assert.deepEqual(intro?.phrases.map((p) => p.text), ["50 gifts load per page,", "and search got faster."]);
    // The break between the two phrases falls in the clip's pause, 1.2 s to 1.6 s into it.
    const at = (intro?.phrases[0]?.end ?? 0) - (intro?.start ?? 0);
    assert.ok(at > 1.15 && at < 1.65, `break at ${at}`);
    assert.ok(fs.existsSync(path.join(dir, "out", "narration.wav")));
    assert.equal(fs.readdirSync(path.join(dir, "a", "tts")).filter((f) => f.endsWith(".pcm")).length, 2);
  });

  test("a second run reads every clip from the cache without asking any provider", async () => {
    const first = await run("a");
    state.calls.length = 0;
    const again = await run("a");
    assert.deepEqual(state.calls, []);
    assert.deepEqual(again.timing, first.timing);
  });

  test("a voice that never says its words falls through both Gemini models to captions only", async () => {
    heard = () => "something else entirely";
    state.calls.length = 0;
    const { timing } = await run("b", BEATS.slice(1));
    assert.equal(timing.provider, "none");
    assert.equal(timing.audio, null);
    const synths = state.calls.filter((c) => c.model.endsWith("-tts")).map((c) => c.model);
    assert.deepEqual(synths, [...Array(4).fill("gemini-3.8-flash-tts"), ...Array(4).fill("gemini-2.5-pro-preview-tts")]);
    assert.ok((timing.beats[0]?.end ?? 0) > (timing.beats[0]?.start ?? 0));
  });

  test("a spent daily quota skips the model without retrying", async () => {
    heard = (c) => c.text;
    tts = (c) => (c.model === "gemini-3.8-flash-tts"
      ? [429, { error: { code: 429, details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] } }]
      : audio(c));
    state.calls.length = 0;
    const { timing } = await run("c", BEATS.slice(1));
    assert.equal(timing.model, "gemini-2.5-pro-preview-tts");
    assert.equal(state.calls.filter((c) => c.model === "gemini-3.8-flash-tts").length, 1);
  });
});

test("caption phrases keep a short sentence with the next and break both texts in the same places", () => {
  const { said, shown } = splitPhrases({
    name: "b", say: "So: merge the cache, review the upload fix, and pick how long to keep logs for thirty days.",
    show: "So: merge the cache, review the upload fix, and pick how long to keep logs for 30 days.",
  });
  assert.deepEqual(said, ["So: merge the cache, review the upload fix,", "and pick how long to keep logs for thirty days."]);
  assert.deepEqual(shown, ["So: merge the cache, review the upload fix,", "and pick how long to keep logs for 30 days."]);
  assert.throws(() => splitPhrases({ name: "x", say: "One, two.", show: "One two." }), /beat x: say and show differ/);
});

test("audio tags come out of the words with the place of every character kept", () => {
  const { text, from } = stripTags("[curious] Fifty gifts, [short pause] and more.");
  assert.equal(text, "Fifty gifts, and more.");
  assert.equal(from.length, text.length);
  assert.equal("[curious] Fifty gifts, [short pause] and more."[from[text.indexOf("and")] ?? 0], "a");
});

describe("a beat's audio tags", () => {
  // The stub ElevenLabs times every character it was sent, tags included, as the real one does:
  // the first phrase over the first tone, the rest over the second.
  const said: string[] = [];
  const eleven = (c: Call): [number, unknown] => {
    said.push(c.text);
    const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "-"],
      { input: speech(c.text), maxBuffer: 1 << 24 }).stdout;
    const cut = c.text.indexOf(",") + 1;
    const chars = [...c.text];
    const ends = chars.map((_, i) => (i < cut ? (1.2 * (i + 1)) / cut : 1.6 + (1.0 * (i + 1 - cut)) / (chars.length - cut)));
    return [200, { audio_base64: pcm.toString("base64"), alignment: { characters: chars, character_end_times_seconds: ends } }];
  };
  const { server } = stub({ eleven, tts: audio, heard: (c) => c.text });
  after(() => server.close());

  test("reach ElevenLabs and nothing else: captions, cue words, and phrase timing come from the spoken words", async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-tags-"));
    const timing = await narrate({
      beats: [{ name: "tagged", say: "[curious] Fifty gifts load per page, | [short pause] and search got faster.",
        show: "50 gifts load per page, | and search got faster.", pause: null }],
      outDir: path.join(dir, "out"), voice: "Iapetus", offline: false, log: () => {},
      env: { ELEVENLABS_API_KEY: ELEVEN_KEY, CATCHUP_VIDEO_CACHE: dir, CATCHUP_ELEVENLABS_URL: base },
    });
    assert.deepEqual(said, ["[curious] Fifty gifts load per page, [short pause] and search got faster."]);
    assert.equal(timing.provider, "elevenlabs");
    assert.equal(timing.model, "eleven_v4");
    const [beat] = timing.beats;
    assert.equal(beat?.say, "Fifty gifts load per page, and search got faster.");
    assert.deepEqual(beat?.phrases.map((p) => [p.text, p.said]), [
      ["50 gifts load per page,", "Fifty gifts load per page,"], ["and search got faster.", "and search got faster."]]);
    // The break is where the comma was spoken, not shifted by the tag characters before it.
    const at = (beat?.phrases[0]?.end ?? 0) - (beat?.start ?? 0);
    assert.ok(at > 1.0 && at < 1.3, `break at ${at}`);
  });
});

describe("hearing the words a beat should say", () => {
  const said = "The draft said a revert undoes it. AWS blocks old Node, so rollback now restores version five.";

  test("a transcriber's split and joined words still match", () => {
    const heard = "The draft said a revert undoes it. A WS blocks old node, so roll back now restores version five.";

    assert.ok(wordsMatch(said, heard) >= 0.97, `${wordsMatch(said, heard)}`);
    assert.equal(wordsMatch("Approve the monorepo pair.", "Approve the mono repo pair."), 1);
  });

  test("a replaced, dropped, or added word does not", () => {
    for (const heard of [
      said.replace("five", "nine"),
      said.replace(" now", ""),
      `Thoughtful. ${said}`,
    ]) assert.ok(wordsMatch(said, heard) < 0.97, `${heard}: ${wordsMatch(said, heard)}`);
  });
});
