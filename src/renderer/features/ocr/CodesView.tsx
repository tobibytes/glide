import { useEffect } from "react";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { call, type CodesResult } from "./api";

type Code = CodesResult["codes"][number];
type Row = NavItem & { code: Code };

const ICON: Record<Code["kind"], string> = { url: "🔗", email: "✉️", phone: "📞", wifi: "📶", uri: "↗️", text: "🔳" };

function readCodes(p: Record<string, unknown>): Code[] {
  if (!Array.isArray(p.codes)) return [];
  return p.codes.filter((c): c is Code => !!c && typeof c === "object" && typeof (c as Code).payload === "string" && typeof (c as Code).kind === "string");
}

/** Launcher view "ocr.codes": QR codes / barcodes found in a capture or clipboard image. */
export function CodesView({ props, setPlaceholder, close, toast }: ViewProps) {
  const codes = readCodes(props);
  useEffect(() => setPlaceholder(""), [setPlaceholder]);
  const rows: Row[] = codes.map((code, i) => ({ id: String(i), code }));

  const copy = (text: string, what = "Copied") => void call("copy", text).then(() => toast(what));
  const actions = (r: Row): NavAction[] => {
    const c = r.code;
    const list: NavAction[] = [];
    if (c.url) list.push({ id: "open", title: c.kind === "email" ? "Compose Email" : c.kind === "phone" ? "Call" : "Open URL", shortcut: "⏎", run: () => void call<boolean>("openUrl", c.url).then((ok) => (ok ? close() : toast("Can't open that link", "error"))) });
    list.push({ id: "copy", title: c.url ? "Copy" : "Copy Content", shortcut: c.url ? "⌘⏎" : "⏎", run: () => copy(c.payload) });
    if (c.wifi?.password) list.push({ id: "wifi", title: "Copy Wi-Fi Password", shortcut: "⌘⇧C", run: () => copy(c.wifi!.password!, "Password copied") });
    if (c.wifi?.ssid) list.push({ id: "ssid", title: "Copy Network Name", run: () => copy(c.wifi!.ssid) });
    return list;
  };

  return (
    <NavList<Row>
      items={rows}
      emptyText="No codes found"
      actions={actions}
      onActivate={(r, mods) => {
        const list = actions(r);
        void (mods.cmd ? (list.find((a) => a.shortcut === "⌘⏎") ?? list[0]) : list[0])?.run();
      }}
      detail={(r) => (
        <div className="ocr-code-detail">
          <div className="faint">
            {r.code.symbology} · {r.code.kind}
          </div>
          <pre className="ocr-text">{r.code.payload}</pre>
          {r.code.wifi && (
            <div className="faint">
              Network: {r.code.wifi.ssid || "?"}
              {r.code.wifi.security ? ` · ${r.code.wifi.security}` : ""}
            </div>
          )}
        </div>
      )}
      renderItem={(r, selected) => (
        <div className={`row ${selected ? "row--selected" : ""}`}>
          <span className="icon icon--md">{ICON[r.code.kind] ?? "🔳"}</span>
          <div className="row__main">
            <span className="row__title">{r.code.label}</span>
            <span className="row__subtitle">{r.code.symbology}</span>
          </div>
        </div>
      )}
    />
  );
}
