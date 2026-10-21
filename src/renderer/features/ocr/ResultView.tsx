import { useEffect } from "react";
import type { ExecuteResult } from "@shared/ipc";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { call, errorText, readResult, translatePrompt } from "./api";

type Row = NavItem & { action: NavAction; icon: string; subtitle?: string };

/** Launcher view "ocr.result": recognized text (or a permission / error explanation) with follow-up actions. */
export function ResultView({ props, query, setPlaceholder, push, close, toast }: ViewProps) {
  const r = readResult(props);
  useEffect(() => setPlaceholder(r.kind === "text" ? "Translate into… (type a language, default English)" : ""), [setPlaceholder, r.kind]);

  const retry: NavAction = { id: "retry", title: "Capture Text Again", shortcut: "⌘⇧R", run: () => void call("captureText").then(close) };
  const settingsAction: NavAction = { id: "perm", title: "Open Screen Recording Settings", shortcut: "⌘,", run: () => void call("openScreenRecordingSettings").then(close) };

  let rows: Row[];
  if (r.kind === "text") {
    const text = r.text;
    const copy = (t: string, what = "Copied") => void call("copy", t).then(() => toast(what));
    rows = [
      { id: "copy", icon: "📋", action: { id: "copy", title: r.copied ? "Copy Text Again" : "Copy Text", shortcut: "⏎", run: () => copy(text) } },
      { id: "paste", icon: "⌨️", action: { id: "paste", title: "Paste into Front App", shortcut: "⌘⏎", run: () => void call<ExecuteResult>("paste", text).then((x) => (x.error ? toast(x.error, "error") : close())) } },
      { id: "translate", icon: "🌐", action: { id: "translate", title: `Translate into ${query.trim() || "English"} with AI`, shortcut: "⌘T", run: () => push({ id: "ai.chat", props: { prompt: translatePrompt(text, query), title: "Translate" } }) } },
      { id: "ask", icon: "✨", action: { id: "ask", title: "Ask AI About This Text", shortcut: "⌘J", run: () => push({ id: "ai.chat", props: { prompt: `${query.trim() || "Explain this text:"}\n\n${text}` } }) } },
      { id: "oneline", icon: "➖", action: { id: "oneline", title: "Copy as One Line", shortcut: "⌘L", run: () => copy(text.replace(/\s*\n+\s*/g, " "), "Copied as one line") } },
      ...r.links.map((url, i): Row => ({ id: `link-${i}`, section: "Links", icon: "🔗", action: { id: `link-${i}`, title: `Open ${url.replace(/^mailto:/, "")}`, run: () => void call("openUrl", url).then(close) } })),
      { id: "retry", section: "More", icon: "🔍", action: retry },
    ];
    if (!text) rows = [{ id: "retry", icon: "🔍", action: retry }, ...(r.permissionHint ? [{ id: "perm", icon: "🔐", action: settingsAction }] : [])];
  } else if (r.kind === "permission") {
    rows = [
      { id: "perm", icon: "🔐", action: { ...settingsAction, shortcut: "⏎" } },
      { id: "retry", icon: "🔍", action: retry },
    ];
  } else {
    rows = [{ id: "retry", icon: "🔍", action: { ...retry, shortcut: "⏎" } }, ...(r.permissionHint ? [{ id: "perm", icon: "🔐", action: settingsAction }] : [])];
  }

  const header =
    r.kind === "text" ? (
      r.text ? (
        <div className="ocr-head faint">
          {r.copied ? "Copied to clipboard · " : ""}
          {r.lines} lines · {r.words} words · {r.chars} characters
        </div>
      ) : (
        <div className="ocr-note">No text found in the selected area.{r.permissionHint ? " If the capture looked blank, Glide needs Screen Recording permission to see other apps' windows." : ""}</div>
      )
    ) : r.kind === "permission" ? (
      <div className="ocr-note">
        Glide needs <b>Screen Recording</b> permission to read text from other apps. Open System Settings → Privacy & Security → Screen &amp; System Audio Recording, enable Glide, then quit and reopen Glide.
      </div>
    ) : (
      <div className="ocr-note ocr-note--error">{r.message}</div>
    );

  return (
    <div className="ocr-view">
      {header}
      <NavList<Row>
        items={rows}
        actions={(row) => [row.action, ...rows.filter((x) => x !== row).map((x) => x.action)]}
        onActivate={(row, mods) => {
          if (mods.cmd) {
            const secondary = rows.find((x) => x.action.shortcut === "⌘⏎");
            if (secondary) return void Promise.resolve(secondary.action.run()).catch((e: unknown) => toast(errorText(e), "error"));
          }
          void Promise.resolve(row.action.run()).catch((e: unknown) => toast(errorText(e), "error"));
        }}
        detail={r.kind === "text" && r.text ? () => <pre className="ocr-text">{r.text}</pre> : undefined}
        renderItem={(row, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">{row.icon}</span>
            <div className="row__main">
              <span className="row__title">{row.action.title}</span>
              {row.subtitle && <span className="row__subtitle">{row.subtitle}</span>}
            </div>
            <div className="row__right">{row.action.shortcut && <span className="row__kind">{row.action.shortcut}</span>}</div>
          </div>
        )}
      />
    </div>
  );
}
