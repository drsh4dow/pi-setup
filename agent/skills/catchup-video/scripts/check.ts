/**
 * The check after a render. It reads the geometry the clock recorded from Manim at every beat's
 * midpoint and end, writes those frames from the video, and, for a voiced final render, measures
 * the captions against the audio and has the narration transcribed against its beats. Every
 * problem is one line that names the beat and the element.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot, dig, type Env, geminiListener, type Listener, type Timing } from "./narration.ts";

/** Smallest em size, in pixels at 1080p, that each kind of text may have on screen. */
export const MIN_PX: Readonly<Record<string, number>> = { caption: 44, label: 36, number: 48, code: 32 };
/** The burned-in captions: em size, ASS font size (Inter's line is 1.21 em), and margin. */
export const CAPTION = { em: 48, assSize: 58, marginV: 40, lines: 2 } as const;
/** Content must stay above the caption band, which two caption lines can fill. */
export const BAND_TOP = 1080 - CAPTION.marginV - CAPTION.lines * CAPTION.assSize - 4;
const SLACK = 6;

type Box = [number, number, number, number];
type Point = [number, number];
export type Element = { name: string; box: Box; seg?: [Point, Point]; over: number[]; texts: [string, number, string, Box][] };
export type Probe = { beat: number; name: string; kind: "mid" | "end"; frame: number; skipped: boolean; elements: Element[] };
export type Note = { beat: number; name: string; kind: "note"; problem: boolean; message: string };
export type Start = { beat: number; name: string; kind: "start"; frame: number };
export type Probes = { fps: number; records: (Probe | Note | Start)[] };

export function readProbes(files: string[]): Probes {
  const out: Probes = { fps: 0, records: [] };
  for (const file of files) {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    const fps = dig(data, "fps");
    const records = dig(data, "records");
    if (typeof fps !== "number" || !Array.isArray(records)) throw new Error(`${file} is not a probes file`);
    out.fps = fps;
    out.records.push(...records.filter(isRecord));
  }
  out.records.sort((a, b) => a.beat - b.beat);
  return out;
}

function isRecord(r: unknown): r is Probe | Note | Start {
  const kind = dig(r, "kind");
  return typeof dig(r, "beat") === "number" && typeof dig(r, "name") === "string" &&
    (kind === "mid" || kind === "end" || kind === "note" || kind === "start");
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > SLACK && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > SLACK;

function segmentHits(seg: [Point, Point], box: Box): boolean {
  const [[x0, y0], [x1, y1]] = seg;
  const inner: Box = [box[0] + SLACK, box[1] + SLACK, box[2] - SLACK, box[3] - SLACK];
  let lo = 0;
  let hi = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 - inner[0]], [dx, inner[2] - x0], [-dy, y0 - inner[1]], [dy, inner[3] - y0]] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
    }
  }
  return lo < hi;
}

/** Overlaps, frame exits, caption-band intrusions, and text below its minimum, by beat and element. */
export function geometryProblems(probes: Probes): string[] {
  const found = new Map<string, string[]>();
  const add = (p: { beat: number; name: string }, when: string, message: string) => {
    const key = `beat ${p.beat} (${p.name}): ${message}`;
    found.set(key, [...(found.get(key) ?? []), when]);
  };
  for (const r of probes.records) {
    if (r.kind === "note") {
      if (r.problem) add(r, "", r.message);
      continue;
    }
    if (r.kind !== "mid" && r.kind !== "end") continue;
    if (r.skipped) continue;
    const els = r.elements;
    for (const [i, e] of els.entries()) {
      const [x0, y0, x1, y1] = e.box;
      const out = [["left", -x0], ["top", -y0], ["right", x1 - 1920], ["bottom", y1 - 1080]] as const;
      for (const [side, by] of out) if (by > 2) add(r, r.kind, `${e.name} leaves the frame on the ${side} by ${Math.round(by)} px`);
      if (y1 - BAND_TOP > 2 && y1 <= 1080 + 2) add(r, r.kind, `${e.name} reaches ${Math.round(y1 - BAND_TOP)} px into the caption band`);
      for (const [kind, em, words] of e.texts) {
        const min = MIN_PX[kind] ?? MIN_PX.label ?? 0;
        if (em < min - 0.5) add(r, r.kind, `${e.name}: ${kind} text "${words}" is ${Math.round(em)} px, below the ${min} px minimum`);
      }
      for (const [a, ta] of e.texts.entries()) {
        for (const tb of e.texts.slice(a + 1)) {
          if (overlaps(ta[3], tb[3])) add(r, r.kind, `${e.name}: text "${ta[2]}" overlaps text "${tb[2]}"`);
        }
      }
      for (const [j, f] of els.entries()) {
        if (j <= i || e.over.includes(j) || f.over.includes(i)) continue;
        let textHit = false;
        for (const ta of e.texts) {
          for (const tb of f.texts) {
            if (!overlaps(ta[3], tb[3])) continue;
            textHit = true;
            add(r, r.kind, `text "${ta[2]}" of ${e.name} overlaps text "${tb[2]}" of ${f.name}`);
          }
        }
        if (textHit) continue;
        let hit: boolean;
        if (e.seg && f.seg) hit = false;
        else if (e.seg) hit = segmentHits(e.seg, f.box);
        else if (f.seg) hit = segmentHits(f.seg, e.box);
        else hit = overlaps(e.box, f.box);
        if (hit) add(r, r.kind, `${e.name} overlaps ${f.name}`);
      }
    }
  }
  return [...found].map(([key, whens]) => {
    const at = [...new Set(whens.filter(Boolean))];
    return at.length ? key.replace("): ", `) ${at.join(" and ")}: `) : key;
  });
}

// ---- frames -----------------------------------------------------------------------

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr ?? r.error?.message ?? "").slice(-400)}`);
  return r.stdout;
}

export type Shot = { beat: number; name: string; kind: "mid" | "end"; file: string };

/** One PNG per beat at its midpoint and its end, and contact sheets of four beats each. */
export function writeFrames(video: string, probes: Probes, dir: string): { shots: Shot[]; sheets: string[] } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const first = probes.records.find((r): r is Start => r.kind === "start")?.frame ?? 0;
  const shots: Shot[] = [];
  for (const r of probes.records) {
    if (r.kind !== "mid" && r.kind !== "end") continue;
    const frame = (r.kind === "mid" ? r.frame : r.frame - 1) - first;
    const file = join(dir, `beat-${String(r.beat).padStart(2, "0")}-${r.kind}.png`);
    run("ffmpeg", ["-v", "error", "-y", "-ss", Math.max(0, (frame - 0.5) / probes.fps).toFixed(4), "-i", video,
      "-frames:v", "1", file]);
    if (!existsSync(file)) throw new Error(`no frame ${frame} in ${video} for beat ${r.beat} (${r.name}) ${r.kind}; the video is shorter than its beats`);
    shots.push({ beat: r.beat, name: r.name, kind: r.kind, file });
  }
  const sheets: string[] = [];
  for (let k = 0; k * 8 < shots.length; k++) {
    const list = join(dir, "sheet.txt");
    writeFileSync(list, shots.slice(k * 8, k * 8 + 8).map((s) => `file '${s.file}'\n`).join(""));
    const sheet = join(dir, `sheet-${k + 1}.png`);
    run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf",
      "scale=960:540,pad=968:548:4:4:0x0F1218,tile=2x4:color=0x0F1218", "-frames:v", "1", sheet]);
    sheets.push(sheet);
    rmSync(list);
  }
  return { shots, sheets };
}

// ---- audio ------------------------------------------------------------------------

const AUDIO_RATE = 48_000; // the rate narration.ts writes and its listener declares

function decodeAudio(video: string): Int16Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vn", "-f", "s16le", "-ac", "1", "-ar", String(AUDIO_RATE), "-"],
    { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg could not read the audio of ${video}`);
  const buf = r.stdout;
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** Loudness in dBFS of the samples between two times. */
function db(pcm: Int16Array, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * AUDIO_RATE));
  const b = Math.min(pcm.length, Math.ceil(to * AUDIO_RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += (pcm[i] ?? 0) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, b - a)) / 32768;
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

/** Each beat's voice starts where its captions start, and caption breaks inside a beat fall in pauses. */
export function captionTimingProblems(pcm: Int16Array, timing: Timing, offset = 0): string[] {
  const problems: string[] = [];
  for (const b of timing.beats) {
    const start = b.start - offset;
    let onset: number | null = null;
    for (let t = Math.max(0, start - 0.3); t < start + 0.5; t += 0.01) {
      if (db(pcm, t, t + 0.02) > -38) {
        onset = t;
        break;
      }
    }
    if (onset === null) problems.push(`beat ${b.name}: no voice within 0.5 s of its captions at ${start.toFixed(2)}s`);
    else if (Math.abs(onset - start) > 0.15) {
      problems.push(`beat ${b.name}: the voice starts at ${onset.toFixed(2)}s, ${(onset - start).toFixed(2)}s off its captions`);
    }
    for (const p of b.phrases.slice(0, -1)) {
      const level = db(pcm, p.end - offset - 0.04, p.end - offset + 0.04);
      if (level > -35) problems.push(`beat ${b.name}: the caption break after "${p.text}" falls in speech (${level.toFixed(0)} dB at ${(p.end - offset).toFixed(2)}s)`);
    }
  }
  return problems;
}

/** Transcribes each beat from the video's own audio and checks it says the beat's words. */
export async function transcriptProblems(pcm: Int16Array, timing: Timing, listener: Listener, env: Env, offset = 0): Promise<string[]> {
  const dir = join(cacheRoot(env), "heard");
  mkdirSync(dir, { recursive: true });
  const results = await Promise.all(timing.beats.map(async (b) => {
    const a = Math.max(0, Math.floor((b.start - offset - 0.05) * AUDIO_RATE));
    const z = Math.min(pcm.length, Math.ceil((b.end - offset + 0.1) * AUDIO_RATE));
    const slice = Buffer.from(pcm.slice(a, z).buffer);
    const key = createHash("sha256").update(slice).update(b.say).digest("hex").slice(0, 32);
    const file = join(dir, `${key}.json`);
    if (existsSync(file)) {
      const ok = dig(JSON.parse(readFileSync(file, "utf8")), "ok");
      const heard = dig(JSON.parse(readFileSync(file, "utf8")), "heard");
      if (typeof ok === "boolean" && typeof heard === "string") return { b, ok, heard };
    }
    const verdict = await listener.listen(slice, b.say);
    writeFileSync(file, JSON.stringify(verdict));
    return { b, ...verdict };
  }));
  return results.filter((r) => !r.ok).map((r) => `beat ${r.b.name}: the voice says "${r.heard}", not "${r.b.say}"`);
}

export type CheckInput = {
  video: string;
  timing: Timing;
  probes: Probes;
  framesDir: string;
  /** Measure captions against the voice (final renders with a voice). */
  audio: boolean;
  /** Transcribe the voice against the beats. */
  listen: boolean;
  /** Seconds of narration before the video's first frame (single-beat drafts). */
  offset: number;
  env: Env;
};

export type CheckResult = { problems: string[]; shots: Shot[]; sheets: string[]; skipped: string[] };

export async function check(c: CheckInput): Promise<CheckResult> {
  const problems = geometryProblems(c.probes);
  const { shots, sheets } = writeFrames(c.video, c.probes, c.framesDir);
  const skipped: string[] = [];
  if (c.audio && c.timing.provider !== "none") {
    const pcm = decodeAudio(c.video);
    problems.push(...captionTimingProblems(pcm, c.timing, c.offset));
    if (!c.listen) skipped.push("transcript: skipped by --no-listen");
    else if (!c.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set, so the voice cannot be transcribed; rerun with --no-listen to skip that part");
    else problems.push(...(await transcriptProblems(pcm, c.timing, geminiListener(c.env.GEMINI_API_KEY, c.env), c.env, c.offset)));
  } else if (c.audio) skipped.push("captions and transcript: no voice, captions carry the video");
  return { problems, shots, sheets, skipped };
}
