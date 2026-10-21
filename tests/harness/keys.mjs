// Key descriptors for Input.dispatchKeyEvent. Modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
export const MOD = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

const NAMED = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Delete: { code: "Delete", vk: 46 },
  Shift: { code: "ShiftLeft", vk: 16 },
};

const PUNCT = { "/": ["Slash", 191], ".": ["Period", 190], ",": ["Comma", 188], "-": ["Minus", 189], "=": ["Equal", 187], ";": ["Semicolon", 186], "[": ["BracketLeft", 219], "]": ["BracketRight", 221] };

/**
 * Parse "Enter", "j", "G", "cmd+k", "meta+shift+Enter" into a key event descriptor.
 * @returns {{ key: string, code: string, vk: number, text?: string, modifiers: number }}
 */
export function parseKey(spec) {
  const parts = spec.split("+");
  // "cmd++" style: a trailing empty part means the key itself is "+".
  let name = parts.pop() || "+";
  let modifiers = 0;
  for (const p of parts) {
    const bit = MOD[p.toLowerCase()];
    if (bit === undefined) throw new Error(`unknown modifier ${p} in ${spec}`);
    modifiers |= bit;
  }
  if (NAMED[name]) {
    const n = NAMED[name];
    return { key: n.key ?? name, code: n.code, vk: n.vk, text: modifiers & (MOD.meta | MOD.ctrl | MOD.alt) ? undefined : n.text, modifiers };
  }
  if (name.length !== 1) throw new Error(`unknown key ${name}`);
  let code = "", vk = 0;
  if (/[a-z]/i.test(name)) {
    code = `Key${name.toUpperCase()}`;
    vk = name.toUpperCase().charCodeAt(0);
    if (/[A-Z]/.test(name)) modifiers |= MOD.shift;
  } else if (/[0-9]/.test(name)) {
    code = `Digit${name}`;
    vk = name.charCodeAt(0);
  } else if (PUNCT[name]) [code, vk] = PUNCT[name];
  const text = modifiers & (MOD.meta | MOD.ctrl | MOD.alt) ? undefined : name;
  return { key: name, code, vk, text, modifiers };
}
