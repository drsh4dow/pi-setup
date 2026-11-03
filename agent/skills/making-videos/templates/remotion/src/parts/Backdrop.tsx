import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C } from "../theme";

export const Backdrop = () => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 240) * 8;
  const y = 38 + Math.cos(frame / 300) * 6;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at ${x}% ${y}%, ${C.accent}29, transparent 70%)` }} />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.dim}0A 1px, transparent 1px), linear-gradient(90deg, ${C.dim}0A 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(ellipse at 50% 45%, black 30%, transparent 80%)",
        }}
      />
    </AbsoluteFill>
  );
};
