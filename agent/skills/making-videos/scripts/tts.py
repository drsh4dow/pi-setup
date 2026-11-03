#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "faster-whisper"]
# ///
"""Voice narration one line at a time with Gemini or ElevenLabs, with word times, cached per line on disk.

    tts.py --self-test

narrate.py is the command; it imports synth and parse from here. A voice is PROVIDER:VOICE[:MODEL].
gemini:Iapetus is Gemini's prebuilt voice Iapetus on gemini-3.8-flash-tts; eleven:Mark is ElevenLabs voice
UgBBYS2sOqTuMpoF3BR0 on eleven_v4. Any other Gemini voice name or ElevenLabs voice id works too. Gemini takes a
speaking-style prompt (default STYLE below). ElevenLabs takes no prompt; its pace is a speed after the voice,
eleven:Mark@0.8 (0.8 to 1.2, default ELEVEN_SPEED, which puts Mark near 165 words a minute). Slow a voice this way,
never by stretching its audio.
ElevenLabs returns character times. Gemini returns none, so local faster-whisper (WHISPER_MODEL, default
small.en) hears the clip and its words are matched to the line by letters; a clip that does not say the line is
voiced again, up to 3 tries in all. Either way each word's start and end then snap to the audible audio (10 ms frames
above -35 dBFS), never spread by character count, on every read, so a cached line takes the current snap. A word
whose recognized span holds a pause (PAUSE s or more of quiet) starts after it: the sound before it is the previous
word's tail.
Each line is cached under DIR as <sha256(text, provider, model, voice, style, speed)[:20]>.{wav,json}, so a rerun
calls the API only for lines whose text or voice changed. offline=True turns a cache miss into an error, so a
rebuild can never re-voice by accident. GEMINI_API_KEY and ELEVENLABS_API_KEY travel only in request headers, are
never printed or written, and never follow a redirect. A 3xx or a 4xx other than 429 fails the provider at once. A
429 waits its Retry-After and tries again, but a Retry-After over 300 s (a spent daily quota) fails the provider
too. A network error or a cut-off response is tried again, up to 6 requests in all; a response that is not JSON
fails the provider at once.
Send only narration you would publish: this text leaves the machine.

synth(text, cache_dir, parse("gemini:Iapetus"), offline=False) -> {wav, duration, words: [{w, start, end}],
voiced_start, voiced_end}, times in seconds from the clip start, one word per word of text. A provider that cannot
voice lines, or answers without audio or word times, raises ProviderError, so the caller can redo every line with
the next voice.
"""
from __future__ import annotations

import argparse
import base64
import difflib
import hashlib
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import NamedTuple

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

SR, HOP, LOUD_DB, PAUSE, MAX_WAIT, MIN_HEARD, BACKOFF = 48000, 0.01, -35.0, 0.15, 300, 0.7, 2.0
MODELS = {"gemini": "gemini-3.8-flash-tts", "eleven": "eleven_v4"}
ELEVEN_SPEED = 0.85
ELEVEN_NAMES = {"Mark": "UgBBYS2sOqTuMpoF3BR0"}
STYLE = "a calm, plain-spoken colleague narrating an internal product walkthrough, steady pace"
API = {"gemini": ("https://generativelanguage.googleapis.com", "GEMINI_API_KEY", "x-goog-api-key"),
       "eleven": ("https://api.elevenlabs.io", "ELEVENLABS_API_KEY", "xi-api-key")}
PCM24 = ["-f", "s16le", "-ar", "24000", "-ac", "1"]
hear = _media.heard_words


class ProviderError(Exception):
    """The provider cannot voice lines for this run: no key, a rejected request, or retries spent."""


class Voice(NamedTuple):
    provider: str
    model: str
    voice: str
    style: str
    speed: float | None


def parse(spec: str, style: str = STYLE) -> Voice:
    provider, _, rest = spec.partition(":")
    voice, _, model = rest.partition(":")
    voice, at, speed = voice.partition("@")
    if provider not in MODELS or not voice:
        raise SystemExit(f"tts.py: voice {spec!r} is not PROVIDER:VOICE[:MODEL] with PROVIDER gemini or eleven")
    if provider == "gemini":
        if at:
            raise SystemExit(f"tts.py: {spec!r}: Gemini takes no speed; slow it with --style")
        return Voice(provider, model or MODELS[provider], voice, style, None)
    try:
        speed = float(speed) if at else ELEVEN_SPEED
    except ValueError:
        speed = None
    if speed is None or not 0.8 <= speed <= 1.2:
        raise SystemExit(f"tts.py: {spec!r}: an ElevenLabs speed is a number from 0.8 to 1.2")
    return Voice(provider, model or MODELS[provider], ELEVEN_NAMES.get(voice, voice), "", speed)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):  # a redirect would carry the key header to another URL
        return None


_open = urllib.request.build_opener(_NoRedirect).open


def _post(provider: str, path: str, body: dict) -> dict:
    base, env, header = API[provider]
    key = os.environ.get(env)
    if not key:
        raise ProviderError(f"{env} is unset")
    url = os.environ.get(f"TTS_{provider.upper()}_URL", base) + path
    last, wait = "", 0.0
    for attempt in range(6):
        time.sleep(wait)
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={header: key, "content-type": "application/json"})
        try:
            with _open(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {e.read()[:300].decode('utf-8', 'replace')}".replace(key, "<key>")
            ra = e.headers.get("Retry-After", "")
            wait = float(ra) if e.code == 429 and ra.replace(".", "", 1).isdigit() else BACKOFF * (attempt + 1)
            if (e.code < 500 and e.code != 429) or wait > MAX_WAIT:
                break
        except ValueError:  # a whole answer that is not JSON; asking again would pay for the same page
            last = "a response that is not JSON"
            break
        except (OSError, http.client.HTTPException) as e:
            last, wait = type(e).__name__, BACKOFF * (attempt + 1)
    raise ProviderError(f"{provider} {last}")


def _gemini(text: str, v: Voice) -> tuple[bytes, list[str]]:
    part = {"type": "text", "text": text}
    if v.style:
        part["annotations"] = [{"type": "speech_metadata", "style": v.style}]
    d = _post("gemini", "/v1beta/interactions", {
        "model": v.model, "store": False, "input": [{"type": "user_input", "content": [part]}],
        "response_format": {"type": "audio"}, "generation_config": {"speech_config": [{"voice": v.voice}]}})
    audio = [c["data"] for s in d.get("steps", []) if s.get("type") == "model_output"
             for c in s.get("content", []) if c.get("type") == "audio"]
    if not audio:
        raise ProviderError("gemini: the response held no audio")
    data = base64.b64decode(audio[-1])
    return data, [] if data[:4] == b"RIFF" else PCM24  # the 2.5 preview models send bare PCM


def _eleven(text: str, v: Voice) -> tuple[bytes, list[tuple]]:
    d = _post("eleven", f"/v1/text-to-speech/{v.voice}/with-timestamps?output_format=pcm_24000",
              {"text": text, "model_id": v.model, "voice_settings": {"speed": v.speed}})
    al = d.get("alignment") or {}
    words, cur = [], None
    for c, s, e in zip(al.get("characters") or [], al.get("character_start_times_seconds") or [],
                       al.get("character_end_times_seconds") or []):
        if c.isspace():
            cur = None
        elif cur is None:
            cur = [c, s, e]
            words.append(cur)
        else:
            cur[0], cur[2] = cur[0] + c, e
    if not d.get("audio_base64") or len(words) != len(text.split()):
        raise ProviderError("eleven: the response held no audio or no word times for every word")
    return base64.b64decode(d["audio_base64"]), [tuple(w) for w in words]


def align(text: str, heard: list[dict]) -> tuple[list[tuple], float]:
    """(word, start, end) for each word of text from the heard words its letters match, and the share of its
    letters heard. A run of unmatched words (a number heard as digits) shares the time between its neighbours."""
    words = text.split()
    a = [(c, i) for i, w in enumerate(words) for c in w.lower() if c.isalnum()]
    b = [(c, j) for j, h in enumerate(heard) for c in h["w"].lower() if c.isalnum()]
    blocks = difflib.SequenceMatcher(None, "".join(c for c, _ in a), "".join(c for c, _ in b),
                                     autojunk=False).get_matching_blocks()
    span = {}
    for x, y, n in blocks:
        for k in range(n):
            i, h = a[x + k][1], heard[b[y + k][1]]
            s, e = span.get(i, (h["start"], h["end"]))
            span[i] = (min(s, h["start"]), max(e, h["end"]))
    times, i = [], 0
    while i < len(words):
        k = next((k for k in range(i, len(words)) if k in span), len(words))
        lo = times[-1][1] if times else 0.0
        hi = span[k][0] if k < len(words) else max([h["end"] for h in heard] + [lo])
        times += [(lo + (hi - lo) * n / (k - i), lo + (hi - lo) * (n + 1) / (k - i)) for n in range(k - i)]
        times += [span[k]] if k < len(words) else []
        i = k + 1
    return [(w, s, e) for w, (s, e) in zip(words, times)], sum(n for *_, n in blocks) / max(1, len(a))


def loud(a: np.ndarray) -> np.ndarray:
    """One bool per 10 ms frame of SR-Hz samples: louder than LOUD_DB."""
    n = int(HOP * SR)
    fr = a[: len(a) // n * n].reshape(-1, n)
    return 10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-12) > LOUD_DB


def snap(s: float, e: float, lf: np.ndarray) -> tuple[float, float]:
    """Move a start forward to the first loud frame after the word's last pause, or after the quiet it falls on, and
    a quiet end back to the word's last loud frame."""
    i = min(int(s / HOP), len(lf) - 1)
    j = max(i + 1, min(len(lf), int(np.ceil(e / HOP))))
    on = np.flatnonzero(lf[i:j])
    if len(on):
        pause = np.flatnonzero(np.diff(on) > round(PAUSE / HOP))
        s = (i + on[pause[-1] + 1]) * HOP if len(pause) else s if lf[i] else (i + on[0]) * HOP
        e = e if lf[j - 1] else (i + on[-1] + 1) * HOP
    return round(s, 3), round(e, 3)


def _to_wav(data: bytes, fmt: list[str], wav: Path) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *fmt, "-i", "-", "-ac", "1", "-ar", str(SR), str(wav)],
                   input=data, check=True)


def synth(text: str, cache: Path, voice: Voice, offline: bool = False) -> dict:
    if not text.split():
        raise SystemExit("tts.py: an empty line has nothing to voice")
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256(json.dumps([text, *voice]).encode()).hexdigest()[:20]
    wav, meta = cache / f"{h}.wav", cache / f"{h}.json"
    if not meta.exists():
        if offline:
            raise SystemExit(f"tts.py: not cached and --offline: {voice.provider}:{voice.voice} {text[:60]!r}")
        for _ in range(3):
            if voice.provider == "eleven":
                data, raw = _eleven(text, voice)
                _to_wav(data, PCM24, wav)
                break
            _to_wav(*_gemini(text, voice), wav)
            raw, heard = align(text, hear(_media.samples(wav, 16000)))
            if heard >= MIN_HEARD:
                break
        else:
            raise SystemExit(f"tts.py: {voice.voice} said something else 3 times ({heard:.0%} of the letters heard): "
                             f"{text[:60]!r}; respell the line")
        n = len(_media.samples(wav, SR))
        raw[0] = (raw[0][0], 0.0, raw[0][2])  # the line's first sound belongs to its first word, its last to its last
        raw[-1] = (*raw[-1][:2], n / SR)
        words = [dict(zip(("w", "start", "end"), w)) for w in raw]
        tmp = meta.with_suffix(".tmp")
        tmp.write_text(json.dumps({"text": text, "voice": voice._asdict(), "duration": n / SR, "words": words}))
        tmp.replace(meta)
    m, lf = json.loads(meta.read_text()), loud(_media.samples(wav, SR))
    words = [dict(zip(("w", "start", "end"), (w["w"], *snap(w["start"], w["end"], lf)))) for w in m["words"]]
    return {"wav": str(wav), "duration": m["duration"], "words": words,
            "voiced_start": words[0]["start"], "voiced_end": words[-1]["end"]}


def self_test() -> int:
    import io
    import wave
    from http.server import BaseHTTPRequestHandler, HTTPServer

    secret, fails, hits, plan = "sk-selftest-not-a-real-key", [], [], []
    t = np.arange(int(1.8 * 24000)) / 24000
    tone = (0.3 * np.sin(2 * np.pi * 220 * t) * (((t >= 0.3) & (t < 0.7)) | ((t >= 1.0) & (t < 1.5))) * 32767)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(24000), w.writeframes(tone.astype("<i2").tobytes())
    gemini_wav = buf.getvalue()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            hits.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
            code, extra, patch = plan.pop(0) if plan else (200, {}, {})
            if self.path.startswith("/v1beta/interactions"):
                out = {"steps": [{"type": "model_output", "content": [
                    {"type": "audio", "data": base64.b64encode(gemini_wav).decode()}]}]}
            else:
                text = body["text"]
                pcm = (np.sign(np.sin(np.arange(24000) / 6)) * 3000).astype("<i2").tobytes()
                step = 0.9 / len(text)
                out = {"audio_base64": base64.b64encode(pcm).decode(), "alignment": {
                    "characters": list(text), "character_start_times_seconds": [0.05 + i * step for i in range(len(text))],
                    "character_end_times_seconds": [0.05 + (i + 1) * step for i in range(len(text))]}}
            data = patch if isinstance(patch, bytes) else json.dumps(
                {**out, **patch} if code == 200 else {"error": "scripted"}).encode()
            self.send_response(code)
            for k, v in {"content-length": str(len(data)), **extra}.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            hits.append((self.path, {k.lower(): v for k, v in self.headers.items()}, None))
            self.send_error(404)

        def log_message(self, *a):
            pass

    def raises(fn, kind) -> bool:
        try:
            fn()
        except kind:
            return True
        except BaseException:  # noqa: BLE001
            return False
        return False

    def fake_hear(audio):
        said = "Something else" if garble else hits[-1][2]["input"][0]["content"][0]["text"]
        heard = [{"w": w, "start": 0.05 + 0.6 * k, "end": 0.9 + 0.8 * k} for k, w in enumerate(said.split())]
        heard[0]["start"], heard[-1]["end"] = 0.4, heard[-1]["start"] + 0.55
        return heard

    global hear, BACKOFF
    hear, garble, BACKOFF = fake_hear, False, 0.0
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}"
    os.environ.update(TTS_GEMINI_URL=url, TTS_ELEVEN_URL=url, GEMINI_API_KEY=secret, ELEVENLABS_API_KEY=secret)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            d, iap = Path(tmp), parse("gemini:Iapetus")
            a = synth("Two words.", d, iap)
            path, headers, body = hits[0]
            if headers.get("x-goog-api-key") != secret or secret in json.dumps(body) or secret in path:
                fails.append("the Gemini key did not travel in the x-goog-api-key header alone")
            part = body["input"][0]["content"][0]
            if (body["model"], body["generation_config"]["speech_config"][0]["voice"], body["store"]) != \
                    ("gemini-3.8-flash-tts", "Iapetus", False) or part["annotations"][0]["style"] != STYLE:
                fails.append(f"Gemini request body {body}")
            got = [(w["start"], w["end"]) for w in a["words"]]
            if any(abs(x - y) > 0.011 for g, want in zip(got, [(0.3, 0.7), (1.0, 1.5)]) for x, y in zip(g, want)):
                fails.append(f"Gemini words {got} did not snap to the loud spans [(0.3, 0.7), (1.0, 1.5)]")
            if abs(a["duration"] - 1.8) > 1e-3 or synth("Two words.", d, iap) != a or len(hits) != 1:
                fails.append(f"duration {a['duration']} or the cached line hit the API ({len(hits)} requests)")
            synth("Two words.", d, parse("gemini:Iapetus", "brisk"))
            synth("Two words.", d, parse("gemini:Iapetus:gemini-2.5-pro-preview-tts"))
            if len(hits) != 3:
                fails.append("the cache key ignores the style or the model")
            mark = parse("eleven:Mark")
            b = synth("Three synthetic words.", d, mark)
            path, headers, body = hits[-1]
            if "/v1/text-to-speech/UgBBYS2sOqTuMpoF3BR0/with-timestamps" not in path or body["model_id"] != "eleven_v4" \
                    or body.get("voice_settings") != {"speed": 0.85} or headers.get("xi-api-key") != secret:
                fails.append(f"ElevenLabs request {path} {body}")
            if [w["w"] for w in b["words"]] != ["Three", "synthetic", "words."] or abs(b["duration"] - 1.0) > 1e-3:
                fails.append(f"ElevenLabs words {b['words']}")
            n = len(hits)
            synth("Three synthetic words.", d, parse("eleven:Mark@0.8"))
            if len(hits) != n + 1 or hits[-1][2]["voice_settings"] != {"speed": 0.8}:
                fails.append(f"eleven:Mark@0.8 was not voiced again at speed 0.8: {hits[-1][2]}")
            for spec in ("eleven:Mark@0.5", "eleven:Mark@fast", "eleven:Mark@", "gemini:Iapetus@0.8"):
                if not raises(lambda: parse(spec), SystemExit):
                    fails.append(f"the voice {spec} passed")
            for patch in ({"alignment": None}, {"audio_base64": None}):
                plan[:] = [(200, {}, patch)]
                if not raises(lambda: synth("Half an answer.", d, mark), ProviderError):
                    fails.append(f"an ElevenLabs answer with {patch} did not fail the provider")
            plan[:] = [(302, {"Location": url + "/stolen"}, {})]
            n = len(hits)
            if not raises(lambda: synth("Redirected.", d, iap), ProviderError) or len(hits) != n + 1:
                fails.append(f"a redirect was followed with the key: {[h[0] for h in hits[n:]]}")
            plan[:] = [(200, {"content-length": "99999999"}, {})]
            n = len(hits)
            synth("Cut off.", d, iap)
            if len(hits) != n + 2:
                fails.append(f"a cut-off answer then a whole one took {len(hits) - n} requests, want 2")
            plan[:] = [(200, {}, b"<html>busy</html>")]
            n = len(hits)
            if not raises(lambda: synth("Not JSON.", d, iap), ProviderError) or len(hits) != n + 1:
                fails.append(f"a non-JSON answer did not fail the provider after one request ({len(hits) - n})")
            plan[:] = [(429, {"Retry-After": "0"}, {})]
            n = len(hits)
            synth("After a 429.", d, iap)
            if len(hits) != n + 2:
                fails.append(f"a 429 then 200 took {len(hits) - n} requests, want 2")
            plan[:] = [(403, {}, {})] * 6
            n = len(hits)
            if not raises(lambda: synth("Forbidden.", d, iap), ProviderError) or len(hits) != n + 1:
                fails.append(f"a 403 did not fail the provider after one request ({len(hits) - n})")
            plan.clear()
            garble = True
            n = len(hits)
            if not raises(lambda: synth("Never said.", d, iap), SystemExit) or len(hits) != n + 3:
                fails.append(f"a clip that never says the line was not retried 3 times then stopped ({len(hits) - n})")
            if not raises(lambda: synth("Never voiced.", d, iap, offline=True), SystemExit):
                fails.append("an offline cache miss did not stop the run")
            del os.environ["GEMINI_API_KEY"]
            if not raises(lambda: synth("No key.", d, iap), ProviderError):
                fails.append("a missing key did not fail the provider")
            if any(secret in p.read_bytes().decode("latin1") for p in d.iterdir()):
                fails.append("the key was written to the cache")
        words, share = align("It costs twenty-four cents in the monorepo.", [
            {"w": "It", "start": 0.0, "end": 0.2}, {"w": "costs", "start": 0.25, "end": 0.5},
            {"w": "24", "start": 0.6, "end": 1.0}, {"w": "cents", "start": 1.1, "end": 1.4},
            {"w": "in", "start": 1.45, "end": 1.5}, {"w": "the", "start": 1.5, "end": 1.6},
            {"w": "mono", "start": 1.6, "end": 1.9}, {"w": "repo.", "start": 1.9, "end": 2.3}])
        if [w[1:] for w in words] != [(0.0, 0.2), (0.25, 0.5), (0.5, 1.1), (1.1, 1.4), (1.45, 1.5), (1.5, 1.6),
                                      (1.6, 2.3)] or abs(share - 25 / 35) > 1e-9:
            fails.append(f"align: {words}, {share:.2f}")
    finally:
        srv.shutdown()
    print("tts.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--self-test", action="store_true")
    if p.parse_args().self_test:
        return self_test()
    p.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
