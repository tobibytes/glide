/**
 * Quicklink editor shared by Settings → Quicklinks and the launcher's "Create Quicklink" view:
 * URL with placeholder chips, detected arguments with test values and a live URL preview,
 * "Open with" app picker, website icon (favicon fetched on save only).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ItemIcon, Quicklink, SearchItem } from "@shared/types";
import { glide } from "../../../lib/glide";
import { IconPicker } from "../../../components/IconPicker";
import { Field } from "../../../components/form";
import { Kbd } from "../../../components/Kbd";
import { quicklinksApi, type ArgDef } from "./api";
import "./quicklinks.css";

export const DEFAULT_ICON: ItemIcon = { kind: "emoji", value: "🔗" };

const CHIPS: Array<{ label: string; insert: string; hint: string }> = [
  { label: "Argument", insert: '{argument name="query"}', hint: "Typed in the launcher; Tab moves between arguments" },
  { label: "With default", insert: '{argument name="lang" default="en"}', hint: "Optional argument with a default value" },
  { label: "Options", insert: '{argument name="type" options="web,images"}', hint: "Pick with ↑/↓ in the launcher" },
  { label: "Clipboard", insert: "{clipboard}", hint: "Current clipboard text" },
  { label: "Selection", insert: "{selection}", hint: "Selected text in the frontmost app" },
  { label: "Date", insert: '{date format="yyyy-MM-dd"}', hint: 'Formats: yyyy MM dd HH mm EEEE…; offset="+1d"' },
  { label: "UUID", insert: "{uuid}", hint: "A random UUID" },
];

export interface QuicklinkFormProps {
  initial?: Partial<Quicklink>;
  onSaved(q: Quicklink): void;
  onCancel(): void;
  onDelete?(): void;
  /** Compact layout for the launcher view. */
  compact?: boolean;
  autoFocusId?: string;
}

const isFaviconIcon = (icon: ItemIcon | undefined) => !icon || (icon.kind === "emoji" && icon.value === DEFAULT_ICON.value) || (icon.kind === "url" && icon.value.startsWith("data:image/"));

export function QuicklinkForm({ initial, onSaved, onCancel, onDelete, compact, autoFocusId = "ql-name" }: QuicklinkFormProps) {
  const [q, setQ] = useState<Partial<Quicklink>>({ name: "", url: "", icon: DEFAULT_ICON, alias: "", ...initial });
  const [keywords, setKeywords] = useState((initial?.keywords ?? []).join(", "));
  const [useFavicon, setUseFavicon] = useState(isFaviconIcon(initial?.icon));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [args, setArgs] = useState<ArgDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url?: string; error?: string } | null>(null);
  const [apps, setApps] = useState<SearchItem[]>([]);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => document.getElementById(autoFocusId)?.focus());
  }, [autoFocusId]);
  useEffect(() => {
    void glide()
      .listApps()
      .then((list) => setApps([...list].sort((a, b) => a.title.localeCompare(b.title))))
      .catch(() => setApps([]));
  }, []);

  const url = q.url ?? "";
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void quicklinksApi.arguments(url).then((a) => alive && setArgs(a));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [url]);
  useEffect(() => {
    if (!url.trim()) return setPreview(null);
    let alive = true;
    const t = setTimeout(() => {
      void quicklinksApi.preview(url, values).then((p) => alive && setPreview(p));
    }, 160);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [url, values]);

  const insert = (text: string) => {
    const el = urlRef.current;
    const start = el?.selectionStart ?? url.length;
    const end = el?.selectionEnd ?? url.length;
    const next = url.slice(0, start) + text + url.slice(end);
    setQ({ ...q, url: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const save = async () => {
    if (!q.name?.trim() || !q.url?.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await quicklinksApi.save(
        {
          ...q,
          name: q.name.trim(),
          url: q.url.trim(),
          alias: q.alias?.trim() || undefined,
          openWith: q.openWith?.trim() || undefined,
          keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
          icon: useFavicon && !isFaviconIcon(q.icon) ? undefined : q.icon,
        },
        useFavicon,
      );
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  };

  const appOptions = useMemo(() => {
    const list = apps.map((a) => ({ value: a.path ?? a.title, label: a.title }));
    if (q.openWith && !list.some((o) => o.value === q.openWith)) list.unshift({ value: q.openWith, label: q.openWith.split("/").pop()?.replace(/\.app$/, "") ?? q.openWith });
    return list;
  }, [apps, q.openWith]);

  return (
    <form
      className={`form qlform ${compact ? "qlform--compact" : ""}`}
      data-qlform
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey && e.key.toLowerCase() === "s") || (e.metaKey && e.key === "Enter")) {
          e.preventDefault();
          e.stopPropagation();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {error && <div className="error-banner">{error}</div>}
      <div className="qlform__top">
        {!compact && <IconPicker value={q.icon ?? DEFAULT_ICON} onChange={(icon) => (setQ({ ...q, icon }), setUseFavicon(false))} />}
        <div style={{ flex: 1 }}>
          <Field label="Name" htmlFor="ql-name">
            <input id="ql-name" className="input" value={q.name ?? ""} onChange={(e) => setQ({ ...q, name: e.target.value })} placeholder="Google Translate" />
          </Field>
        </div>
      </div>
      <Field label="URL" htmlFor="ql-url" hint={<>Placeholders are percent-encoded; add <code>raw="true"</code> (or <code>| raw</code>) to insert a value as-is.</>}>
        <input ref={urlRef} id="ql-url" className="input mono" value={url} onChange={(e) => setQ({ ...q, url: e.target.value })} placeholder='https://translate.google.com/?tl={argument name="lang" default="en"}&text={argument name="text"}' spellCheck={false} />
      </Field>
      <div className="qlform__chips" role="toolbar" aria-label="Insert placeholder">
        {CHIPS.map((c) => (
          <button key={c.label} type="button" className="qlchip" title={c.hint} onClick={() => insert(c.insert)}>
            {c.label}
          </button>
        ))}
      </div>
      {args.length > 0 && (
        <div className="qlform__args" data-qlform-args={args.length}>
          <div className="qlform__args-title">Arguments · type them in the launcher, Tab to the next one</div>
          {args.map((a) => (
            <label key={a.name} className="qlform__arg">
              <span className="qlform__arg-name">
                {a.placeholder}
                {!a.optional && <span className="qlform__req">*</span>}
              </span>
              {a.options?.length ? (
                <select className="input select" value={values[a.name] ?? ""} onChange={(e) => setValues({ ...values, [a.name]: e.target.value })}>
                  <option value="">{a.default ? `default: ${a.default}` : "choose…"}</option>
                  {a.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" value={values[a.name] ?? ""} onChange={(e) => setValues({ ...values, [a.name]: e.target.value })} placeholder={a.default !== undefined ? `default: ${a.default}` : "test value"} />
              )}
            </label>
          ))}
        </div>
      )}
      {preview && (
        <div className={`qlform__preview ${preview.error ? "qlform__preview--error" : ""}`} data-ql-preview>
          <span className="qlform__preview-label">{preview.error ? "Needs" : "Opens"}</span>
          <code>{preview.error ?? preview.url}</code>
        </div>
      )}
      <div className="form__grid">
        <Field label="Open with" htmlFor="ql-app" hint="Default: your default browser (or the URL's handler)">
          <select id="ql-app" className="input select" value={q.openWith ?? ""} onChange={(e) => setQ({ ...q, openWith: e.target.value || undefined })}>
            <option value="">Default app</option>
            {appOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Alias" htmlFor="ql-alias" hint="Type it, then a space and your argument">
          <input id="ql-alias" className="input" value={q.alias ?? ""} onChange={(e) => setQ({ ...q, alias: e.target.value })} placeholder="tr" />
        </Field>
      </div>
      {!compact && (
        <Field label="Keywords" htmlFor="ql-kw" hint="Comma separated extra search terms">
          <input id="ql-kw" className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="search, web" />
        </Field>
      )}
      <label className="qlform__check">
        <input type="checkbox" checked={useFavicon} onChange={(e) => setUseFavicon(e.target.checked)} />
        Use the website's icon (fetched from its /favicon.ico when you save)
      </label>
      <div className="form__actions">
        <div>{onDelete && <button type="button" className="btn btn--danger" onClick={onDelete}>Delete</button>}</div>
        <div>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel <Kbd keys="⎋" />
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy} data-ql-save>
            {busy ? "Saving…" : "Save"} <Kbd keys="⌘⏎" />
          </button>
        </div>
      </div>
    </form>
  );
}
