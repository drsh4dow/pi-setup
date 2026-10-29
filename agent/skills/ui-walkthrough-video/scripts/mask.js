// In-page privacy mask for recordings: paints an opaque box over every email address and every literal term
// in window.__uiwMaskTerms (names, IDs you listed before capture), in text nodes and visible textareas,
// redrawn every 80 ms so scrolling and re-renders stay covered. Inject it before `record start`:
//   agent-browser --session S eval "window.__uiwMaskTerms=['A Name']"   # optional, before the mask
//   agent-browser --session S eval "$(cat mask.js)"
// A pattern mask cannot know a name it was not given: check full-resolution export frames anyway.
// Self-test: cdp.mjs --self-test injects it into a headless page and checks the box covers the email.
(() => {
  if (window.__uiwMask) return true;
  const CLS = "uiw-private-mask";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = () => {
    const terms = (window.__uiwMaskTerms || []).filter(Boolean).map(esc);
    return new RegExp(["[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", ...terms].join("|"), "gi");
  };
  const box = (b, extra) => {
    const d = document.createElement("div");
    d.className = CLS;
    Object.assign(d.style, {
      position: "fixed", left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`,
      background: "#111", zIndex: 2147483646, pointerEvents: "none", ...extra,
    });
    document.body.append(d);
    return d;
  };
  const paint = () => {
    document.querySelectorAll(`.${CLS}`).forEach((e) => e.remove());
    const re = pattern();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest(`script,style,textarea,input,.${CLS}`)) continue;
      for (const m of n.textContent.matchAll(re)) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        for (const b of r.getClientRects()) if (b.width && b.height) box(b);
      }
    }
    for (const t of document.querySelectorAll("textarea,input")) {
      re.lastIndex = 0;
      if (!t.checkVisibility?.({ checkVisibilityCSS: true, checkOpacity: true }) || !re.test(t.value)) continue;
      const b = t.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const c = getComputedStyle(t);
      const d = box(b, {
        background: c.backgroundColor === "rgba(0, 0, 0, 0)" ? "white" : c.backgroundColor, color: c.color,
        font: c.font, lineHeight: c.lineHeight, padding: c.padding, border: c.border, boxSizing: c.boxSizing,
        whiteSpace: "pre-wrap", overflow: "hidden", overflowWrap: "break-word",
      });
      d.textContent = t.value.replace(pattern(), "[masked]");
      d.scrollTop = t.scrollTop;
    }
  };
  paint();
  window.__uiwMask = setInterval(paint, 80);
  return true;
})();
