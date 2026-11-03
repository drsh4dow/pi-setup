import { C } from "../theme";

const drop = "0 18px 60px rgba(0,0,0,0.45)";

// `glow` tints the border with one of the theme's meaning colours.
export const Panel = ({ children, style, glow }: { children?: React.ReactNode; style?: React.CSSProperties; glow?: string }) => (
  <div
    style={{
      background: `linear-gradient(180deg, ${C.panelHi}, ${C.panel})`,
      border: `1.5px solid ${glow ?? C.line}`,
      borderRadius: 18,
      boxShadow: glow ? `0 0 0 1px ${glow}22, ${drop}, 0 0 48px ${glow}26` : drop,
      ...style,
    }}
  >
    {children}
  </div>
);
