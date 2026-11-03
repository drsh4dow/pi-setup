import { useCurrentFrame } from "remotion";
import { C, MONO, SIZE } from "../theme";
import { Panel } from "./Panel";

export type TermLine = { text: string; at: number; kind?: "cmd" | "out" | "good" | "bad" | "dim" };

const color = { out: C.dim, good: C.good, bad: C.bad, dim: C.faint };
const CHARS_PER_FRAME = 1.1;

// A terminal whose commands type out from their `at` frame and whose output lines appear at theirs.
// A line never appears before the command above it has finished typing.
export const Terminal = ({ title, lines, style, fontSize = SIZE.label }: { title: string; lines: TermLine[]; style?: React.CSSProperties; fontSize?: number }) => {
  const frame = useCurrentFrame();
  let typed = 0;
  const timed = lines.map((l) => {
    const at = Math.max(l.at, typed);
    if (l.kind === "cmd") typed = at + Math.ceil(l.text.length / CHARS_PER_FRAME);
    return { ...l, at };
  });
  const shown = timed.filter((l) => frame >= l.at);
  const typing = shown.findLast((l) => l.kind === "cmd");
  return (
    <Panel style={{ overflow: "hidden", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: `1px solid ${C.line}` }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: 12, height: 12, borderRadius: 6, background: C.faint }} />
        ))}
        <div style={{ fontFamily: MONO, fontSize: SIZE.small, color: C.dim, marginLeft: 10 }}>{title}</div>
      </div>
      <div style={{ padding: "16px 22px", fontFamily: MONO, fontSize, lineHeight: 1.5, whiteSpace: "pre" }}>
        {shown.map((l, i) => {
          if (l.kind !== "cmd") return <div key={i} style={{ color: color[l.kind ?? "out"] }}>{l.text}</div>;
          const n = Math.min(l.text.length, Math.floor((frame - l.at) * CHARS_PER_FRAME));
          const caret = l === typing && (n < l.text.length || Math.floor(frame / 15) % 2 === 0);
          return (
            <div key={i} style={{ color: C.text }}>
              <span style={{ color: C.accent }}>$ </span>
              {l.text.slice(0, n)}
              {caret ? <span style={{ background: C.text, color: C.bg }}> </span> : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
};
