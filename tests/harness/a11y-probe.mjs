// In-page accessibility probes. Every function here is serialised into the renderer with
// Page.eval, so each must be self-contained (no imports, no closures).

/**
 * Static + focus audit of the current document.
 * Rules: "name" (interactive element without an accessible name), "keyboard" (interactive but not
 * reachable from the keyboard), "focus-visible" (focusable without a visible focus indicator),
 * "contrast" (text below WCAG AA: 4.5:1, 3:1 for large text).
 */
export function auditDocument(screen) {
  const WIDGET_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "textbox", "searchbox", "combobox", "treeitem", "gridcell"]);
  const MANAGED_ROLES = new Set(["option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "gridcell", "tab", "radio"]);
  const COMPOSITE = '[role="listbox"],[role="menu"],[role="menubar"],[role="tree"],[role="grid"],[role="tablist"],[role="radiogroup"]';
  const NATIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable=""],[contenteditable="true"]';

  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const reactProps = (el) => {
    for (const k in el) if (k.startsWith("__reactProps$")) return el[k];
    return null;
  };
  const clickable = (el) => {
    const p = reactProps(el);
    return !!p && (typeof p.onClick === "function" || typeof p.onMouseDown === "function");
  };
  const disabled = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";
  const focusable = (el) => !disabled(el) && el.tabIndex >= 0 && (el.matches(NATIVE) || el.hasAttribute("tabindex"));
  const textOf = (el) => (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const name = (el) => {
    const label = el.getAttribute("aria-label");
    if (label?.trim()) return label.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(" ").trim();
      if (t) return t;
    }
    if (el.labels?.length) {
      const t = [...el.labels].map(textOf).join(" ").trim();
      if (t) return t;
    }
    if (el.tagName === "IMG") return el.getAttribute("alt") ?? "";
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/.test(el.type)) return el.value;
    const role = el.getAttribute("role");
    const nameFromContent = !el.matches("input,select,textarea") && !(role && /^(textbox|searchbox|combobox|slider|spinbutton)$/.test(role));
    if (nameFromContent) {
      const t = textOf(el);
      if (t) return t;
    }
    if (el.getAttribute("title")?.trim()) return el.getAttribute("title").trim();
    if (el.getAttribute("placeholder")?.trim()) return el.getAttribute("placeholder").trim();
    return "";
  };
  const firstClass = (e) => (e && typeof e.className === "string" ? e.className.split(/\s+/).filter((c) => c && !/--(selected|on|active|focus|hover)/.test(c))[0] : "") || "";
  // Stable across data: text is only part of the key for chrome controls, never for list rows
  // (rows show user/system data such as processes or bookmarks).
  const sig = (el, { withText = true } = {}) => {
    const role = el.getAttribute("role");
    const cls = firstClass(el);
    const parent = firstClass(el.parentElement);
    const inData = !!el.closest('[role="option"],[role="row"],[role="listbox"],li,tr');
    const n = withText && !inData ? name(el).slice(0, 32) : "";
    return `${parent ? `${parent} > ` : ""}${el.tagName.toLowerCase()}${role ? `[${role}]` : ""}${cls ? `.${cls}` : ""}${n ? ` "${n}"` : ""}`;
  };

  // --- colours -----------------------------------------------------------------
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const parse = (c) => {
    if (cache.has(c)) return cache.get(c);
    let out;
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      out = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    } else {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2], d[3] / 255];
    }
    cache.set(c, out);
    return out;
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  // The window itself is transparent (vibrancy): fall back to the theme's background token.
  const rootVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const themeBg = parse(rootVar("--bg") || rootVar("--surface") || (matchMedia("(prefers-color-scheme: dark)").matches ? "#1e1e1e" : "#ffffff"));
  const backdrop = [themeBg[0], themeBg[1], themeBg[2], 1];
  const background = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !/^url\(/.test(cs.backgroundImage)) return null; // gradient: unknown
      const c = parse(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg = backdrop;
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };

  const violations = [];
  const add = (rule, el, detail) => violations.push({ rule, key: `${rule}|${sig(el, { withText: rule !== "contrast" })}`, screen, detail });

  // --- interactive elements: name + keyboard ------------------------------------
  const all = [...document.querySelectorAll("body *")].filter((el) => !el.closest("script,style,svg *"));
  const interactive = all.filter((el) => (el.matches(NATIVE) || WIDGET_ROLES.has(el.getAttribute("role")) || clickable(el)) && visible(el) && !disabled(el));
  // A clickable wrapper whose child is the real control (or vice versa) is one control.
  const outer = interactive.filter((el) => !interactive.some((o) => o !== el && o.contains(el) && (focusable(o) || MANAGED_ROLES.has(o.getAttribute("role")))));
  const hasDriver = !!document.querySelector('input:not([type="hidden"]):not([disabled]), [role="combobox"], textarea');
  let focusables = 0;
  for (const el of outer) {
    const role = el.getAttribute("role");
    if (!name(el)) add("name", el, "no accessible name");
    if (focusable(el)) {
      focusables++;
      continue;
    }
    // Controls that advertise their own shortcut (⌘P, aria-keyshortcuts) are keyboard operable.
    if (el.hasAttribute("aria-keyshortcuts") || /[⌘⌥⌃]\s*\S/.test(name(el))) continue;
    if (role && MANAGED_ROLES.has(role)) {
      const box = el.closest(COMPOSITE);
      const controlled = box && box.id && document.querySelector(`[aria-controls~="${box.id}"],[aria-owns~="${box.id}"]`);
      const roving = box && [...box.querySelectorAll(`[role="${role}"]`)].some((x) => x.tabIndex >= 0);
      // Launcher pattern: the search field drives every list (arrows, j/k) via aria-activedescendant/NavList.
      if (box && (box.tabIndex >= 0 || controlled || roving || hasDriver)) continue;
    }
    add("keyboard", el, clickable(el) ? "click handler but not focusable and not part of a keyboard-managed list" : "widget role but not focusable");
  }

  // --- contrast -----------------------------------------------------------------
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let textChecked = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim() || !visible(el) || el.closest("script,style,[disabled],[aria-disabled='true']")) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = background(el);
    if (!bg) continue;
    const alpha = fg[3] * opacity(el);
    if (alpha < 0.05) continue; // invisible until hover/selection (e.g. ⌘1 badges): not readable text
    const fgOnBg = over([fg[0], fg[1], fg[2], alpha], bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const r = ratio(fgOnBg, bg);
    textChecked++;
    if (r < (large ? 3 : 4.5)) add("contrast", el, `${r.toFixed(2)}:1 (needs ${large ? 3 : 4.5}) text="${n.textContent.trim().slice(0, 30)}"`);
  }
  return { screen, interactive: outer.length, focusables, textChecked, violations };
}

/** Focus each focusable element (keyboard modality must already be set) and check for a visible change. */
export function auditFocusRings(screen) {
  const NATIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable=""],[contenteditable="true"],[tabindex]';
  const textOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.title || "").replace(/\s+/g, " ").trim().slice(0, 32);
  const firstClass = (e) => (e && typeof e.className === "string" ? e.className.split(/\s+/).filter((c) => c && !/--(selected|on|active|focus|hover)/.test(c))[0] : "") || "";
  const sig = (el) => {
    const role = el.getAttribute("role");
    const cls = firstClass(el);
    const parent = firstClass(el.parentElement);
    const n = el.closest('[role="option"],[role="row"],[role="listbox"],li,tr') ? "" : textOf(el);
    return `${parent ? `${parent} > ` : ""}${el.tagName.toLowerCase()}${role ? `[${role}]` : ""}${cls ? `.${cls}` : ""}${n ? ` "${n}"` : ""}`;
  };
  const visible = (el) => {
    if (!el.getClientRects().length || el.closest('[aria-hidden="true"],[inert]')) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const props = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "backgroundColor", "borderTopColor", "borderBottomColor", "color", "textDecorationLine"];
  const snap = (el) => {
    const out = {};
    for (const target of [el, el.parentElement].filter(Boolean)) {
      const cs = getComputedStyle(target);
      for (const p of props) out[`${target === el ? "" : "parent."}${p}`] = cs[p];
    }
    return out;
  };
  const els = [...document.querySelectorAll(NATIVE)].filter((el) => el.tabIndex >= 0 && !el.disabled && visible(el));
  const violations = [];
  let checked = 0;
  for (const el of els) {
    const before = snap(el);
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) continue;
    checked++;
    const after = snap(el);
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.outlineColor);
    const changed = Object.keys(after).some((k) => k !== "outlineStyle" && after[k] !== before[k]);
    // Text fields show a caret; that counts as a focus indicator.
    const caret = el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]),textarea,[contenteditable]') && cs.caretColor !== "transparent";
    if (!outline && !changed && !caret) violations.push({ rule: "focus-visible", key: `focus-visible|${sig(el)}`, screen, detail: `no outline/box-shadow/colour change on focus (focus-visible=${el.matches(":focus-visible")})` });
    el.blur();
  }
  return { checked, violations };
}

/** Real Tab traversal is driven from Node; this returns a stable signature of document.activeElement. */
export function activeSignature() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const path = [];
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
    path.unshift(`${e.tagName}:${i}`);
  }
  return path.join(">");
}

/** Signatures (same scheme as activeSignature) of every element that should be in the Tab order. */
export function tabbableSignatures() {
  const NATIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable=""],[contenteditable="true"],[tabindex]';
  const pathOf = (el) => {
    const path = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
      path.unshift(`${e.tagName}:${i}`);
    }
    return path.join(">");
  };
  return [...document.querySelectorAll(NATIVE)]
    .filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.closest('[aria-hidden="true"],[inert]'))
    // Radio groups expose one tab stop.
    .filter((el, _i, arr) => !(el.type === "radio" && el.name && arr.find((o) => o.type === "radio" && o.name === el.name) !== el))
    .map((el) => ({ path: pathOf(el), label: `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || "").trim().slice(0, 30)}"` }));
}
