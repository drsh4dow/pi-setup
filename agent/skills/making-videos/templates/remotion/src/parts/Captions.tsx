import { interpolate, useCurrentFrame } from "remotion";
import { clamp, sec, voice } from "../cues";
import { C, CAPTION_BAND, FONT, SIZE } from "../theme";

const all = voice.lines.flatMap((l) => l.captions.map((c) => ({ text: c.text, from: sec(c.start), to: sec(c.end) })));

export const Captions = () => {
  const frame = useCurrentFrame();
  const cap = all.find((c) => frame >= c.from && frame < c.to);
  if (!cap) return null;
  const o = interpolate(frame, [cap.from, cap.from + 4, cap.to - 3, cap.to], [0, 1, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: CAPTION_BAND, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: FONT, fontSize: SIZE.caption, fontWeight: 500, color: C.text, opacity: o * 0.94, textAlign: "center", maxWidth: 1560 }}>{cap.text}</div>
    </div>
  );
};
