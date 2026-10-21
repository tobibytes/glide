/**
 * A small, safe Markdown parser for extension Detail views. It produces a tree that
 * Markdown.tsx renders as React elements — raw HTML is never interpreted (it shows as text).
 * Supports: ATX headings, paragraphs, hard breaks, ul/ol lists, fenced code, blockquotes,
 * horizontal rules, inline code, **bold**, *italic*, [links](url), ![images](url) and bare URLs.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; src: string; alt: string }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "paragraph"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

const SAFE_HREF = /^(https?:|mailto:)/i;
export const isSafeHref = (href: string) => SAFE_HREF.test(href.trim());
export const isSafeImage = (src: string) => /^https:\/\//i.test(src.trim());

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last?.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Find the closing delimiter `d` starting at `from`, skipping escaped characters and code spans. */
function findClose(s: string, d: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (s.startsWith(d, i)) {
      // A single "*" must not be half of "**".
      if (d.length === 1 && (s[i + 1] === d || s[i - 1] === d)) continue;
      if (i > from) return i;
    }
  }
  return -1;
}

/** Parse "[text](url)" or "(url)" bracket pairs; returns [inner, href, endIndex] or null. */
function parseLinkAt(s: string, i: number): [string, string, number] | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const close = s.indexOf(")", j + 2);
  if (close < 0) return null;
  const href = s.slice(j + 2, close).trim().split(/\s+/)[0] ?? "";
  return [s.slice(i + 1, j), href, close + 1];
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && /[\\`*_[\]()#+\-.!>~|]/.test(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > 0) {
        out.push({ t: "code", v: s.slice(i + n, end).trim() });
        i = end + n;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] === ch) {
      const d = ch + ch;
      const end = findClose(s, d, i + 2);
      if (end > 0) {
        out.push({ t: "strong", c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || (ch === "_" && !/\w/.test(s[i - 1] ?? ""))) {
      const end = findClose(s, ch, i + 1);
      if (end > 0 && s[i + 1] !== " " && (ch === "*" || !/\w/.test(s[end + 1] ?? ""))) {
        out.push({ t: "em", c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "!" && s[i + 1] === "[") {
      const link = parseLinkAt(s, i + 1);
      if (link) {
        out.push({ t: "image", alt: link[0], src: link[1] });
        i = link[2];
        continue;
      }
    }
    if (ch === "[") {
      const link = parseLinkAt(s, i);
      if (link) {
        out.push({ t: "link", href: link[1], c: parseInline(link[0]) });
        i = link[2];
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(s.slice(i, i + 8)) && !/\w/.test(s[i - 1] ?? "")) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i.exec(s.slice(i));
      if (m) {
        out.push({ t: "link", href: m[0], c: [{ t: "text", v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function paragraphInline(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    const hard = /( {2,}|\\)$/.test(line);
    const text = line.replace(/( {2,}|\\)$/, "").trim();
    out.push(...parseInline(text));
    if (i < lines.length - 1) out.push(hard ? { t: "br" } : { t: "text", v: " " });
  });
  return out;
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
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
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
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ t: "quote", c: parseMarkdown(body.join("\n"), depth + 1) });
      continue;
    }
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      const ordered = !ul;
      const re = ordered ? OL : UL;
      const items: string[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) items.push([ordered ? m[2] : m[1]]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].push(lines[i]);
        else break;
        i++;
      }
      blocks.push({ t: "list", ordered, start: ordered ? Number(ol![1]) : 1, items: items.map(paragraphInline) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i]) && !QUOTE.test(lines[i])) para.push(lines[i++]);
    if (!para.length) {
      // Defensive: never loop forever on an unrecognised line.
      para.push(lines[i++]);
    }
    blocks.push({ t: "paragraph", c: paragraphInline(para) });
  }
  return blocks;
}
