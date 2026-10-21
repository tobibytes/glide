/**
 * Keyboard-first form used by extension Form views, preferences and arguments.
 * ⌘⏎ runs the primary action (submits), ⏎ moves to the next field, ⌘K lists the form's actions, ⎋ cancels.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FormFieldModel, FormValue, FormValues } from "../../../extension-api/types";
import type { NavAction } from "../types";
import { ActionPanel } from "../../components/ActionPanel";
import { Kbd } from "../../components/Kbd";
import { useNavController, useNavHost } from "../../lib/navHost";
import { eventMatchesShortcut } from "../../lib/keys";
import { ext } from "./api";

export interface FormAction extends Omit<NavAction, "run"> {
  run(values: FormValues): void | Promise<void>;
}

interface Props {
  fields: FormFieldModel[];
  submitTitle: string;
  description?: ReactNode;
  busy?: boolean;
  /** Values that override defaults (e.g. saved preferences). */
  initial?: FormValues;
  onSubmit(values: FormValues): void | Promise<void>;
  onCancel?(): void;
  /** Raycast forms: every ActionPanel action (⌘K); the first one is what ⌘⏎ runs. */
  actions?: FormAction[];
  /** Raycast onChange / onBlur of a field. */
  onFieldChange?(field: FormFieldModel, value: FormValue): void;
  onFieldBlur?(field: FormFieldModel, value: FormValue): void;
}

const INPUT_TYPES = new Set(["text", "password", "textarea", "checkbox", "dropdown", "date", "datetime", "tags", "file"]);

function fallbackValue(f: FormFieldModel): FormValue {
  if (f.type === "checkbox") return f.default === true;
  if (f.type === "tags" || f.type === "file") return Array.isArray(f.default) ? f.default : [];
  if (typeof f.default === "string") return f.default;
  return f.type === "dropdown" ? (f.options[0]?.value ?? "") : "";
}

function initialValues(fields: FormFieldModel[], initial?: FormValues): FormValues {
  const v: FormValues = {};
  for (const f of fields) {
    if (!INPUT_TYPES.has(f.type)) continue;
    const given = f.value ?? initial?.[f.id];
    if (f.type === "checkbox") v[f.id] = typeof given === "boolean" ? given : fallbackValue(f);
    else if (f.type === "tags" || f.type === "file") v[f.id] = Array.isArray(given) ? given : fallbackValue(f);
    else v[f.id] = typeof given === "string" ? given : fallbackValue(f);
  }
  return v;
}

/** ISO string ↔ the value of <input type="date|datetime-local"> in local time. */
function toInputDate(iso: string, withTime: boolean): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

function fromInputDate(v: string): string {
  if (!v) return "";
  const d = new Date(v.length === 10 ? `${v}T00:00` : v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function FieldsForm({ fields, submitTitle, description, busy, initial, onSubmit, onCancel, actions, onFieldChange, onFieldBlur }: Props) {
  const host = useNavHost();
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const fieldKey = fields.map((f) => `${f.id}:${f.type}`).join("|");
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    setValues((prev) => ({ ...initialValues(fields, initial), ...Object.fromEntries(Object.entries(prev).filter(([k]) => fields.some((f) => f.id === k))) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey]);

  // Controlled fields (Raycast `value`): adopt the extension's value whenever it changes.
  const controlled = useMemo(() => JSON.stringify(fields.map((f) => [f.id, f.value ?? null])), [fields]);
  useEffect(() => {
    setValues((prev) => {
      let next = prev;
      for (const f of fields) {
        if (f.value === undefined) continue;
        if (JSON.stringify(prev[f.id]) !== JSON.stringify(f.value)) next = { ...next, [f.id]: f.value };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled]);

  useEffect(() => {
    const auto = fields.find((f) => f.autoFocus);
    const el = auto ? rootRef.current?.querySelector<HTMLElement>(`[data-field="${auto.id}"]`) : rootRef.current?.querySelector<HTMLElement>("input, textarea, select");
    el?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey]);

  const primary = actions?.[0];
  const submit = async () => {
    const errs: Record<string, string> = {};
    for (const f of fields) if (f.required && f.type !== "checkbox" && !String(values[f.id] ?? "").trim()) errs[f.id] = `${f.title} is required`;
    setErrors(errs);
    if (Object.keys(errs).length) {
      rootRef.current?.querySelector<HTMLElement>(`[data-field="${Object.keys(errs)[0]}"]`)?.focus();
      return;
    }
    if (primary) await primary.run(valuesRef.current);
    else await onSubmit(valuesRef.current);
  };

  const panelActions = useMemo<NavAction[]>(() => (actions ?? []).map((a, i) => ({ ...a, shortcut: i === 0 ? "⌘⏎" : a.shortcut, run: () => a.run(valuesRef.current) })), [actions]);

  // When focus is in the launcher's search field, ⏎ / ⌘⏎ still submit.
  useNavController({
    nav: () => undefined,
    activate: () => void submit(),
    secondary: () => void submit(),
    toggleActions: () => setPanel((p) => !p && panelActions.length > 0),
    findAction: async () => null,
    shortcut: (e) => {
      const hit = panelActions.find((a) => a.shortcut && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) void hit.run();
      return !!hit;
    },
  });

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void submit();
    } else if (e.key.toLowerCase() === "k" && e.metaKey && panelActions.length) {
      e.preventDefault();
      setPanel((p) => !p);
    } else if ((e.metaKey || e.ctrlKey) && panelActions.some((a) => a.shortcut && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut))) {
      e.preventDefault();
      void panelActions.find((a) => a.shortcut && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut))?.run();
    } else if (e.key === "Enter" && target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox") {
      e.preventDefault();
      const focusables = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("input, textarea, select") ?? []);
      const idx = focusables.indexOf(target);
      if (idx >= 0 && idx < focusables.length - 1) focusables[idx + 1].focus();
      else void submit();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const set = (f: FormFieldModel, v: FormValue) => {
    setValues((s) => ({ ...s, [f.id]: v }));
    if (errors[f.id]) setErrors((s) => ({ ...s, [f.id]: "" }));
    onFieldChange?.(f, v);
  };
  const blur = (f: FormFieldModel) => onFieldBlur?.(f, valuesRef.current[f.id] ?? "");

  return (
    <form
      ref={rootRef}
      className="extensions-form"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {description && <div className="extensions-form__desc">{description}</div>}
      {fields.map((f) => {
        if (f.type === "separator") return <hr key={f.id} className="extensions-form__sep" />;
        if (f.type === "description")
          return (
            <div key={f.id} className="extensions-form__row">
              <div className="extensions-form__label">{f.title}</div>
              <div className="extensions-form__control extensions-form__text">{f.text}</div>
            </div>
          );
        const id = `ext-field-${f.id}`;
        const shownError = errors[f.id] || f.error;
        const common = { id, "data-field": f.id, disabled: busy, "aria-invalid": !!shownError || undefined, onBlur: () => blur(f) };
        const value = values[f.id];
        let control: ReactNode;
        if (f.type === "checkbox")
          control = (
            <label className="extensions-form__check">
              <input {...common} type="checkbox" checked={value === true} onChange={(e) => set(f, e.target.checked)} />
              <span>{f.placeholder ?? f.title}</span>
            </label>
          );
        else if (f.type === "dropdown")
          control = (
            <select {...common} className="input" value={String(value ?? "")} onChange={(e) => set(f, e.target.value)}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.section ? `${o.section} › ${o.title}` : o.title}
                </option>
              ))}
            </select>
          );
        else if (f.type === "tags") {
          const chosen = Array.isArray(value) ? value : [];
          control = (
            <div className="extensions-form__tags" role="group" aria-label={f.title}>
              {f.options.map((o, i) => (
                <label key={o.value} className={`extensions-form__tag ${chosen.includes(o.value) ? "extensions-form__tag--on" : ""}`}>
                  <input
                    type="checkbox"
                    data-field={i === 0 ? f.id : undefined}
                    disabled={busy}
                    checked={chosen.includes(o.value)}
                    onChange={(e) => set(f, e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))}
                    onBlur={() => blur(f)}
                  />
                  {o.title}
                </label>
              ))}
            </div>
          );
        } else if (f.type === "file") {
          const paths = Array.isArray(value) ? value : [];
          control = (
            <div className="extensions-form__file">
              <input {...common} className="input" type="text" placeholder="Path(s), one per line" value={paths.join("\n")} spellCheck={false} onChange={(e) => set(f, e.target.value.split("\n").filter(Boolean))} />
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  const picked = await ext<string[]>("pickPaths", f.multiple === true, f.directories === true).catch(() => []);
                  if (picked.length) set(f, f.multiple ? picked : picked.slice(0, 1));
                }}
              >
                Choose…
              </button>
            </div>
          );
        } else if (f.type === "date" || f.type === "datetime")
          control = (
            <input
              {...common}
              className="input"
              type={f.type === "date" ? "date" : "datetime-local"}
              value={toInputDate(String(value ?? ""), f.type === "datetime")}
              onChange={(e) => set(f, fromInputDate(e.target.value))}
            />
          );
        else if (f.type === "textarea")
          control = <textarea {...common} className="input extensions-form__textarea" rows={4} placeholder={f.placeholder} value={String(value ?? "")} onChange={(e) => set(f, e.target.value)} />;
        else
          control = (
            <input
              {...common}
              className="input"
              type={f.type === "password" ? "password" : "text"}
              placeholder={f.placeholder}
              value={String(value ?? "")}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set(f, e.target.value)}
            />
          );
        return (
          <div key={f.id} className="extensions-form__row">
            <label className="extensions-form__label" htmlFor={id}>
              {f.title}
              {f.required && <span className="extensions-form__req"> *</span>}
            </label>
            <div className="extensions-form__control">
              {control}
              {shownError ? <div className="extensions-form__error">{shownError}</div> : f.info ? <div className="extensions-form__info">{f.info}</div> : null}
            </div>
          </div>
        );
      })}
      <div className="extensions-form__foot">
        {onCancel && (
          <span className="extensions-form__hint">
            <Kbd keys="⎋" /> Cancel
          </span>
        )}
        <span className="extensions-form__hint">
          <Kbd keys="⇥" /> Next field
        </span>
        {panelActions.length > 1 && (
          <span className="extensions-form__hint">
            <Kbd keys="⌘K" /> Actions
          </span>
        )}
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Working…" : (primary?.title ?? submitTitle)} <Kbd keys="⌘⏎" />
        </button>
      </div>
      {panel && (
        <ActionPanel
          title="Actions"
          actions={panelActions}
          onRun={(a) => {
            setPanel(false);
            void a.run();
          }}
          onClose={() => {
            setPanel(false);
            host?.focusSearch();
          }}
        />
      )}
    </form>
  );
}
