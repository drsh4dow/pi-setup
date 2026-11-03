import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { clamp, CROSSFADE, sceneWindow } from "../cues";
import { CAPTION_BAND } from "../theme";
import { Backdrop } from "./Backdrop";

// Mounts a chapter only inside its window. Chapters read the film's absolute frame.
// Each window carries its own backdrop, so the incoming one dissolves over an opaque outgoing picture and nothing dips dark.
// `through` stretches one picture over several chapters with no cut between them.
// `footage` holds recorded footage at one scale; drawn graphics get a slow push-in so no shot is ever fully still.
export const SceneWindow = ({ id, through, footage, children }: { id: string; through?: string; footage?: boolean; children: React.ReactNode }) => {
  const frame = useCurrentFrame();
  const { from } = sceneWindow(id);
  const { to } = sceneWindow(through ?? id);
  const half = CROSSFADE / 2;
  if (frame < from - half || frame >= to + half) return null;
  const fadeIn = from === 0 ? 1 : interpolate(frame, [from - half, from + half], [0, 1], clamp);
  const drift = from === 0 ? 0 : interpolate(frame, [from - half, from + 20], [14, 0], clamp);
  const push = footage ? 1 : 1 + 0.018 * interpolate(frame, [from, to], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <Backdrop />
      <AbsoluteFill style={{ bottom: CAPTION_BAND, alignItems: "center", justifyContent: "center", transform: `translateY(${drift}px) scale(${push})` }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
