// View command: re-renders the list as the user types (onSearchTextChange).
const { List, Action } = require("@glide/api");

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function parseColor(input) {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = s.match(/^rgba?\(?\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+[\d.]+%?)?\s*\)?$/);
  if (m) return { r: clamp(+m[1], 0, 255), g: clamp(+m[2], 0, 255), b: clamp(+m[3], 0, 255) };
  m = s.match(/^hsla?\(?\s*(\d{1,3}(?:\.\d+)?)(?:deg)?[\s,]+(\d{1,3}(?:\.\d+)?)%?[\s,]+(\d{1,3}(?:\.\d+)?)%?(?:[\s,/]+[\d.]+%?)?\s*\)?$/);
  if (m) return hslToRgb(+m[1] % 360, clamp(+m[2], 0, 100), clamp(+m[3], 0, 100));
  return null;
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const hex = ({ r, g, b }) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");

function formats(rgb) {
  const { h, s, l } = rgbToHsl(rgb);
  return [
    { id: "hex", title: hex(rgb), subtitle: "HEX" },
    { id: "rgb", title: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`, subtitle: "RGB" },
    { id: "hsl", title: `hsl(${h}, ${s}%, ${l}%)`, subtitle: "HSL" },
    { id: "swift", title: `Color(red: ${(rgb.r / 255).toFixed(3)}, green: ${(rgb.g / 255).toFixed(3)}, blue: ${(rgb.b / 255).toFixed(3)})`, subtitle: "SwiftUI" },
  ];
}

module.exports = async function convertColor(ctx) {
  const render = (text) => {
    const rgb = parseColor(text);
    if (!text.trim()) {
      return ctx.render(
        List({
          searchPlaceholder: "Type a color: #ff8800, rgb(255 136 0), hsl(32 100% 50%)",
          onSearchTextChange: render,
          items: ["#ff8800", "rgb(46, 211, 183)", "hsl(250, 80%, 65%)"].map((example) => ({
            id: example,
            title: example,
            subtitle: "Example",
            icon: hex(parseColor(example)),
            actions: [Action.CopyToClipboard(example)],
          })),
        }),
      );
    }
    ctx.render(
      List({
        searchPlaceholder: "Type a color…",
        onSearchTextChange: render,
        emptyText: `"${text}" is not a color I understand`,
        items: rgb
          ? formats(rgb).map((f) => ({
              ...f,
              icon: hex(rgb),
              accessories: [{ tag: "Copy" }],
              actions: [Action.CopyToClipboard(f.title, { title: `Copy ${f.subtitle}` }), Action.Paste(f.title, { title: `Paste ${f.subtitle}` })],
            }))
          : [],
      }),
    );
  };
  render(ctx.arguments.color || "");
};
