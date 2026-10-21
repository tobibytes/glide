/**
 * Tiny Markdown parser for AI answers. Produces a plain AST that Markdown.tsx renders with
 * React elements — raw HTML is never interpreted (it stays literal text), and links are kept
 * only for http(s)/mailto URLs. Tolerates partial input while a response is streaming.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export interface ListItem {
  c: Inline[];
  checked?: boolean;
  children?: Block[];
}

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "code"; lang: string; v: string; open: boolean }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

const SAFE_PROTOCOLS = ["http:", "https:", "mailto:"];

export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  try {
    const u = new URL(href);
    return SAFE_PROTOCOLS.includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

const AUTOLINK = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~>]/.test(src[i + 1])) {
      pushText(out, src[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "\n") {
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        out.push({ t: "code", v: src.slice(i + ticks.length, end).replace(/^ (.*) $/, "$1") });
        i = end + ticks.length;
        continue;
      }
      pushText(out, ticks);
      i += ticks.length;
      continue;
    }
    if (depth < 6) {
      if (ch === "[") {
        const m = /^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
        if (m) {
          const href = safeHref(m[2]);
          const children = parseInline(m[1], depth + 1);
          if (href) out.push({ t: "link", href, c: children.length ? children : [{ t: "text", v: href }] });
          else for (const c of children) c.t === "text" ? pushText(out, c.v) : out.push(c);
          i += m[0].length;
          continue;
        }
      }
      const strong = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest);
      if (strong) {
        out.push({ t: "strong", c: parseInline(strong[2], depth + 1) });
        i += strong[0].length;
        continue;
      }
      const del = /^~~(?=\S)([\s\S]+?)(?<=\S)~~/.exec(rest);
      if (del) {
        out.push({ t: "del", c: parseInline(del[1], depth + 1) });
        i += del[0].length;
        continue;
      }
      const prev = i > 0 ? src[i - 1] : " ";
      if ((ch === "*" || (ch === "_" && !/\w/.test(prev))) && src[i + 1] !== ch) {
        const re = ch === "*" ? /^\*(?=\S)([^*\n]+?)(?<=\S)\*/ : /^_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/;
        const em = re.exec(rest);
        if (em) {
          out.push({ t: "em", c: parseInline(em[1], depth + 1) });
          i += em[0].length;
          continue;
        }
      }
      if ((ch === "h" || ch === "H") && !/\w/.test(prev)) {
        const m = AUTOLINK.exec(rest);
        const href = m ? safeHref(m[0]) : null;
        if (m && href) {
          out.push({ t: "link", href, c: [{ t: "text", v: m[0] }] });
          i += m[0].length;
          continue;
        }
      }
    }
    // Plain run up to the next special character.
    const next = rest.slice(1).search(/[\\`\n[*_~hH]/);
    const take = next < 0 ? rest.length : next + 1;
    pushText(out, rest.slice(0, take));
    i += take;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

function indentOf(s: string): number {
  return s.replace(/\t/g, "  ").length;
}

export function parseMarkdown(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      let open = true;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker[0].repeat(marker.length)) && /^\s*[`~]+\s*$/.test(lines[i])) {
          open = false;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n"), open });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: "heading", level: h[1].length, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < 4) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ t: "quote", c: parseMarkdown(body.join("\n"), depth + 1) });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const baseIndent = indentOf(li[1]);
      const ordered = /\d/.test(li[2]);
      const list: Extract<Block, { t: "list" }> = { t: "list", ordered, start: ordered ? parseInt(li[2], 10) : 1, items: [] };
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (!m || indentOf(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
        let text = m[3];
        let checked: boolean | undefined;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (task) {
          checked = task[1] !== " ";
          text = task[2];
        }
        const textLines = [text];
        const nested: string[] = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // A blank line ends the item unless indented content follows.
            const nxt = lines[i + 1];
            if (nxt !== undefined && nxt.trim() && indentOf(/^\s*/.exec(nxt)![0]) > baseIndent) {
              nested.push("");
              i++;
              continue;
            }
            break;
          }
          const sub = LIST.exec(l);
          const ind = indentOf(/^\s*/.exec(l)![0]);
          if (sub && ind <= baseIndent) break;
          if (ind > baseIndent && (sub || nested.length || FENCE.test(l.trim()))) {
            nested.push(l.slice(Math.min(ind, baseIndent + 2)));
          } else if (!sub && !nested.length && !FENCE.test(l) && !HEADING.test(l)) {
            textLines.push(l.trim());
          } else break;
          i++;
        }
        const item: ListItem = { c: parseInline(textLines.join("\n")), checked };
        if (nested.length && depth < 4) item.children = parseMarkdown(nested.join("\n"), depth + 1);
        list.items.push(item);
        while (i < lines.length && !lines[i].trim()) {
          const nxt = LIST.exec(lines[i + 1] ?? "");
          if (nxt && indentOf(nxt[1]) === baseIndent && /\d/.test(nxt[2]) === ordered) i++;
          else break;
        }
      }
      blocks.push(list);
      continue;
    }
    // Paragraph: until blank line or another block starts.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i]) && !QUOTE.test(lines[i]) && !(para.length && LIST.exec(lines[i]))) {
      para.push(lines[i].trim());
      i++;
    }
    if (!para.length) {
      // Defensive: never loop forever on an unrecognised line.
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ t: "para", c: parseInline(para.join("\n")) });
  }
  return blocks;
}
