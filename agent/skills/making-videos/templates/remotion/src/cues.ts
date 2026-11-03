import { Easing, interpolate } from "remotion";
import raw from "../public/voice.json";

// narrate.py's voice.json, copied into public/. Times are in seconds.
type Voice = {
  fps: number;
  duration: number;
  chapters: { id: string; start: number; end: number }[];
  lines: {
    id: string;
    chapter: string;
    show: string;
    start: number;
    end: number;
    words: { w: string; t: number; end: number }[];
    captions: { text: string; start: number; end: number }[];
  }[];
};
export const voice: Voice = raw;

export const FPS = voice.fps;
export const sec = (s: number) => Math.round(s * FPS);
export const TOTAL = Math.ceil(voice.duration * FPS);

const line = (id: string) => {
  const l = voice.lines.find((l) => l.id === id);
  if (!l) throw new Error(`no voice line "${id}"`);
  return l;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");

const LEAD = 4;

// The frame to cue on a line's start, or on the nth (from 0) spoken word starting with `word`, LEAD frames early.
export const at = (id: string, word?: string, nth = 0) => {
  const l = line(id);
  if (word === undefined) return sec(l.start) - LEAD;
  const hit = l.words.filter((w) => norm(w.w).startsWith(norm(word)))[nth];
  if (!hit) throw new Error(`no word "${word}" #${nth} in line "${id}"`);
  return sec(hit.t) - LEAD;
};

export const endOf = (id: string) => sec(line(id).end);

export const CROSSFADE = 14;
const CUT_BEFORE_FIRST_WORD = 9;
// A chapter owns the frames from its cut to the next chapter's cut.
const cuts = voice.chapters.map((c, i) => (i === 0 ? 0 : sec(c.start) - CUT_BEFORE_FIRST_WORD));
export const sceneWindow = (id: string) => {
  const i = voice.chapters.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`no chapter "${id}"`);
  return { from: cuts[i], to: cuts[i + 1] ?? TOTAL };
};

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const ease = (frame: number, start: number, dur = 14) =>
  interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: Easing.bezier(0.22, 1, 0.36, 1) });
