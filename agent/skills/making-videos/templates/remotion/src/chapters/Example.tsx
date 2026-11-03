import { interpolateColors, useCurrentFrame } from "remotion";
import { at, ease } from "../cues";
import { Panel } from "../parts/Panel";
import { Terminal } from "../parts/Terminal";
import { C, FONT } from "../theme";

export const Intro = () => {
  const lit = ease(useCurrentFrame(), at("l2", "lights"));
  return (
    <Panel style={{ padding: "48px 80px", transform: `scale(${1 + 0.05 * lit})` }}>
      <div style={{ fontFamily: FONT, fontSize: 96, fontWeight: 700, color: interpolateColors(lit, [0, 1], [C.faint, C.accent]) }}>on cue</div>
    </Panel>
  );
};

export const Demo = () => (
  <Terminal
    title="~/film"
    style={{ width: 1100 }}
    lines={[
      { text: "bun test", at: at("l3", "types"), kind: "cmd" },
      { text: "12 pass, 0 fail", at: at("l3", "passes"), kind: "good" },
    ]}
  />
);
