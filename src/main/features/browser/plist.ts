/** Minimal XML property-list parser (output of `plutil -convert xml1 -o - <file>`), enough for Safari's Bookmarks.plist. */

export type PlistValue = string | number | boolean | Date | PlistValue[] | { [key: string]: PlistValue } | null;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parsePlistXml(xml: string): PlistValue {
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /<(\/?)([a-zA-Z]+)(\s*\/)?>|([^<]+)/g;
  type Frame = { kind: "dict"; obj: Record<string, PlistValue>; key?: string } | { kind: "array"; arr: PlistValue[] } | { kind: "root"; value?: PlistValue };
  const stack: Frame[] = [{ kind: "root" }];
  let text = "";
  let open: string | undefined;

  const add = (v: PlistValue) => {
    const top = stack[stack.length - 1]!;
    if (top.kind === "array") top.arr.push(v);
    else if (top.kind === "dict") {
      if (top.key !== undefined) {
        top.obj[top.key] = v;
        top.key = undefined;
      }
    } else top.value = v;
  };

  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[4] !== undefined) {
      if (open) text += m[4];
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2]!;
    const selfClosing = !!m[3];
    if (tag === "plist") continue;
    if (!closing && (tag === "dict" || tag === "array")) {
      if (selfClosing) add(tag === "dict" ? {} : []);
      else stack.push(tag === "dict" ? { kind: "dict", obj: {} } : { kind: "array", arr: [] });
      continue;
    }
    if (closing && (tag === "dict" || tag === "array")) {
      const f = stack.pop();
      if (f?.kind === "dict") add(f.obj);
      else if (f?.kind === "array") add(f.arr);
      continue;
    }
    if (!closing) {
      if (tag === "true" || tag === "false") {
        add(tag === "true");
        continue;
      }
      if (selfClosing) {
        add(tag === "string" || tag === "key" ? "" : null);
        continue;
      }
      open = tag;
      text = "";
      continue;
    }
    // closing scalar
    const raw = decode(text);
    open = undefined;
    text = "";
    if (tag === "key") {
      const top = stack[stack.length - 1]!;
      if (top.kind === "dict") top.key = raw;
    } else if (tag === "string") add(raw);
    else if (tag === "integer" || tag === "real") add(Number(raw.trim()));
    else if (tag === "date") add(new Date(raw.trim()));
    else add(null); // <data> blobs are irrelevant here
  }
  const root = stack[0]!;
  return root.kind === "root" ? (root.value ?? null) : null;
}
