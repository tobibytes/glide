import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { glide } from "../../lib/glide";
import { applyTransform, parseQuery, TRANSFORMS, type TransformDef, type TransformResult } from "../../../main/features/transforms/transforms";
import type { TransformInput } from "../../../main/features/transforms";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("transforms", method, ...args);

/** Inputs above this size only compute the selected transform (no per-row previews). */
const PREVIEW_ALL_LIMIT = 64 * 1024;

type Row = NavItem & { t: TransformDef };

const SOURCE_LABEL: Record<TransformInput["source"], string> = { selection: "Selected text", clipboard: "Clipboard", none: "No input" };

function oneLine(s: string, max = 48): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function TransformView({ props, query, setPlaceholder, toast, close }: ViewProps) {
  const [input, setInput] = useState<TransformInput | null>(null);
  const preferred = typeof props.transform === "string" ? props.transform : undefined;

  useEffect(() => setPlaceholder("Filter transforms…  (“wrap 60” sets the width)"), [setPlaceholder]);
  useEffect(() => {
    void call<TransformInput>("input").then(setInput);
  }, []);

  const { query: q, width } = parseQuery(query);
  const opts = useMemo(() => ({ width }), [width]);

  const rows = useMemo((): Row[] => {
    const needle = q.trim().toLowerCase();
    const match = (t: TransformDef) => !needle || t.title.toLowerCase().includes(needle) || t.keywords.some((k) => k.includes(needle)) || t.id.includes(needle);
    const list = TRANSFORMS.filter(match);
    const first = preferred && !needle ? list.filter((t) => t.id === preferred) : [];
    return [...first.map((t) => ({ id: `pick:${t.id}`, section: "Suggested", t })), ...list.filter((t) => !first.includes(t)).map((t) => ({ id: t.id, section: t.category, t }))];
  }, [q, preferred]);

  const text = input?.text ?? "";
  const results = useMemo(() => {
    const map = new Map<string, TransformResult>();
    if (text.length > PREVIEW_ALL_LIMIT) return map;
    for (const r of rows) map.set(r.t.id, applyTransform(r.t.id, text, opts));
    return map;
  }, [rows, text, opts]);
  const resultOf = useCallback((t: TransformDef) => results.get(t.id) ?? applyTransform(t.id, text, opts), [results, text, opts]);

  const paste = useCallback(
    async (t: TransformDef) => {
      const r = resultOf(t);
      if (!r.ok) return toast(r.error, "error");
      close();
      const res = await call<ExecuteResult>("paste", r.output);
      if (!res.ok) toast(res.error ?? "Could not paste", "error");
    },
    [resultOf, toast, close],
  );
  const copy = useCallback(
    async (t: TransformDef) => {
      const r = resultOf(t);
      if (!r.ok) return toast(r.error, "error");
      await call<ExecuteResult>("copy", r.output);
      toast("Copied");
    },
    [resultOf, toast],
  );
  const useClipboard = useCallback(async () => {
    setInput(await call<TransformInput>("clipboard"));
    toast("Using the clipboard as input");
  }, [toast]);
  const useQuery = useCallback(() => {
    if (!query.trim()) return toast("Type the text into the search field first", "error");
    setInput({ text: query, source: "none" });
  }, [query, toast]);

  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "paste", title: "Paste Result", shortcut: "⏎", icon: "📥", run: () => paste(r.t) },
      { id: "copy", title: "Copy Result", shortcut: "⌘C", icon: "📋", run: () => copy(r.t) },
      { id: "chain", title: "Use Result as Input", shortcut: "⌘I", icon: "🔁", run: () => {
          const res = resultOf(r.t);
          if (res.ok) setInput({ text: res.output, source: input?.source ?? "none" });
          else toast(res.error, "error");
        } },
      { id: "clip", title: "Use Clipboard as Input", shortcut: "⇧⌘V", icon: "📋", run: () => void useClipboard() },
      { id: "query", title: "Use Search Text as Input", shortcut: "⌘T", icon: "⌨️", run: useQuery },
    ],
    [paste, copy, resultOf, input?.source, toast, useClipboard, useQuery],
  );

  if (!input) return <div className="launcher__empty">Reading selection…</div>;

  return (
    <NavList
      items={rows}
      actionsTitle="Transform"
      onActivate={(r, mods) => void (mods.cmd ? copy(r.t) : paste(r.t))}
      actions={actions}
      emptyText="No transform matches"
      renderItem={(r, selected) => {
        const res = results.get(r.t.id);
        return (
          <div className={`row transforms-row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--symbol transforms-cat">{r.t.category.charAt(0)}</span>
            <div className="row__main">
              <span className="row__title">{r.t.title}</span>
              {res && <span className={`row__subtitle ${res.ok ? "" : "transforms-err"}`}>{res.ok ? oneLine(res.output, 34) : "—"}</span>}
            </div>
          </div>
        );
      }}
      detail={(r) => {
        const res = resultOf(r.t);
        return (
          <div className="transforms-detail">
            <div className="transforms-detail__head">
              <span className="transforms-detail__label">{r.t.title}</span>
              {r.t.id === "jwt" && <span className="tag tag--accent">signature not verified</span>}
            </div>
            {res.ok ? <pre className="transforms-detail__out">{res.output}</pre> : <div className="transforms-detail__error">{res.error}</div>}
            <div className="transforms-detail__input">
              <span className="transforms-detail__label">
                Input · {SOURCE_LABEL[input.source]} · {[...text].length} chars
              </span>
              <pre>{text.length > 2000 ? `${text.slice(0, 2000)}…` : text || "(empty — copy or select text, or ⌘T to use the search text)"}</pre>
            </div>
            <div className="transforms-detail__hint faint">⏎ paste · ⌘C copy · ⌘I chain · ⌘K more</div>
          </div>
        );
      }}
    />
  );
}
