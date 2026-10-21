/** Pure OCR/barcode result handling: reading-order text assembly and payload classification. */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecognizedLine {
  text: string;
  confidence: number;
  /** Normalised 0…1, origin top-left. */
  box: Box;
}

/**
 * Vision returns one observation per text run. Rebuild reading order: runs whose vertical extents overlap by more
 * than half form one row (joined left→right); a vertical gap larger than ~1.2 line heights starts a new paragraph.
 */
export function assembleText(lines: RecognizedLine[], minConfidence = 0): string {
  const runs = lines.filter((l) => l.text.trim() && l.confidence >= minConfidence).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (!runs.length) return "";
  const rows: RecognizedLine[][] = [];
  for (const run of runs) {
    const row = rows[rows.length - 1];
    if (row) {
      const top = Math.min(...row.map((r) => r.box.y));
      const bottom = Math.max(...row.map((r) => r.box.y + r.box.height));
      const overlap = Math.min(bottom, run.box.y + run.box.height) - Math.max(top, run.box.y);
      if (overlap > 0.5 * Math.min(bottom - top, run.box.height)) {
        row.push(run);
        continue;
      }
    }
    rows.push([run]);
  }
  const heights = rows.map((r) => Math.max(...r.map((x) => x.box.height))).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  let out = "";
  let prevBottom: number | null = null;
  for (const row of rows) {
    row.sort((a, b) => a.box.x - b.box.x);
    const top = Math.min(...row.map((r) => r.box.y));
    if (prevBottom !== null) out += top - prevBottom > lineHeight * 1.2 ? "\n\n" : "\n";
    out += row.map((r) => r.text.trim()).join(" ");
    prevBottom = Math.max(...row.map((r) => r.box.y + r.box.height));
  }
  return out;
}

export type PayloadKind = "url" | "email" | "phone" | "wifi" | "uri" | "text";

export interface ClassifiedPayload {
  kind: PayloadKind;
  /** What "Open" should open, when that makes sense. */
  url: string | null;
  label: string;
  /** Wi-Fi details for WIFI: payloads. */
  wifi?: { ssid: string; password: string | null; security: string | null };
}

function parseWifi(payload: string): ClassifiedPayload["wifi"] {
  // WIFI:T:WPA;S:My Net;P:secret;; — values may escape ; , : \ with a backslash.
  const fields: Record<string, string> = {};
  const body = payload.slice(5);
  let key = "";
  let val = "";
  let inKey = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && i + 1 < body.length) {
      if (inKey) key += body[++i];
      else val += body[++i];
    } else if (inKey && ch === ":") inKey = false;
    else if (!inKey && ch === ";") {
      fields[key.toUpperCase()] = val;
      key = "";
      val = "";
      inKey = true;
    } else if (inKey) key += ch;
    else val += ch;
  }
  if (!inKey && key) fields[key.toUpperCase()] = val;
  return { ssid: fields.S ?? "", password: fields.P ?? null, security: fields.T ?? null };
}

export function classifyPayload(raw: string): ClassifiedPayload {
  const payload = raw.trim();
  if (/^https?:\/\/\S+$/i.test(payload)) return { kind: "url", url: payload, label: payload };
  if (/^www\.\S+\.\S+$/i.test(payload)) return { kind: "url", url: `https://${payload}`, label: payload };
  if (/^mailto:/i.test(payload)) return { kind: "email", url: payload, label: payload.slice(7).split("?")[0] ?? payload };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload)) return { kind: "email", url: `mailto:${payload}`, label: payload };
  if (/^tel:/i.test(payload)) return { kind: "phone", url: payload, label: payload.slice(4) };
  if (/^WIFI:/i.test(payload)) {
    const wifi = parseWifi(payload);
    return { kind: "wifi", url: null, label: `Wi-Fi “${wifi?.ssid ?? ""}”`, wifi };
  }
  // Other schemes (sms:, otpauth:, facetime:, app links). javascript:/data:/file: are never opened.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(payload)?.[1]?.toLowerCase();
  if (scheme && !["javascript", "data", "file", "vbscript"].includes(scheme) && !/\s/.test(payload)) return { kind: "uri", url: payload, label: payload };
  return { kind: "text", url: null, label: payload.length > 80 ? `${payload.slice(0, 79)}…` : payload };
}

/** http(s) links, www. hosts and e-mail addresses found in recognized text, de-duplicated. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi)) {
    const u = m[0].replace(/[.,;:!?]+$/, "");
    add(/^www\./i.test(u) ? `https://${u}` : u);
  }
  for (const m of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) add(`mailto:${m[0]}`);
  return out;
}

/** A URL safe to hand to shell.openExternal from a scanned code. */
export function isOpenable(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return !!scheme && !["javascript", "data", "file", "vbscript"].includes(scheme);
}

export function stats(text: string): { lines: number; words: number; chars: number } {
  const trimmed = text.trim();
  return { lines: trimmed ? trimmed.split("\n").filter((l) => l.trim()).length : 0, words: trimmed ? trimmed.split(/\s+/).length : 0, chars: text.length };
}
