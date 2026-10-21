/** Snippet editor: placeholders, rich text, keyword (with the global prefix), per-app exclusions, live preview. */
import { useEffect, useRef, useState } from "react";
import type { Snippet } from "@shared/types";
import { Field } from "../../../components/form";
import { Kbd } from "../../../components/Kbd";
import { snippetsApi, type Rendered, type SnippetSettings } from "../quicklinks/api";
import { RenderedPreview } from "./RenderedPreview";
import "../quicklinks/quicklinks.css";

const CHIPS: Array<{ label: string; insert: string; hint: string }> = [
  { label: "Cursor", insert: "{cursor}", hint: "Where the caret lands after pasting" },
  { label: "Clipboard", insert: "{clipboard}", hint: "Current clipboard text" },
  { label: "Date", insert: '{date format="d MMMM yyyy"}', hint: 'Tokens: yyyy MM MMM dd EEEE HH mm; offset="+1d"' },
  { label: "Tomorrow", insert: '{date offset="+1d"}', hint: "Offsets: +1d -2w +3h +1M +1y" },
  { label: "Time", insert: '{time format="HH:mm"}', hint: "Current time" },
  { label: "UUID", insert: "{uuid}", hint: "A random UUID" },
  { label: "Snippet", insert: '{snippet name="sig"}', hint: "Insert another snippet by name or keyword" },
  { label: "Selection", insert: "{selection}", hint: "Selected text in the frontmost app" },
];

const errText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

export function SnippetEditor({ initial, settings, onDone, onDelete }: { initial?: Snippet; settings: SnippetSettings | null; onDone(): void; onDelete?(): void }) {
  const [s, setS] = useState<Partial<Snippet>>({ name: "", text: "", keyword: "", alias: "", ...initial });
  const [rich, setRich] = useState(!!initial?.html);
  const [excluded, setExcluded] = useState((initial?.excludedApps ?? []).join(", "));
  const [apps, setApps] = useState<Array<{ name: string; bundleId: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Rendered | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.getElementById("sn-name")?.focus();
    void snippetsApi.runningApps().then(setApps).catch(() => setApps([]));
  }, []);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => void snippetsApi.preview(s.text ?? "", rich ? s.html : "").then((p) => alive && setPreview(p)), 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [s.text, s.html, rich]);
  useEffect(() => {
    let alive = true;
    void snippetsApi.keywordWarning(s.keyword ?? "").then((w) => alive && setWarning(w));
    return () => {
      alive = false;
    };
  }, [s.keyword, settings?.keywordPrefix]);

  const insert = (text: string) => {
    const el = rich && document.activeElement === htmlRef.current ? htmlRef.current : textRef.current;
    const key = el === htmlRef.current ? "html" : "text";
    const cur = (key === "html" ? s.html : s.text) ?? "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    setS({ ...s, [key]: cur.slice(0, start) + text + cur.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const save = async () => {
    if (!s.name?.trim() || (!s.text && !(rich && s.html?.trim()))) {
      setError("Name and text are required.");
      return;
    }
    setBusy(true);
    try {
      await snippetsApi.save({
        ...s,
        name: s.name.trim(),
        keyword: s.keyword?.trim() || undefined,
        alias: s.alias?.trim() || undefined,
        html: rich ? s.html : undefined,
        excludedApps: excluded.split(",").map((x) => x.trim()).filter(Boolean),
      });
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const prefix = settings?.keywordPrefix ?? "";
  const typed = s.keyword?.trim() ? (prefix && !s.keyword.trim().startsWith(prefix) ? prefix + s.keyword.trim() : s.keyword.trim()) : "";

  return (
    <form
      className="form snform"
      data-snform
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.metaKey && (e.key.toLowerCase() === "s" || e.key === "Enter")) {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
      {error && <div className="error-banner">{error}</div>}
      <Field label="Name" htmlFor="sn-name">
        <input id="sn-name" className="input" value={s.name ?? ""} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Email signature" />
      </Field>
      <div className="qlform__chips" role="toolbar" aria-label="Insert placeholder">
        {CHIPS.map((c) => (
          <button key={c.label} type="button" className="qlchip" title={c.hint} onClick={() => insert(c.insert)}>
            {c.label}
          </button>
        ))}
      </div>
      <Field label={rich ? "Plain-text fallback" : "Text"} htmlFor="sn-text">
        <textarea ref={textRef} id="sn-text" className="textarea mono" rows={6} value={s.text ?? ""} onChange={(e) => setS({ ...s, text: e.target.value })} placeholder={"Best regards,\n{cursor}\nOlu"} />
      </Field>
      <label className="qlform__check">
        <input type="checkbox" checked={rich} onChange={(e) => setRich(e.target.checked)} data-sn-rich />
        Rich text (HTML) — pasted with formatting in apps that support it
      </label>
      {rich && (
        <Field label="Rich text (HTML)" htmlFor="sn-html" hint="Basic tags: <b> <i> <a href> <ul><li> <br> <p>. Scripts and event handlers are removed.">
          <textarea ref={htmlRef} id="sn-html" className="textarea mono" rows={5} value={s.html ?? ""} onChange={(e) => setS({ ...s, html: e.target.value })} placeholder="<b>Olu</b> · <a href='https://example.com'>example.com</a>" />
        </Field>
      )}
      {preview && <RenderedPreview rendered={preview} label="Preview" />}
      <div className="form__grid">
        <Field label="Keyword" htmlFor="sn-kw" hint={typed ? <>Type <code>{typed}</code> anywhere to expand{settings?.caseAdaptive ? " (Capitalised / UPPER variants too)" : ""}.</> : "Typed anywhere to expand (needs Accessibility)"}>
          <input id="sn-kw" className="input mono" value={s.keyword ?? ""} onChange={(e) => setS({ ...s, keyword: e.target.value })} placeholder={prefix ? "sig" : ";sig"} />
        </Field>
        <Field label="Alias" htmlFor="sn-alias" hint="Short word that ranks this snippet first in search">
          <input id="sn-alias" className="input" value={s.alias ?? ""} onChange={(e) => setS({ ...s, alias: e.target.value })} />
        </Field>
      </div>
      {warning && (
        <div className="warn-banner snwarn" data-sn-warning>
          ⚠︎ {warning}
        </div>
      )}
      <Field label="Don't expand in" htmlFor="sn-excl" hint="Bundle ids, comma separated (e.g. com.apple.Terminal). Pick from running apps:">
        <input id="sn-excl" className="input mono" value={excluded} onChange={(e) => setExcluded(e.target.value)} placeholder="com.apple.Terminal, com.microsoft.VSCode" />
      </Field>
      {apps.length > 0 && (
        <div className="qlform__chips">
          {apps.slice(0, 16).map((a) => (
            <button
              key={a.bundleId}
              type="button"
              className="qlchip"
              title={a.bundleId}
              onClick={() => {
                const list = excluded.split(",").map((x) => x.trim()).filter(Boolean);
                if (!list.includes(a.bundleId)) setExcluded([...list, a.bundleId].join(", "));
              }}
            >
              + {a.name}
            </button>
          ))}
        </div>
      )}
      <div className="form__actions">
        <div>{onDelete && <button type="button" className="btn btn--danger" onClick={onDelete}>Delete</button>}</div>
        <div>
          <button type="button" className="btn" onClick={onDone}>
            Cancel <Kbd keys="⎋" />
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy} data-sn-save>
            Save <Kbd keys="⌘S" />
          </button>
        </div>
      </div>
    </form>
  );
}
