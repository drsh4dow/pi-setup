/**
 * The narration pipeline, free of any animation engine: beats in, one audio timeline and a
 * timing file out. Providers, each falling through to the next for the whole run:
 *   1. ElevenLabs with character timestamps (ELEVENLABS_API_KEY, voice ELEVENLABS_VOICE_ID)
 *   2. Gemini TTS, gemini-3.8-flash-tts then gemini-2.5-pro-preview-tts (GEMINI_API_KEY), in the
 *      story's voice (Iapetus by default); every clip is transcribed and checked against its
 *      words, and re-synthesized when it fails
 *   3. none: captions only, each phrase held for a calm reading pace
 * A provider that refuses (a bad key, no credit, a spent daily quota) is skipped at once.
 * Clips are cached by the hash of text, provider, model, and voice. Keys travel only in request
 * headers and are scrubbed from every message.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Beat = { name: string; say: string; show: string; pause: number | null };
export type Phrase = { text: string; said: string; start: number; end: number };
export type TimedBeat = { name: string; say: string; start: number; end: number; phrases: Phrase[] };
export type ProviderName = "elevenlabs" | "gemini" | "none";
export type Timing = {
  provider: ProviderName;
  model: string | null;
  voice: string | null;
  total: number;
  audio: string | null;
  beats: TimedBeat[];
};
export type Env = Readonly<Record<string, string | undefined>>;
export type NarrateOptions = {
  beats: readonly Beat[];
  outDir: string;
  voice: string;
  env: Env;
  /** Use cached clips only; never call a provider. */
  offline: boolean;
  log: (line: string) => void;
};

const RATE = 48_000;
const LEAD_IN = 0.6;
const TAIL = 1.5;
const DEFAULT_PAUSE = 0.5;
const READING_WORDS_PER_SEC = 2.6;
const MIN_PHRASE_SEC = 1.4;
const CAPTION_CHARS = 56;
const ATTEMPTS = 4;
const PARALLEL = 3;
const PASS_SCORE = 0.97;
const JUDGE_SCORE = 0.8;
const CHECK_MODEL = "gemini-3.8-flash";
const GEMINI_MODELS = ["gemini-3.8-flash-tts", "gemini-2.5-pro-preview-tts"];
const ELEVEN_MODEL = "eleven_multilingual_v2";
/** Bump when the processing of a cached clip changes, so old clips are made again. */
const CLIP_FORMAT = 2;

/** A timing file this module wrote, read back. */
export function parseTiming(data: unknown): Timing {
  const beats = dig(data, "beats");
  const total = dig(data, "total");
  if (!Array.isArray(beats) || typeof total !== "number") throw new Error("not a timing file: no beats or total");
  const provider = dig(data, "provider");
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    provider: provider === "elevenlabs" || provider === "gemini" ? provider : "none",
    model: text(dig(data, "model")), voice: text(dig(data, "voice")), audio: text(dig(data, "audio")), total,
    beats: beats.map((b: unknown): TimedBeat => {
      const phrases = dig(b, "phrases");
      return {
        name: String(dig(b, "name")), say: String(dig(b, "say")), start: Number(dig(b, "start")), end: Number(dig(b, "end")),
        phrases: (Array.isArray(phrases) ? phrases : []).map((p: unknown): Phrase => ({
          text: String(dig(p, "text")), said: String(dig(p, "said")), start: Number(dig(p, "start")), end: Number(dig(p, "end")),
        })),
      };
    }),
  };
}

export const cacheRoot = (env: Env) => env.CATCHUP_VIDEO_CACHE ?? join(homedir(), ".cache", "catchup-video");

// ---- phrases ----------------------------------------------------------------------

type Piece = { text: string; end: "hard" | "sentence" | "comma" };

/** Words cut after every comma, sentence end (. ? ! :), and "|". */
function pieces(text: string): Piece[] {
  return text.split("|").flatMap((part) => {
    const sentences = part.trim().split(/(?<=[.?!:])\s+/).filter((x) => x.trim());
    return sentences.flatMap((sentence, si) => {
      const commas = sentence.trim().split(/(?<=,)\s+/);
      return commas.map((piece, ci): Piece => ({
        text: piece,
        end: ci < commas.length - 1 ? "comma" : si < sentences.length - 1 ? "sentence" : "hard",
      }));
    });
  });
}

/** Caption phrases for the spoken and the shown words, cut at the same boundaries, so digits in
 *  a caption never shift a break. A phrase ends at a sentence once it is 18 characters long, and
 *  at a comma when the next piece would take it past 56; a "|" ends one in both. */
export function splitPhrases(beat: Pick<Beat, "name" | "say" | "show">): { said: string[]; shown: string[] } {
  const a = pieces(beat.say);
  const b = pieces(beat.show);
  if (a.length !== b.length || a.some((p, i) => p.end !== b[i]?.end)) {
    throw new Error(`beat ${beat.name}: say and show differ in sentences or commas; mark breaks with "|" in both`);
  }
  const said: string[] = [];
  const shown: string[] = [];
  let from = 0;
  for (const [k, p] of a.entries()) {
    const len = a.slice(from, k + 1).map((x) => x.text).join(" ").length;
    const next = a[k + 1]?.text.length ?? 0;
    const full = len >= 18 && (p.end === "sentence" || len + 1 + next > CAPTION_CHARS);
    if (p.end === "hard" || full) {
      said.push(a.slice(from, k + 1).map((x) => x.text).join(" "));
      shown.push(b.slice(from, k + 1).map((x) => x.text).join(" "));
      from = k + 1;
    }
  }
  return { said, shown };
}

const clean = (text: string) => text.replaceAll("|", " ").replace(/\s+/g, " ").trim();

// ---- audio ------------------------------------------------------------------------

function ffmpeg(args: string[]): string {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${(run.stderr ?? run.error?.message ?? "").slice(-600)}`);
  return run.stderr;
}

const PCM_IN = ["-f", "s16le", "-ar", String(RATE), "-ac", "1"];

export function silences(input: string[], noise = "-34dB", min = 0.11): { start: number; end: number }[] {
  const log = ffmpeg([...input, "-af", `silencedetect=noise=${noise}:d=${min}`, "-f", "null", "-"]);
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of log.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s?.[1]) open = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e?.[1] && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: Number.POSITIVE_INFINITY });
  return out;
}

/** Where speech starts and ends in 48 kHz s16le samples, in seconds: the first and last 10 ms
 *  frame louder than -36 dBFS with speech in most of the 50 ms after it, so a click or a breath
 *  at the edge is not taken for a word. */
export function speechSpan(pcm: Buffer): { start: number; end: number } {
  const step = RATE / 100;
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const loud: boolean[] = [];
  for (let at = 0; at + step <= samples.length; at += step) {
    let sum = 0;
    for (let i = at; i < at + step; i++) sum += (samples[i] ?? 0) ** 2;
    loud.push(Math.sqrt(sum / step) / 32768 > 10 ** (-36 / 20));
  }
  const sustained = (k: number, dir: 1 | -1) => {
    let n = 0;
    for (let d = 0; d < 5; d++) if (loud[k + dir * d]) n++;
    return loud[k] === true && n >= 3;
  };
  let first = loud.findIndex((_, k) => sustained(k, 1));
  if (first < 0) first = 0;
  let last = loud.length - 1;
  while (last > first && !sustained(last, -1)) last--;
  return { start: first / 100, end: (last + 1) / 100 };
}

/** Even out loudness, resample to 48 kHz mono, and cut the silence at both edges. Returns raw
 *  s16le samples and the seconds cut from the head. */
function normalize(input: string[], tmp: string): { pcm: Buffer; lead: number } {
  const out = join(tmp, "clip.pcm");
  ffmpeg([...input, "-af", "loudnorm=I=-17:TP=-1.5:LRA=7", "-ar", String(RATE), "-ac", "1", "-f", "s16le", out]);
  const pcm = readFileSync(out);
  const span = speechSpan(pcm);
  const from = Math.max(0, span.start - 0.04);
  const to = Math.min(seconds(pcm), span.end + 0.12);
  return { pcm: pcm.subarray(Math.round(from * RATE) * 2, Math.round(to * RATE) * 2), lead: from };
}

export function wav(pcm: Buffer, rate = RATE): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

const seconds = (pcm: Buffer) => pcm.length / 2 / RATE;
const silence = (sec: number) => Buffer.alloc(Math.round(sec * RATE) * 2);

// ---- http -------------------------------------------------------------------------

/** The provider refused (auth, billing, a bad request): retrying will not help. */
class Refused extends Error {}

const redact = (message: string, keys: readonly string[]) =>
  keys.reduce((m, key) => (key ? m.replaceAll(key, "[key]") : m), message);

/** A field deep inside parsed JSON, or undefined. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = Reflect.get(at, key);
  }
  return at;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url: string, headers: Record<string, string>, body: unknown, keys: string[]): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    let wait = 1500 * (attempt + 1);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const where = new URL(url).pathname;
      if (res.ok) return JSON.parse(text);
      last = redact(`HTTP ${res.status} from ${where}: ${text.replace(/\s+/g, " ").slice(0, 300)}`, keys);
      // A rate limit says how long to wait; a spent daily quota will not recover within the run.
      if (res.status === 429 && /PerDay/.test(text)) throw new Refused(last);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new Refused(last);
      const delay = /"retryDelay":\s*"([\d.]+)s"/.exec(text)?.[1];
      if (res.status === 429) wait = Math.min(60_000, 1000 * Number(delay ?? 20) + 500);
    } catch (error) {
      if (error instanceof Refused) throw error;
      last = redact(error instanceof Error ? error.message : String(error), keys);
    }
    await sleep(wait);
  }
  throw new Error(last);
}

// ---- providers --------------------------------------------------------------------

type Clip = { pcm: Buffer; charEnds: number[] | null; transcript: string | null };
type Voice = { provider: Exclude<ProviderName, "none">; model: string; voice: string };
type Provider = Voice & { synth: (say: string, tmp: string) => Promise<Clip> };

function voices(env: Env, voice: string): Voice[] {
  return [
    { provider: "elevenlabs", model: ELEVEN_MODEL, voice: env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb" },
    ...GEMINI_MODELS.map((model): Voice => ({ provider: "gemini", model, voice })),
  ];
}

function elevenLabs(v: Voice, key: string, env: Env): Provider {
  const base = env.CATCHUP_ELEVENLABS_URL ?? "https://api.elevenlabs.io";
  return {
    ...v,
    async synth(say, tmp) {
      const data = await postJson(`${base}/v1/text-to-speech/${v.voice}/with-timestamps?output_format=pcm_24000`,
        { "xi-api-key": key }, { text: say, model_id: v.model }, [key]);
      const audio = dig(data, "audio_base64");
      const ends = dig(data, "alignment", "character_end_times_seconds");
      if (typeof audio !== "string" || !Array.isArray(ends)) throw new Error("ElevenLabs answered without audio");
      const raw = join(tmp, "eleven.pcm");
      writeFileSync(raw, Buffer.from(audio, "base64"));
      const { pcm, lead } = normalize(["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", raw], tmp);
      return { pcm, charEnds: ends.map((t) => Number(t) - lead), transcript: null };
    },
  };
}

const wordsOf = (text: string) => text.toLowerCase().replaceAll("-", " ").replaceAll("'", "").match(/[a-z0-9]+/g) ?? [];

/** How closely `heard` matches `expected`, 0..1, with a penalty per extra word (a spoken
 *  style instruction shows up as extra words). */
export function wordsMatch(expected: string, heard: string): number {
  const a = wordsOf(expected);
  const b = wordsOf(heard);
  if (b.length === 0) return 0;
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = lcs[i] ?? [];
      row[j] = a[i - 1] === b[j - 1] ? (lcs[i - 1]?.[j - 1] ?? 0) + 1 : Math.max(lcs[i - 1]?.[j] ?? 0, row[j - 1] ?? 0);
    }
  }
  const common = lcs[a.length]?.[b.length] ?? 0;
  return (2 * common) / (a.length + b.length) - 0.05 * Math.max(0, b.length - a.length);
}

export type Listener = { listen: (pcm: Buffer, expected: string) => Promise<{ ok: boolean; heard: string }> };

/** Transcribes speech with Gemini and judges it against the words it should say. */
export function geminiListener(key: string, env: Env): Listener {
  const base = env.CATCHUP_GEMINI_URL ?? "https://generativelanguage.googleapis.com";
  const ask = async (prompt: string, pcm: Buffer) => {
    const data = await postJson(`${base}/v1beta/models/${CHECK_MODEL}:generateContent`, { "x-goog-api-key": key }, {
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wav(pcm).toString("base64") } }] }],
      generationConfig: { temperature: 0 },
    }, [key]);
    const parts = dig(data, "candidates", 0, "content", "parts");
    return Array.isArray(parts) ? parts.map((p: unknown) => String(dig(p, "text") ?? "")).join("").trim() : "";
  };
  return {
    async listen(pcm, expected) {
      const heard = await ask("Transcribe this speech verbatim. Write every number as words, exactly as spoken. " +
        "Output only the transcript.", pcm);
      const score = wordsMatch(expected, heard);
      if (score >= PASS_SCORE) return { ok: true, heard };
      if (score < JUDGE_SCORE) return { ok: false, heard };
      const verdict = await ask("Does the speaker say exactly these words, in this order, with no word added, " +
        "dropped, or replaced, and nothing else? Ignore spelling of names and digits versus words.\n\n" +
        `Expected: ${expected}\n\nAnswer YES or NO.`, pcm);
      return { ok: /^\W*yes/i.test(verdict), heard };
    },
  };
}

function gemini(v: Voice, key: string, env: Env, log: (line: string) => void): Provider {
  const base = env.CATCHUP_GEMINI_URL ?? "https://generativelanguage.googleapis.com";
  const ears = geminiListener(key, env);
  return {
    ...v,
    async synth(say, tmp) {
      let heard = "";
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const data = await postJson(`${base}/v1beta/models/${v.model}:generateContent`, { "x-goog-api-key": key }, {
          contents: [{ parts: [{ text: say }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voice } } },
          },
        }, [key]);
        const parts = dig(data, "candidates", 0, "content", "parts");
        const inline = Array.isArray(parts) ? parts.map((p: unknown) => dig(p, "inlineData")).find(Boolean) : undefined;
        const mime = dig(inline, "mimeType");
        const audio = dig(inline, "data");
        if (typeof mime !== "string" || typeof audio !== "string") throw new Error(`${v.model} answered without audio`);
        const isWav = mime.includes("wav");
        const raw = join(tmp, isWav ? "gemini.wav" : "gemini.pcm");
        writeFileSync(raw, Buffer.from(audio, "base64"));
        const rate = /rate=(\d+)/.exec(mime)?.[1] ?? "24000";
        const { pcm } = normalize(isWav ? ["-i", raw] : ["-f", "s16le", "-ar", rate, "-ac", "1", "-i", raw], tmp);
        const check = await ears.listen(pcm, say);
        if (check.ok) return { pcm, charEnds: null, transcript: check.heard };
        heard = check.heard;
        log(`  re-synthesizing, attempt ${attempt} heard: ${heard.slice(0, 100)}`);
      }
      throw new Error(`clip never matched its words; last heard: ${heard.slice(0, 160)}`);
    },
  };
}

function providers(env: Env, voice: string, log: (line: string) => void): Provider[] {
  const out: Provider[] = [];
  for (const v of voices(env, voice)) {
    if (v.provider === "gemini" && env.GEMINI_API_KEY) out.push(gemini(v, env.GEMINI_API_KEY, env, log));
    if (v.provider === "elevenlabs" && env.ELEVENLABS_API_KEY) out.push(elevenLabs(v, env.ELEVENLABS_API_KEY, env));
  }
  return out;
}

// ---- timeline ---------------------------------------------------------------------

type Cached = { pcm: Buffer; charEnds: number[] | null };

function cachePaths(env: Env, v: Voice, say: string) {
  const dir = join(cacheRoot(env), "tts");
  const hash = createHash("sha256").update(JSON.stringify([CLIP_FORMAT, say, v.provider, v.model, v.voice])).digest("hex").slice(0, 32);
  return { dir, pcm: join(dir, `${hash}.pcm`), meta: join(dir, `${hash}.json`) };
}

function fromCache(env: Env, v: Voice, say: string): Cached | null {
  const at = cachePaths(env, v, say);
  if (!existsSync(at.pcm) || !existsSync(at.meta)) return null;
  const ends = dig(JSON.parse(readFileSync(at.meta, "utf8")), "charEnds");
  return { pcm: readFileSync(at.pcm), charEnds: Array.isArray(ends) ? ends.map(Number) : null };
}

async function clip(p: Provider, say: string, env: Env): Promise<Cached> {
  const hit = fromCache(env, p, say);
  if (hit) return hit;
  const tmp = mkdtempSync(join(tmpdir(), "catchup-tts-"));
  try {
    const made = await p.synth(say, tmp);
    const at = cachePaths(env, p, say);
    mkdirSync(at.dir, { recursive: true });
    writeFileSync(at.pcm, made.pcm);
    writeFileSync(at.meta, JSON.stringify({ say, charEnds: made.charEnds, transcript: made.transcript }));
    return { pcm: made.pcm, charEnds: made.charEnds };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      const item = items[i];
      try {
        if (item !== undefined) out[i] = await fn(item);
      } catch (error) {
        failed = true; // the provider is falling through: start no more requests to it
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Where each phrase ends inside a clip: from character timings when the provider gave them,
 *  else estimated by spoken characters and snapped to the nearest pause the speaker took.
 *  null: the speaker did not pause there, so the phrase runs on into the next one. */
function phraseEnds(said: string[], say: string, c: Cached): (number | null)[] {
  const dur = seconds(c.pcm);
  if (c.charEnds) {
    let pos = 0;
    return said.map((p, i) => {
      pos = say.indexOf(p, pos) + p.length;
      return i === said.length - 1 ? dur : Math.min(dur, c.charEnds?.[Math.max(0, pos - 1)] ?? dur);
    });
  }
  const tmp = mkdtempSync(join(tmpdir(), "catchup-ph-"));
  try {
    writeFileSync(join(tmp, "c.pcm"), c.pcm);
    const gaps = silences([...PCM_IN, "-i", join(tmp, "c.pcm")])
      .filter((s) => s.start > 0.2 && s.end < dur - 0.1)
      .map((s) => (s.start + s.end) / 2);
    const weights = said.map((p) => p.length + 6);
    const total = weights.reduce((a, b) => a + b, 0);
    const ends: (number | null)[] = [];
    let acc = 0;
    let prev = 0;
    for (const w of weights.slice(0, -1)) {
      acc += w;
      const guess = (acc / total) * dur;
      const near = gaps.filter((g) => Math.abs(g - guess) < 1.0 && g > prev + 0.3);
      const gap = near.sort((x, y) => Math.abs(x - guess) - Math.abs(y - guess))[0] ?? null;
      ends.push(gap);
      if (gap !== null) prev = gap;
    }
    return [...ends, dur];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function lay(beats: readonly Beat[], spans: (b: Beat, said: string[]) => (number | null)[]): { beats: TimedBeat[]; total: number } {
  let t = LEAD_IN;
  const out = beats.map((b, i) => {
    if (i > 0) t += b.pause ?? DEFAULT_PAUSE;
    const { said, shown } = splitPhrases(b);
    const ends = spans(b, said);
    const start = t;
    const phrases: Phrase[] = [];
    let open = { text: [] as string[], said: [] as string[], start: 0 };
    for (const [k, text] of shown.entries()) {
      open.text.push(text);
      open.said.push(said[k] ?? text);
      const end = k === shown.length - 1 ? (ends[k] ?? 0) : ends[k];
      if (end === null || end === undefined) continue;
      phrases.push({ text: open.text.join(" "), said: open.said.join(" "), start: round(start + open.start), end: round(start + end) });
      open = { text: [], said: [], start: end };
    }
    t += phrases.length ? (ends.at(-1) ?? 0) : 0;
    return { name: b.name, say: clean(b.say), start: round(start), end: round(t), phrases };
  });
  return { beats: out, total: round(t + TAIL) };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Captions only: each phrase held for its words at a calm reading pace. */
export function readingTimeline(beats: readonly Beat[]): Timing {
  const laid = lay(beats, (_b, said) => {
    let acc = 0;
    return said.map((p) => (acc += Math.max(MIN_PHRASE_SEC, p.split(/\s+/).length / READING_WORDS_PER_SEC)));
  });
  return { provider: "none", model: null, voice: null, audio: null, ...laid };
}

export async function narrate(o: NarrateOptions): Promise<Timing> {
  mkdirSync(o.outDir, { recursive: true });
  const beats = o.beats;
  for (const b of beats) splitPhrases(b);
  // A voice with every clip cached plays without a request, so a rerun never waits on a
  // provider; the first fully cached voice in provider order wins.
  const cached = voices(o.env, o.voice).flatMap((v) => {
    const clips = beats.map((b) => fromCache(o.env, v, clean(b.say)));
    return clips.every((c) => c !== null) ? [{ ...v, make: async () => clips.filter((c) => c !== null) }] : [];
  }).slice(0, 1);
  const chain: (Voice & { make: () => Promise<Cached[]> })[] = cached.length || o.offline
    ? cached
    : providers(o.env, o.voice, o.log).map((p) => ({ ...p, make: () => mapLimit(beats, PARALLEL, (b) => clip(p, clean(b.say), o.env)) }));
  for (const p of chain) {
    try {
      if (!cached.length) o.log(`narration: trying ${p.provider} ${p.model}, voice ${p.voice}`);
      const clips = await p.make();
      const laid = lay(beats, (b, said) => {
        const c = clips[beats.indexOf(b)];
        return c ? phraseEnds(said, clean(b.say), c) : [];
      });
      const parts: Buffer[] = [silence(LEAD_IN)];
      for (const [i, c] of clips.entries()) {
        if (i > 0) parts.push(silence(beats[i]?.pause ?? DEFAULT_PAUSE));
        parts.push(c.pcm);
      }
      parts.push(silence(TAIL));
      writeFileSync(join(o.outDir, "narration.wav"), wav(Buffer.concat(parts)));
      const timing: Timing = { provider: p.provider, model: p.model, voice: p.voice, audio: "narration.wav", ...laid };
      writeFileSync(join(o.outDir, "timing.json"), JSON.stringify(timing, null, 2));
      o.log(`narration: ${p.provider} ${p.model}, voice ${p.voice}, ${timing.total.toFixed(1)}s`);
      return timing;
    } catch (error) {
      if (!o.offline) o.log(`narration: ${p.provider} ${p.model} failed, falling through: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  o.log(o.offline ? "narration: no cached voice for these words; timed at reading pace (run narrate for the voice)"
    : "narration: no voice provider worked; captions only");
  const timing = readingTimeline(beats);
  writeFileSync(join(o.outDir, "timing.json"), JSON.stringify(timing, null, 2));
  return timing;
}
