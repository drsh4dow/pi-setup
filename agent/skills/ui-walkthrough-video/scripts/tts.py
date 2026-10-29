#!/usr/bin/env python3
"""ElevenLabs narration with character timestamps, cached per line on disk.

    tts.py --cache DIR [--offline] "First line." "Second line."   # prints one JSON object per line
    tts.py --self-test

The voice and model are catchup-video's (read from ../../catchup-video/scripts/narration.ts, so the two skills
never drift); ELEVENLABS_VOICE_ID overrides the voice, as it does there. Each line is cached under DIR as
<sha256(text, model, voice, format)[:20]>.{wav,json}; a recut calls the API only for lines whose text changed.
--offline (or calling with ELEVENLABS_API_KEY unset) turns a cache miss into an error, so a rebuild can never
re-voice by accident and a fully cached rebuild is bit-identical. The key travels only in the xi-api-key header
and is never printed or written. Send only narration you would publish: this text leaves the machine.

As a module: synth(text, cache_dir, offline=False) -> {wav, duration, words: [{w, start, end}], voiced_start,
voiced_end}, times in seconds from the clip start.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

FORMAT, RATE = "pcm_24000", 24000
NARRATION_TS = Path(__file__).resolve().parent.parent.parent / "catchup-video" / "scripts" / "narration.ts"


def voice_settings() -> tuple[str, str]:
    """(model, voice) from catchup-video's narration.ts; ELEVENLABS_VOICE_ID overrides the voice."""
    src = NARRATION_TS.read_text()
    model = re.search(r'ELEVEN_MODEL\s*=\s*"([^"]+)"', src)
    voice = re.search(r'ELEVEN_VOICE\s*=\s*"([^"]+)"', src)
    if not (model and voice):
        raise SystemExit(f"tts.py: ELEVEN_MODEL or ELEVEN_VOICE not found in {NARRATION_TS}")
    return model.group(1), os.environ.get("ELEVENLABS_VOICE_ID") or voice.group(1)


def _post(text: str, model: str, voice: str) -> dict:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise SystemExit("tts.py: ELEVENLABS_API_KEY is unset and the line is not cached")
    base = os.environ.get("UIW_ELEVENLABS_URL", "https://api.elevenlabs.io")
    url = f"{base}/v1/text-to-speech/{voice}/with-timestamps?output_format={FORMAT}"
    body = json.dumps({"text": text, "model_id": model}).encode()
    last = None
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"xi-api-key": key, "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (400, 401, 402, 403, 422):
                break
        except Exception as e:  # network errors carry no secret; report only the type
            last = type(e).__name__
        time.sleep(2 * (attempt + 1))
    raise SystemExit(f"tts.py: ElevenLabs failed: {last}")


def synth(text: str, cache: Path, offline: bool = False) -> dict:
    model, voice = voice_settings()
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256(json.dumps([text, model, voice, FORMAT]).encode()).hexdigest()[:20]
    wav, meta = cache / f"{h}.wav", cache / f"{h}.json"
    if not (wav.exists() and meta.exists()):
        if offline:
            raise SystemExit(f"tts.py: not cached and --offline: {text[:60]!r}")
        data = _post(text, model, voice)
        pcm = base64.b64decode(data["audio_base64"])
        with tempfile.NamedTemporaryFile(suffix=".pcm", dir=cache, delete=False) as f:
            f.write(pcm)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", f.name,
                        "-ar", "48000", str(wav)], check=True)
        os.unlink(f.name)
        al = data.get("alignment") or {}
        tmp = meta.with_suffix(".tmp")
        tmp.write_text(json.dumps({"text": text, "model": model, "voice": voice, "chars": al.get("characters"),
                                   "starts": al.get("character_start_times_seconds"),
                                   "ends": al.get("character_end_times_seconds"), "pcm_bytes": len(pcm)}))
        tmp.replace(meta)
    m = json.loads(meta.read_text())
    duration = m["pcm_bytes"] / 2 / RATE
    words, cur, s0, e0 = [], "", None, None
    for c, s, e in zip(m["chars"] or [], m["starts"] or [], m["ends"] or []):
        if c.isspace():
            if cur:
                words.append({"w": cur, "start": s0, "end": e0})
            cur, s0 = "", None
            continue
        s0 = s if s0 is None else s0
        cur, e0 = cur + c, e
    if cur:
        words.append({"w": cur, "start": s0, "end": e0})
    return {"wav": str(wav), "duration": duration, "words": words,
            "voiced_start": words[0]["start"] if words else 0.0,
            "voiced_end": min(words[-1]["end"] if words else duration, duration)}


def self_test() -> int:
    from http.server import BaseHTTPRequestHandler, HTTPServer

    fails, hits, seen_keys = [], [], []
    secret = "sk-selftest-not-a-real-key"

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen_keys.append(self.headers.get("xi-api-key"))
            text = json.loads(self.rfile.read(int(self.headers["content-length"])))["text"]
            hits.append(self.path)
            n = RATE  # one second of a quiet tone
            pcm = b"".join(int(3000 * ((i // 40) % 2 * 2 - 1)).to_bytes(2, "little", signed=True) for i in range(n))
            step = 0.9 / len(text)
            body = json.dumps({"audio_base64": base64.b64encode(pcm).decode(), "alignment": {
                "characters": list(text), "character_start_times_seconds": [0.05 + i * step for i in range(len(text))],
                "character_end_times_seconds": [0.05 + (i + 1) * step for i in range(len(text))]}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ.update(UIW_ELEVENLABS_URL=f"http://127.0.0.1:{srv.server_port}", ELEVENLABS_API_KEY=secret)
    try:
        model, voice = voice_settings()
        with tempfile.TemporaryDirectory() as tmp:
            a = synth("Three synthetic words.", Path(tmp))
            b = synth("Three synthetic words.", Path(tmp))
            if len(hits) != 1:
                fails.append(f"the cached line hit the API {len(hits)} times")
            if f"/v1/text-to-speech/{voice}/with-timestamps" not in (hits or [""])[0]:
                fails.append(f"request path {hits} does not use catchup-video's voice {voice}")
            if seen_keys != [secret]:
                fails.append("the key did not travel in the xi-api-key header")
            if [w["w"] for w in a["words"]] != ["Three", "synthetic", "words."] or a != b:
                fails.append(f"words {a['words']}")
            if abs(a["duration"] - 1.0) > 1e-6 or not Path(a["wav"]).exists():
                fails.append(f"duration {a['duration']}")
            if any(secret in p.read_bytes().decode("latin1") for p in Path(tmp).iterdir()):
                fails.append("the key was written to the cache")
            try:
                synth("Never voiced.", Path(tmp), offline=True)
                fails.append("an offline cache miss did not fail")
            except SystemExit:
                pass
    finally:
        srv.shutdown()
    print(f"tts.py self-test (model {model}, voice from catchup-video): " + ("PASS" if not fails else
                                                                             "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    if "--cache" not in a:
        raise SystemExit("tts.py: --cache DIR is required")
    i = a.index("--cache")
    cache, rest = Path(a[i + 1]), a[:i] + a[i + 2:]
    offline = "--offline" in rest
    for text in (x for x in rest if x != "--offline"):
        print(json.dumps(synth(text, cache, offline)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
