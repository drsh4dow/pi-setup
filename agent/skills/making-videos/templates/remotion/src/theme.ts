import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

export const W = 1920;
export const H = 1080;
export const CAPTION_BAND = 150;

// Nothing on screen goes below `small`.
export const SIZE = { caption: 36, label: 26, small: 22 };

// One meaning per colour across the whole film. Rename a slot's meaning per film, never reuse a colour for two.
export const C = {
  bg: "#0B0F17",
  panel: "#131A26",
  panelHi: "#19212F",
  line: "#94A3B829",
  text: "#E8ECF2",
  dim: "#8E9AAD",
  faint: "#4A5568",
  accent: "#7C9CFF", // the film's subject
  good: "#3DD68C", // verified, it worked
  warn: "#FFB547", // a human's call
  bad: "#FF6B81", // broke, or a risk
};

export const FONT = "Inter, sans-serif";
export const MONO = "'Geist Mono', monospace";

// Latin-1 subset woff2 files. A multi-megabyte font can stall the render past its timeout.
const FACES = [
  ["Inter", "fonts/inter-latin-variable.woff2", "100 900"],
  ["Geist Mono", "fonts/GeistMono-Regular.woff2", "400"],
];

// Call it once, in the root component.
export const useFonts = () => {
  const [handle] = useState(() => delayRender("fonts", { timeoutInMilliseconds: 60000 }));
  useEffect(() => {
    Promise.all(
      FACES.map(([family, file, weight]) =>
        new FontFace(family, `url(${staticFile(file)}) format("woff2")`, { weight }).load().then((f) => (document.fonts as unknown as Set<FontFace>).add(f)),
      ),
    ).then(() => continueRender(handle), cancelRender);
  }, [handle]);
};
