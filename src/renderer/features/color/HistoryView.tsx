import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { glide } from "../../lib/glide";
import { ALL_FORMATS, FORMAT_TITLES, formatColor, luminance, parseColor, type ColorFormat, type RGBA } from "../../../main/features/color/colors";
import type { ColorEntry } from "../../../main/features/color";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("color", method, ...args);

type Row = NavItem & ({ kind: "pick" } | { kind: "typed"; rgba: RGBA } | { kind: "entry"; e: ColorEntry });

const SHORTCUTS: Partial<Record<ColorFormat, string>> = { rgb: "⇧⌘R", hsl: "⇧⌘H", swiftui: "⇧⌘S", css: "⇧⌘C" };

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function Swatch({ rgba, size = 22 }: { rgba: RGBA; size?: number }) {
  return <span className="color-swatch" style={{ width: size, height: size, background: formatColor(rgba, "rgb") }} aria-hidden="true" />;
}

export function ColorHistory({ query, setPlaceholder, toast, close }: ViewProps) {
  const [history, setHistory] = useState<ColorEntry[] | null>(null);

  useEffect(() => setPlaceholder("Search colors or type #hex / rgb() to save…"), [setPlaceholder]);
  useEffect(() => {
    void call<ColorEntry[]>("history").then(setHistory);
    return glide().onFeatureEvent((e) => {
      if (e.feature === "color" && e.event === "history") setHistory(e.payload as ColorEntry[]);
    });
  }, []);

  const typed = useMemo(() => parseColor(query), [query]);
  const rows = useMemo((): Row[] => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    if (typed) out.push({ id: "typed", section: "Typed Color", kind: "typed", rgba: typed });
    else if (!q) out.push({ id: "pick", section: "Picker", kind: "pick" });
    for (const e of history ?? []) {
      if (q && !typed && !ALL_FORMATS.some((f) => formatColor(e.rgba, f).toLowerCase().includes(q))) continue;
      out.push({ id: e.hex, section: "History", kind: "entry", e });
    }
    return out;
  }, [history, query, typed]);

  const copy = useCallback(
    async (rgba: RGBA, format: ColorFormat) => {
      const text = await call<string | null>("copy", formatColor(rgba, "hex"), format);
      if (text) toast(`Copied ${text}`);
    },
    [toast],
  );
  const paste = useCallback(async (rgba: RGBA, format: ColorFormat) => {
    await call<ExecuteResult>("paste", formatColor(rgba, "hex"), format);
  }, []);
  const pick = useCallback(async () => {
    close();
    const res = await call<ExecuteResult>("pick");
    if (!res.ok) toast(res.error ?? "Could not pick a color", "error");
  }, [close, toast]);

  const actions = useCallback(
    (r: Row): NavAction[] => {
      if (r.kind === "pick") return [{ id: "pick", title: "Pick Color", shortcut: "⏎", run: () => void pick() }];
      const rgba = r.kind === "typed" ? r.rgba : r.e.rgba;
      const list: NavAction[] = [
        { id: "copy:hex", title: "Copy HEX", shortcut: "⏎", run: () => void copy(rgba, "hex") },
        { id: "paste:hex", title: "Paste HEX", shortcut: "⌘⏎", run: () => void paste(rgba, "hex") },
        ...ALL_FORMATS.filter((f) => f !== "hex").map((f) => ({ id: `copy:${f}`, title: `Copy ${FORMAT_TITLES[f]}`, shortcut: SHORTCUTS[f], run: () => void copy(rgba, f) })),
      ];
      if (r.kind === "typed") list.push({ id: "save", title: "Save to History", shortcut: "⌘S", run: () => void call<ColorEntry[]>("add", formatColor(rgba, "hex")).then(() => toast("Saved")) });
      else
        list.push(
          { id: "pick", title: "Pick New Color", shortcut: "⌘N", run: () => void pick() },
          { id: "delete", title: "Delete Color", shortcut: "⌃X", destructive: true, run: () => void call("remove", r.e.hex) },
          { id: "clear", title: "Clear History", shortcut: "⌃⇧X", destructive: true, run: () => void call("clear").then(() => toast("Color history cleared")) },
        );
      return list;
    },
    [copy, paste, pick, toast],
  );

  const detail = (r: Row) => {
    if (r.kind === "pick")
      return (
        <div className="color-detail color-detail--empty">
          <p>Press ⏎ to open the macOS color sampler. Click anywhere on screen to pick; Esc cancels. The color is copied as HEX and saved here.</p>
        </div>
      );
    const rgba = r.kind === "typed" ? r.rgba : r.e.rgba;
    const dark = luminance(rgba) < 0.4;
    return (
      <div className="color-detail">
        <div className="color-detail__swatch" style={{ background: formatColor(rgba, "rgb"), color: dark ? "#fff" : "#000" }}>
          {formatColor(rgba, "hex")}
        </div>
        <dl className="color-detail__formats">
          {ALL_FORMATS.map((f) => (
            <div key={f} className="color-detail__row">
              <dt>{FORMAT_TITLES[f]}</dt>
              <dd className="mono">{formatColor(rgba, f)}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  };

  return (
    <div className="color-view">
      <NavList<Row>
        items={rows}
        actions={actions}
        detail={detail}
        emptyText={history === null ? "Loading…" : "No colors yet — use Pick Color or type a #hex color"}
        onActivate={(r, m) => {
          const a = actions(r);
          void (m.cmd ? (a.find((x) => x.shortcut === "⌘⏎") ?? a[0]) : a[0])?.run();
        }}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            {r.kind === "pick" ? <span className="icon icon--md">🎨</span> : <Swatch rgba={r.kind === "typed" ? r.rgba : r.e.rgba} />}
            <div className="row__main">
              <span className="row__title">{r.kind === "pick" ? "Pick Color" : formatColor(r.kind === "typed" ? r.rgba : r.e.rgba, "hex")}</span>
              <span className="row__subtitle">
                {r.kind === "pick" ? "Sample any pixel on screen" : r.kind === "typed" ? "⌘S to save" : `${formatColor(r.e.rgba, "rgb")} · ${ago(r.e.at)}`}
              </span>
            </div>
          </div>
        )}
      />
    </div>
  );
}
