#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "faster-whisper"]
# ///
"""Voice a script and lay every line on one clock: the narration step for capture cuts and composed films alike.

    narrate.py SCRIPT.json [--out DIR] [--cache DIR] [--voice gemini:Iapetus,eleven:Mark,captions] [--style S]
               [--offline] [--fps 30] [--lead-in 0.45] [--gap 0.25] [--chapter-gap 0.4] [--tail 1.0]
               [--caption-chars 70]
    narrate.py SCRIPT.json --voices gemini:Iapetus,gemini:Charon,eleven:Mark [--chapter ID]
    narrate.py --self-test

SCRIPT.json lists the lines in speaking order: [{"id", "chapter", "show", "say"?, "gap"?}]. show is the caption
text; say is how the voice should say it (default show) and keeps show's clause punctuation, so each caption
starts on its own first spoken word. gap overrides the quiet before that one line. A chapter's lines are consecutive.
--voice is a fallback chain of tts.py voices: the first that voices every line voices all of them, so one video
never mixes voices. "captions" is no voice at all: each line is one caption, its words timed so it stays up 1.5 s
plus 0.3 s a word. A voiced line's captions split at its clauses. --voices instead voices one chapter (default the
first) in each voice into DIR/<chapter>-<voice>.wav, to pick a voice by ear; a voice that fails is skipped. Gaps are
the quiet from one line's last sound to the next line's first word; the lead-in is the first word's time. Quiet
inside a line is cut to at most 0.4 s, and the word times after the cut move with it.

Writes DIR (default beside SCRIPT) narration.wav (48 kHz mono, -16 LUFS, true peak -2 dBTP) and voice.json:

    {"voice": "gemini:Iapetus", "fps": 30, "duration": 41.2,
     "chapters": [{"id": "intro", "start": 0.45, "end": 9.8}],
     "lines": [{"id": "i1", "chapter": "intro", "show": "Open Settings.", "start": 0.45, "end": 1.6,
                "words": [{"w": "Open", "t": 0.45, "end": 0.71}, {"w": "Settings.", "t": 0.75, "end": 1.6}],
                "captions": [{"text": "Open Settings.", "start": 0.45, "end": 1.9}]}]}

Times are seconds on the narration's clock. A line starts at its first word and ends at its last sound; words are
the spoken words of say. Prints words per minute, the longest quiet gap inside the narration, and chapter lengths.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402
import tts  # noqa: E402

SR = tts.SR
PAD = (0.06, 0.12)  # clip audio kept before the first word and after the last sound
CAPTION_TAIL = 0.3
READ = (1.6, 0.3)  # captions only: s a caption stays up, plus s per word; the 1.5 s + 0.3 s rule with 0.1 s to spare
LONGEST_PAUSE = 0.4  # quiet kept inside a line; under the 0.45 s bar after loudness normalization
CLAUSE = re.compile(r"(?<=[.,:;?!])\s+")
# A ceiling of -2 dBTP, as in mix.sh: AAC encoding pushed a real voice past -1.5.
LOUDNORM = "loudnorm=I=-16:TP=-2:LRA=11"


def say(ln: dict) -> str:
    return ln.get("say", ln["show"])


def check(lines: list[dict]) -> list[dict]:
    ids, chapters = set(), set()
    for i, ln in enumerate(lines):
        missing = {"id", "chapter", "show"} - ln.keys()
        if missing:
            raise SystemExit(f"narrate.py: line {i} has no {', '.join(sorted(missing))}")
        if ln["id"] in ids:
            raise SystemExit(f"narrate.py: two lines have the id {ln['id']!r}")
        if ln["chapter"] in chapters and ln["chapter"] != lines[i - 1]["chapter"]:
            raise SystemExit(f"narrate.py: {ln['id']}: chapter {ln['chapter']!r} resumes after another chapter")
        if not say(ln).split():
            raise SystemExit(f"narrate.py: {ln['id']}: nothing to say")
        shown, spoken = len(CLAUSE.split(ln["show"].strip())), len(CLAUSE.split(say(ln).strip()))
        if shown != spoken:
            raise SystemExit(f"narrate.py: {ln['id']}: show has {shown} clauses and say has {spoken}; "
                             "keep their punctuation parallel")
        ids.add(ln["id"])
        chapters.add(ln["chapter"])
    return lines


def unvoiced(ln: dict) -> dict:
    spoken = say(ln).split()
    per = (READ[0] + READ[1] * len(ln["show"].split())) / len(spoken)
    words = [{"w": w, "start": round(k * per, 3), "end": round((k + 1) * per, 3)} for k, w in enumerate(spoken)]
    return {"audio": None, "duration": words[-1]["end"], "words": words, "voiced_start": 0.0,
            "voiced_end": words[-1]["end"]}


def tighten(clip: dict) -> dict:
    """The clip's audio with each quiet run inside its speech cut to LONGEST_PAUSE, its word times moved to match."""
    a = _media.samples(clip["wav"], SR)
    quiet, cuts = ~tts.loud(a), []
    k, last = int(clip["voiced_start"] / tts.HOP), min(int(clip["voiced_end"] / tts.HOP), len(quiet))
    while k < last:
        j = k
        while j < last and quiet[j]:
            j += 1
        if (j - k) * tts.HOP > LONGEST_PAUSE:
            cuts.append((k * tts.HOP + LONGEST_PAUSE / 2, j * tts.HOP - LONGEST_PAUSE / 2))
        k = j + 1
    moved = lambda t: round(t - sum(max(0.0, min(t, c1) - c0) for c0, c1 in cuts), 3)  # noqa: E731
    keep = np.ones(len(a), bool)
    for c0, c1 in cuts:
        keep[int(c0 * SR):int(c1 * SR)] = False
    a = a[keep]
    return {"audio": a, "duration": len(a) / SR, "voiced_start": clip["voiced_start"],
            "voiced_end": moved(clip["voiced_end"]),
            "words": [{"w": w["w"], "start": moved(w["start"]), "end": moved(w["end"])} for w in clip["words"]]}


def voice_all(lines: list[dict], chain: list[str], a) -> tuple[str, list[dict]]:
    for spec in chain:
        if spec == "captions":
            return spec, [unvoiced(ln) for ln in lines]
        try:
            voice = tts.parse(spec, a.style)
            return spec, [tighten(tts.synth(say(ln), a.cache, voice, a.offline)) for ln in lines]
        except tts.ProviderError as e:
            print(f"narrate.py: {spec} failed ({e})", file=sys.stderr)
    raise SystemExit(f"narrate.py: no voice in {','.join(chain)} voiced every line")


def captions(ln: dict, words: list[dict], end: float, max_chars: int) -> list[dict]:
    shown, first, n = CLAUSE.split(ln["show"].strip()), [], 0
    for clause in CLAUSE.split(say(ln).strip()):
        first.append(n)
        n += len(clause.split())
    groups = [[0]]
    for i in range(1, len(shown)):
        cur = " ".join(shown[j] for j in groups[-1])
        if (cur[-1] in ".?!:" and len(cur.split()) >= 3) or len(cur) + 1 + len(shown[i]) > max_chars:
            groups.append([i])
        else:
            groups[-1].append(i)
    starts = [words[first[g[0]]]["t"] for g in groups]
    return [{"text": " ".join(shown[j] for j in g), "start": s, "end": e}
            for g, s, e in zip(groups, starts, starts[1:] + [end])]


def mix(pieces: list[tuple[dict, float]], duration: float, dest: Path) -> None:
    buf = np.zeros(int(np.ceil(duration * SR)), np.float32)
    for clip, shift in pieces:
        if clip["audio"] is None:
            continue
        a0, a1 = max(0.0, clip["voiced_start"] - PAD[0]), min(clip["duration"], clip["voiced_end"] + PAD[1])
        a = clip["audio"][int(a0 * SR):int(a1 * SR)]
        f = min(len(a), int(0.02 * SR))
        a[:f] *= np.linspace(0, 1, f)
        a[len(a) - f:] *= np.linspace(1, 0, f)
        at = int(round((a0 + shift) * SR))
        if at < 0:
            a, at = a[-at:], 0
        buf[at:at + len(a)] += a[:len(buf) - at]
    raw = dest.with_suffix(".raw.wav")
    _media.write_wav(raw, buf, SR)
    if all(clip["audio"] is None for clip, _ in pieces):
        raw.replace(dest)
        return
    meas = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(raw), "-af",
                           f"{LOUDNORM}:print_format=json", "-f", "null", "-"],
                          capture_output=True, text=True).stderr
    m = json.loads(meas[meas.rindex("{"):meas.rindex("}") + 1])
    af = (f"{LOUDNORM}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
          f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", af, "-ar", str(SR), str(dest)], check=True)
    raw.unlink()


def report(v: dict, wav: Path) -> None:
    lines, quiet = v["lines"], ~tts.loud(_media.samples(wav, SR))
    run = best = at = 0
    for k in range(int(lines[0]["start"] / tts.HOP), min(len(quiet), int(lines[-1]["end"] / tts.HOP))):
        run = run + 1 if quiet[k] else 0
        if run > best:
            best, at = run, k - run + 1
    words = sum(len(ln["words"]) for ln in lines)
    speaking = sum(ln["end"] - ln["start"] for ln in lines)
    print(f"{wav.name}, {v['voice']}: {len(lines)} lines, {words} words, {v['duration']:.2f} s; "
          f"{words / speaking * 60:.0f} wpm while speaking, {words / (lines[-1]['end'] - lines[0]['start']) * 60:.0f} "
          f"wpm with the gaps; longest quiet gap {best * tts.HOP:.2f} s at {at * tts.HOP:.2f} s")
    for ch in v["chapters"]:
        print(f"  {ch['id']:<16} {ch['start']:7.2f} -> {ch['end']:7.2f}  ({ch['end'] - ch['start']:.1f} s)")


def narrate(lines: list[dict], chain: list[str], a, wav: Path) -> dict:
    spec, clips = voice_all(lines, chain, a)
    t, out, pieces = a.lead_in, [], []
    for i, (ln, clip) in enumerate(zip(lines, clips)):
        if i:
            same = ln["chapter"] == lines[i - 1]["chapter"]
            t = out[-1]["end"] + float(ln.get("gap", a.gap if same else a.chapter_gap))
        shift = t - clip["voiced_start"]
        out.append({"id": ln["id"], "chapter": ln["chapter"], "show": ln["show"], "start": round(t, 3),
                    "end": round(clip["voiced_end"] + shift, 3),
                    "words": [{"w": w["w"], "t": round(w["start"] + shift, 3), "end": round(w["end"] + shift, 3)}
                              for w in clip["words"]]})
        pieces.append((clip, shift))
    duration = round(out[-1]["end"] + a.tail, 3)
    for i, ln in enumerate(out):
        end = round(min(ln["end"] + CAPTION_TAIL, out[i + 1]["start"] if i + 1 < len(out) else duration), 3)
        ln["captions"] = ([{"text": ln["show"], "start": ln["start"], "end": end}] if spec == "captions"
                          else captions(lines[i], ln["words"], end, a.caption_chars))
    chapters = []
    for ln in out:
        if not chapters or chapters[-1]["id"] != ln["chapter"]:
            chapters.append({"id": ln["chapter"], "start": ln["start"]})
        chapters[-1]["end"] = ln["end"]
    mix(pieces, duration, wav)
    v = {"voice": spec, "fps": a.fps, "duration": duration, "chapters": chapters, "lines": out}
    report(v, wav)
    return v


def self_test() -> int:
    fails, calls = [], []

    def fake_synth(text, cache, voice, offline=False):
        if offline:
            raise SystemExit("not cached and --offline")
        calls.append(voice.voice)
        if voice.voice == "Broken" and len(calls) > 1:
            raise tts.ProviderError("HTTP 403")
        words, at = [], 0.1
        for w in text.split():  # 0.3 s a word, then 0.1 s of quiet, or 0.8 s after a comma as Iapetus pauses
            words.append({"w": w, "start": round(at, 3), "end": round(at + 0.3, 3)})
            at += 0.3 + (0.8 if w.endswith(",") else 0.1)
        t = np.arange(int((words[-1]["end"] + 0.1) * SR)) / SR
        on = np.any([(t >= w["start"]) & (t < w["end"]) for w in words], axis=0)
        Path(cache).mkdir(exist_ok=True)
        wav = Path(cache) / f"clip-{len(calls)}.wav"
        _media.write_wav(wav, 0.3 * np.sin(2 * np.pi * (150 + 20 * len(voice.voice)) * t) * on, SR)
        return {"wav": str(wav), "duration": len(t) / SR, "words": words, "voiced_start": 0.1, "voiced_end": words[-1]["end"]}

    tts.synth = fake_synth
    script = [{"id": "a1", "chapter": "intro", "show": "Open the app, then sign in."},
              {"id": "a2", "chapter": "intro", "show": "Run bin/sync now.", "say": "Run bin sync now."},
              {"id": "b1", "chapter": "main", "show": "One long line runs on, past the caption limit. It splits."}]
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as stdout:
        d = Path(tmp)
        (d / "script.json").write_text(json.dumps(script))
        run = lambda *extra: main([str(d / "script.json"), "--caption-chars", "30", *extra])  # noqa: E731
        run("--voice", "gemini:Broken,gemini:Good")
        v = json.loads((d / "voice.json").read_text())
        printed = stdout.getvalue()
        a1, a2, b1 = v["lines"]
        if v["voice"] != "gemini:Good" or calls != ["Broken", "Broken", "Good", "Good", "Good"]:
            fails.append(f"a provider failure did not revoice every line with the next voice: {v['voice']}, {calls}")
        if [a1["start"], round(a2["start"] - a1["end"], 3), round(b1["start"] - a2["end"], 3)] != [0.45, 0.25, 0.4] \
                or v["duration"] != round(b1["end"] + 1.0, 3):
            fails.append(f"gaps: lines {[(ln['start'], ln['end']) for ln in v['lines']]}, duration {v['duration']}")
        if v["chapters"] != [{"id": "intro", "start": a1["start"], "end": a2["end"]},
                             {"id": "main", "start": b1["start"], "end": b1["end"]}]:
            fails.append(f"chapters {v['chapters']}")
        if [w["w"] for w in a2["words"]] != ["Run", "bin", "sync", "now."] or \
                [c["text"] for c in a1["captions"] + a2["captions"]] != ["Open the app, then sign in.", "Run bin/sync now."]:
            fails.append(f"spoken words or shown captions: {a2['words']}, {a1['captions']}")
        if [c["start"] for c in b1["captions"]] != [b1["words"][0]["t"], b1["words"][5]["t"], b1["words"][9]["t"]]:
            fails.append(f"long line captions {b1['captions']}")
        a = _media.samples(d / "narration.wav", SR)
        fmt = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0",
                              str(d / "narration.wav")], capture_output=True, text=True).stdout.strip()
        if fmt != "48000,1" or abs(len(a) / SR - v["duration"]) > 0.01:
            fails.append(f"narration.wav is not 48 kHz mono of {v['duration']} s")
        lf = tts.loud(a)
        words = [w for ln in v["lines"] for w in ln["words"]]
        for w, prev in zip(words, [0.0] + [w["end"] for w in words]):
            k = int(prev / tts.HOP) + 2
            onset = (k + np.flatnonzero(lf[k:])[0]) * tts.HOP
            if abs(onset - w["t"]) > 0.02:
                fails.append(f"{w['w']!r} is heard at {onset:.2f} s but timed at {w['t']} s")
        for ln in v["lines"]:
            edges = np.flatnonzero(np.diff(np.r_[0, ~lf[int(ln["start"] / tts.HOP):int(ln["end"] / tts.HOP)], 0]))
            if (longest := max(edges[1::2] - edges[::2]) * tts.HOP) > 0.45:
                fails.append(f"{ln['id']} keeps {longest:.2f} s of quiet inside it")
        for ln, nxt in zip(v["lines"], v["lines"][1:]):
            k = int(nxt["start"] / tts.HOP) - 2
            k += np.flatnonzero(lf[k:])[0]
            quiet = (k - np.flatnonzero(lf[:k])[-1] - 1) * tts.HOP
            if abs(quiet - (nxt["start"] - ln["end"])) > 0.03:
                fails.append(f"{ln['id']} ends at {ln['end']} s but {quiet:.2f} s of quiet precede {nxt['id']}")
        wpm, gap = re.search(r"(\d+) wpm while speaking.*longest quiet gap ([\d.]+) s", printed).groups()
        speaking = sum(ln["end"] - ln["start"] for ln in v["lines"])
        if int(wpm) != round(len(words) / speaking * 60) or float(gap) > 0.45:
            fails.append(f"the report says {wpm} wpm and a longest gap of {gap} s: {printed}")
        n = len(calls)
        for bad, why in ((["--voice", "gemini:Good,eleven:Mark", "--offline"], "an offline miss fell through to the next voice"),
                         (["--voice", "nobody:x"], "an unknown provider passed")):
            try:
                run(*bad)
                fails.append(why)
            except SystemExit:
                pass
        if len(calls) != n:
            fails.append("a failed run still voiced lines")
        (d / "bad.json").write_text(json.dumps([{"id": "x", "chapter": "c", "show": "Yes, no.", "say": "Yes no."}]))
        try:
            main([str(d / "bad.json"), "--voice", "gemini:Good"])
            fails.append("say with fewer clauses than show passed")
        except SystemExit:
            if len(calls) != n:
                fails.append("a clause mismatch was found only after voicing")
        n = len(calls)
        run("--voices", "gemini:Iapetus,gemini:Broken,eleven:Mark", "--chapter", "main")
        one, two = d / "main-gemini-Iapetus.wav", d / "main-eleven-Mark.wav"
        if not (one.exists() and two.exists()) or one.read_bytes() == two.read_bytes() \
                or calls[n:] != ["Iapetus", "Broken", "UgBBYS2sOqTuMpoF3BR0"]:
            fails.append(f"--voices did not skip the broken voice and voice the chapter once per other voice: {calls[n:]}")
        try:
            run("--voices", "gemini:Broken")
            fails.append("--voices passed with no voice that voiced")
        except SystemExit:
            pass
        shown = ["Press Apply again: the total stays at 18.00.",
                 "When the import finishes, the table refreshes, the totals update, and the badge turns green."]
        (d / "script.json").write_text(json.dumps([{"id": f"c{i}", "chapter": "c", "show": t} for i, t in enumerate(shown)]))
        run("--voice", "captions")
        v = json.loads((d / "voice.json").read_text())
        short = [c for ln in v["lines"] for c in ln["captions"] if c["end"] - c["start"] < 1.5 + 0.3 * len(c["text"].split())]
        if v["voice"] != "captions" or short or tts.loud(_media.samples(d / "narration.wav", SR)).any() \
                or [[c["text"] for c in ln["captions"]] for ln in v["lines"]] != [[t] for t in shown]:
            fails.append(f"captions only did not show each line whole, long enough to read, over silence: {v['lines']}")
        t = np.arange(3 * SR) / SR
        spiky = (0.05 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
        spiky[::SR // 4] = 1.0
        mix([({"audio": spiky, "duration": 3.0, "voiced_start": 0.0, "voiced_end": 3.0}, 0.0)], 3.0, d / "peak.wav")
        peak = float(re.findall(r"Peak:\s+(-?[\d.]+) dBFS", subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(d / "peak.wav"), "-af", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True).stderr)[-1])
        if peak > -2.0:
            fails.append(f"narration.wav peaks at {peak} dBTP, over the -2 dBTP ceiling")
    print("narrate.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("script", nargs="?", type=Path)
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--out", type=Path)
    p.add_argument("--cache", type=Path, help="default: tts/ beside SCRIPT")
    p.add_argument("--voice", default="gemini:Iapetus,eleven:Mark,captions")
    p.add_argument("--voices")
    p.add_argument("--chapter")
    p.add_argument("--style", default=tts.STYLE)
    p.add_argument("--offline", action="store_true")
    p.add_argument("--fps", type=int, default=30)
    for flag, default in (("--lead-in", 0.45), ("--gap", 0.25), ("--chapter-gap", 0.4), ("--tail", 1.0)):
        p.add_argument(flag, type=float, default=default)
    p.add_argument("--caption-chars", type=int, default=70)
    a = p.parse_args(argv)
    if a.self_test:
        return self_test()
    if not a.script:
        p.error("SCRIPT.json is required")
    lines = check(json.loads(a.script.read_text()))
    out = a.out or a.script.parent
    out.mkdir(parents=True, exist_ok=True)
    a.cache = a.cache or a.script.parent / "tts"
    if a.voices:
        chapter = a.chapter or lines[0]["chapter"]
        some = [ln for ln in lines if ln["chapter"] == chapter]
        if not some:
            raise SystemExit(f"narrate.py: no chapter {chapter!r}")
        voiced = 0
        for spec in a.voices.split(","):
            try:
                narrate(some, [spec], a, out / f"{chapter}-{re.sub(r'[^A-Za-z0-9]+', '-', spec)}.wav")
                voiced += 1
            except SystemExit as e:
                print(f"{e}; skipped {spec}", file=sys.stderr)
        if not voiced:
            raise SystemExit(f"narrate.py: no voice in {a.voices} voiced chapter {chapter!r}")
        return 0
    v = narrate(lines, a.voice.split(","), a, out / "narration.wav")
    (out / "voice.json").write_text(json.dumps(v, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
