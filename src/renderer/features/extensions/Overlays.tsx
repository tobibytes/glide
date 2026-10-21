/**
 * Overlays of a running Raycast command: nested ⌘K submenus, Action.PickDate, Quick Look,
 * the OAuth sign-in card and toasts with actions. Each one owns the keyboard while open
 * (keys stop at the overlay, so the launcher never sees them).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ActionModel } from "../../../extension-api/types";
import { iconFor } from "../../../extension-api/icons";
import type { QuickLookInfo } from "../../../main/features/extensions/compat-feature";
import type { OAuthPrompt, ToastActionModel } from "../../../main/features/extensions/sessions";
import { ActionPanel } from "../../components/ActionPanel";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { eventMatchesShortcut } from "../../lib/keys";
import { ext, errorText } from "./api";
import { Markdown } from "./MarkdownView";
import { navActions, type ActionTarget, type Runner } from "./viewKit";

// --- ActionPanel.Submenu ------------------------------------------------------------------------

export interface SubmenuFrame {
  action: ActionModel;
  target?: ActionTarget;
}

/** The innermost submenu of the stack as its own ⌘K panel; ⎋ goes back one level. */
export function SubmenuPanel({ stack, run, onBack }: { stack: SubmenuFrame[]; run: Runner; onBack(): void }) {
  const top = stack[stack.length - 1];
  const crumbs = stack.map((f) => f.action.title).join(" › ");
  return (
    <div className="extensions-submenu" data-depth={stack.length}>
      <ActionPanel key={top.action.id} title={crumbs} actions={navActions(top.action.children ?? [], run, top.target, true)} onRun={(a) => void a.run()} onClose={onBack} />
    </div>
  );
}

// --- Action.PickDate -----------------------------------------------------------------------------

function toLocalInput(d: Date, withTime: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

export function PickDateOverlay({ action, onPick, onCancel }: { action: ActionModel; onPick(iso: string | null): void; onCancel(): void }) {
  const withTime = action.dateType !== "date";
  const [value, setValue] = useState(() => toLocalInput(new Date(), withTime));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const confirm = () => {
    const d = new Date(value.length === 10 ? `${value}T00:00` : value);
    onPick(Number.isNaN(d.getTime()) ? null : d.toISOString());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Backspace" && e.metaKey) {
      e.preventDefault();
      onPick(null);
    }
  };
  return (
    <div className="extensions-overlay" role="dialog" aria-label={action.title} onKeyDown={onKeyDown}>
      <div className="extensions-overlay__card extensions-pickdate">
        <div className="extensions-overlay__title">{action.title}</div>
        <input ref={ref} className="input" data-pickdate type={withTime ? "datetime-local" : "date"} value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="extensions-overlay__hints">
          <span><Kbd keys="⏎" /> Pick</span>
          <span><Kbd keys="⌘⌫" /> Clear</span>
          <span><Kbd keys="⎋" /> Cancel</span>
        </div>
      </div>
    </div>
  );
}

// --- Quick Look ---------------------------------------------------------------------------------

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

/** In-launcher preview of a file (no Quick Look window): thumbnail or text, plus size and date. ⌘Y / ⎋ / space close. */
export function QuickLookOverlay({ path, name, onClose }: { path: string; name?: string; onClose(): void }) {
  const [info, setInfo] = useState<QuickLookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    ext<QuickLookInfo>("quickLook", path).then(
      (i) => alive && setInfo(i),
      (err) => alive && setError(errorText(err)),
    );
    ref.current?.focus();
    return () => {
      alive = false;
    };
  }, [path]);
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (e.key === "Escape" || e.key === " " || (e.metaKey && k === "y") || e.key === "Enter") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "j") ref.current?.querySelector(".extensions-quicklook__body")?.scrollBy({ top: 48 });
    else if (e.key === "ArrowUp" || e.key === "k") ref.current?.querySelector(".extensions-quicklook__body")?.scrollBy({ top: -48 });
  };
  const title = name ?? info?.name ?? path.split("/").pop() ?? path;
  return (
    <div className="extensions-overlay" role="dialog" aria-label={`Quick Look: ${title}`} tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
      <div className="extensions-overlay__card extensions-quicklook">
        <div className="extensions-overlay__title extensions-quicklook__title">
          <Icon icon={iconFor(`file://${path}`)} fallback="📄" /> {title}
        </div>
        <div className="extensions-quicklook__body">
          {error ? (
            <div className="extensions-error">{error}</div>
          ) : !info ? (
            <div className="glide-loading" aria-hidden="true" />
          ) : !info.exists ? (
            <div className="extensions-muted">File not found: {info.path}</div>
          ) : info.text !== undefined ? (
            /\.(md|markdown)$/i.test(info.path) ? <Markdown source={info.text} /> : <pre className="extensions-quicklook__text">{info.text}</pre>
          ) : info.image ? (
            <img className="extensions-quicklook__img" src={info.image} alt="" />
          ) : (
            <div className="extensions-muted">No preview available</div>
          )}
        </div>
        {info?.exists && (
          <div className="extensions-quicklook__meta">
            <span>{info.isDirectory ? "Folder" : formatSize(info.size)}</span>
            {info.modified && <span>Modified {new Date(info.modified).toLocaleString()}</span>}
            <span className="extensions-quicklook__path">{info.path}</span>
          </div>
        )}
        <div className="extensions-overlay__hints">
          <span><Kbd keys="⌘Y" /> / <Kbd keys="⎋" /> Close</span>
        </div>
      </div>
    </div>
  );
}

// --- OAuth --------------------------------------------------------------------------------------

/** Raycast's OAuth overlay: ⏎ opens the provider's sign-in page in the browser, ⎋ cancels. */
export function OAuthCard({ prompt, onDone }: { prompt: OAuthPrompt; onDone(): void }) {
  const [phase, setPhase] = useState<"ask" | "waiting">("ask");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const open = async () => {
    try {
      await ext("oauthOpen", prompt.id);
      setPhase("waiting");
    } catch (err) {
      setError(errorText(err));
    }
  };
  const cancel = () => {
    void ext("oauthCancel", prompt.id);
    onDone();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void open();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };
  return (
    <div className="extensions-overlay" role="dialog" aria-label={`Sign in with ${prompt.providerName}`} tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
      <div className="extensions-overlay__card extensions-oauth">
        {prompt.providerIcon && <Icon icon={iconFor(prompt.providerIcon)} size="xl" />}
        <div className="extensions-overlay__title extensions-oauth__title">{phase === "ask" ? `Sign in with ${prompt.providerName}` : `Waiting for ${prompt.providerName}…`}</div>
        <div className="extensions-muted">{phase === "ask" ? (prompt.description ?? `This extension wants to connect to your ${prompt.providerName} account.`) : "Finish signing in in your browser; Glide continues automatically."}</div>
        {error && <div className="extensions-error">{error}</div>}
        <div className="extensions-alert__buttons">
          <button type="button" className="btn" onClick={cancel}>
            Cancel <Kbd keys="⎋" />
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void open()}>
            {phase === "ask" ? `Sign in with ${prompt.providerName}` : "Open Again"} <Kbd keys="⏎" />
          </button>
        </div>
      </div>
    </div>
  );
}

// --- toasts -------------------------------------------------------------------------------------

export interface ExtToastState {
  id: string;
  style: string;
  title: string;
  message?: string;
  actions: ToastActionModel[];
}

/** Default shortcuts for toast actions without their own (Raycast shows them on the toast). */
export const toastShortcut = (a: ToastActionModel) => a.shortcut ?? (a.slot === "primary" ? "⌘T" : "⌥⌘T");

/**
 * A Raycast toast: animated toasts stay until updated or hidden, others fade after a few seconds
 * (longer with actions). Action shortcuts work while it is visible.
 */
export function ExtToast({ toast, onAction, onExpire }: { toast: ExtToastState; onAction(a: ToastActionModel): void; onExpire(): void }) {
  useEffect(() => {
    if (toast.style === "animated") return;
    const t = setTimeout(onExpire, toast.actions.length ? 8000 : 3000);
    return () => clearTimeout(t);
  }, [toast, onExpire]);
  useEffect(() => {
    if (!toast.actions.length) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const hit = toast.actions.find((a) => eventMatchesShortcut(e, toastShortcut(a)));
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      onAction(hit);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toast, onAction]);
  return (
    <div className={`extensions-toast extensions-toast--${toast.style}`} role="status" data-toast-id={toast.id}>
      <span className="extensions-toast__dot" aria-hidden="true" />
      <span className="extensions-toast__text">
        <span className="extensions-toast__title">{toast.title}</span>
        {toast.message && <span className="extensions-toast__msg">{toast.message}</span>}
      </span>
      {toast.actions.map((a) => (
        <button key={a.slot} type="button" className="btn extensions-toast__action" onClick={() => onAction(a)}>
          {a.title} <Kbd keys={toastShortcut(a)} />
        </button>
      ))}
    </div>
  );
}
