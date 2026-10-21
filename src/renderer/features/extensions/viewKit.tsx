/** Shared pieces of the extension run views: action mapping, accessories, the search-bar dropdown, alerts. */
import { useEffect, useRef, useState } from "react";
import type { Accessory, ActionModel, DropdownModel, EmptyViewModel, QuickLookModel } from "../../../extension-api/types";
import type { AlertRequest } from "../../../main/features/extensions/sessions";
import type { NavAction } from "../types";
import { iconFor } from "../../../extension-api/icons";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { useNavHost } from "../../lib/navHost";

/** What an action was run for (Action.ToggleQuickLook previews the item's `quickLook`). */
export interface ActionTarget {
  quickLook?: QuickLookModel;
  title?: string;
}

export type Runner = (a: ActionModel | undefined, target?: ActionTarget) => void;
/** Invoke a UI-event handler (dropdown/field change, selection, load more) in the extension. */
export type Emit = (handler: string | undefined, args: unknown[]) => void;

export interface RunInfo {
  commandTitle: string;
  assetsPath: string;
}

/** First action runs on ⏎, the second on ⌘⏎ (unless it has its own shortcut), like Raycast. */
export function navActions(actions: ActionModel[], run: Runner, target?: ActionTarget, nested = false): NavAction[] {
  return actions.map((a, i) => {
    const icon = iconFor(a.icon);
    const title = a.kind === "submenu" ? `${a.title}  ›` : a.title;
    return {
      id: a.id,
      title: a.section && i > 0 && a.section !== actions[i - 1]?.section ? `${title}  ·  ${a.section}` : title,
      // Inside a submenu panel nothing is bound to ⏎ / ⌘⏎ except the selected row.
      shortcut: nested ? a.shortcut : i === 0 ? "⏎" : i === 1 && !a.shortcut ? "⌘⏎" : a.shortcut,
      icon: icon?.kind === "emoji" ? icon.value : a.kind === "submenu" ? "▸" : undefined,
      destructive: a.destructive,
      run: () => run(a, target),
    };
  });
}

export function Accessories({ list, assetsPath }: { list: Accessory[]; assetsPath: string }) {
  if (!list.length) return null;
  return (
    <div className="row__right extensions-acc">
      {list.map((a, i) => (
        <span key={i} className="extensions-acc__item" title={a.tooltip}>
          {a.icon && <Icon icon={iconFor(a.icon, assetsPath)} />}
          {a.tag && (
            <span className="tag extensions-tag" style={a.tagColor ? { color: a.tagColor, borderColor: a.tagColor } : undefined}>
              {a.tag}
            </span>
          )}
          {a.text && (
            <span className="extensions-acc__text" style={a.color ? { color: a.color } : undefined}>
              {a.text}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/** List/Grid `searchBarAccessory`: a dropdown in the view's top bar. ⌘P focuses it. */
export function SearchAccessory({ model, emit }: { model: DropdownModel; emit: Emit }) {
  const host = useNavHost();
  const ref = useRef<HTMLSelectElement>(null);
  const [value, setValue] = useState(model.value ?? model.options[0]?.value ?? "");
  useEffect(() => {
    if (model.value !== undefined) setValue(model.value);
  }, [model.value]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        const el = ref.current;
        if (!el) return;
        el.focus();
        try {
          (el as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
        } catch {
          /* showPicker needs a user gesture in some contexts; focus is enough */
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const sections: Array<{ title?: string; options: DropdownModel["options"] }> = [];
  for (const o of model.options) {
    const last = sections[sections.length - 1];
    if (last && last.title === o.section) last.options.push(o);
    else sections.push({ title: o.section, options: [o] });
  }
  return (
    <div className="extensions-searchbar">
      <select
        ref={ref}
        className="input extensions-searchbar__select"
        aria-label={model.tooltip ?? "Filter"}
        title={`${model.tooltip ?? "Filter"} (⌘P)`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          emit(model.handler, [e.target.value]);
          host?.focusSearch();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            host?.focusSearch();
          }
        }}
      >
        {sections.map((s, i) =>
          s.title ? (
            <optgroup key={i} label={s.title}>
              {s.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.title}
                </option>
              ))}
            </optgroup>
          ) : (
            s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.title}
              </option>
            ))
          ),
        )}
      </select>
      <Kbd keys="⌘P" />
    </div>
  );
}

export function EmptyView({ model, fallback, assetsPath, loading }: { model?: EmptyViewModel; fallback: string; assetsPath: string; loading: boolean }) {
  if (loading && !model) return <div className="navlist__empty">Loading…</div>;
  if (!model) return <div className="navlist__empty">{fallback}</div>;
  return (
    <div className="extensions-emptyview">
      {model.icon && <Icon icon={iconFor(model.icon, assetsPath)} size="xl" />}
      <div className="extensions-emptyview__title">{model.title ?? fallback}</div>
      {model.description && <div className="extensions-emptyview__desc">{model.description}</div>}
      {model.actions[0] && (
        <div className="extensions-muted">
          <Kbd keys="⏎" /> {model.actions[0].title}
        </div>
      )}
    </div>
  );
}

/** Raycast confirmAlert: a modal card. ⏎ confirms, ⎋ cancels; keys never reach the launcher meanwhile. */
export function AlertOverlay({ alert, onAnswer }: { alert: AlertRequest; onAnswer(ok: boolean): void }) {
  const done = useRef(false);
  const answer = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    onAnswer(ok);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape" || e.key.toLowerCase() === "y" || e.key.toLowerCase() === "n") {
        e.preventDefault();
        e.stopPropagation();
        answer(e.key === "Enter" || e.key.toLowerCase() === "y");
      } else {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  return (
    <div className="extensions-alert" role="alertdialog" aria-modal="true" aria-label={alert.title}>
      <div className="extensions-alert__card">
        <div className="extensions-alert__title">{alert.title}</div>
        {alert.message && <div className="extensions-alert__msg">{alert.message}</div>}
        <div className="extensions-alert__buttons">
          <button type="button" className="btn" onClick={() => answer(false)}>
            {alert.dismissTitle} <Kbd keys="⎋" />
          </button>
          <button type="button" className={`btn btn--primary ${alert.destructive ? "extensions-alert__danger" : ""}`} onClick={() => answer(true)}>
            {alert.primaryTitle} <Kbd keys="⏎" />
          </button>
        </div>
      </div>
    </div>
  );
}
