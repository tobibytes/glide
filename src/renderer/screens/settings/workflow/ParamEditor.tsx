import { useId, useRef } from "react";
import type { ActionSpec, SearchItem } from "@shared/types";
import { VariableMenu } from "./VariableMenu";

type ParamSpec = ActionSpec["params"][number];

interface Props {
  param: ParamSpec;
  value: string;
  onChange: (v: string) => void;
  variables: Array<{ name: string; hint: string }>;
  apps: SearchItem[];
  mono?: boolean;
}

/** One inline parameter editor; kind decides the control. */
export function ParamEditor({ param, value, onChange, variables, apps, mono }: Props) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const id = useId();

  const insertVar = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  let control: React.ReactNode;
  switch (param.kind) {
    case "select":
      control = (
        <select id={id} className="select" value={value || param.default || ""} onChange={(e) => onChange(e.target.value)}>
          {(param.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case "number":
      control = <input id={id} className="input" type="number" value={value} placeholder={param.placeholder} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 120 }} />;
      break;
    case "app": {
      const known = apps.some((a) => a.path === value);
      control = (
        <select id={id} className="select" value={known ? value : value ? "__custom" : ""} onChange={(e) => onChange(e.target.value === "__custom" ? value : e.target.value)}>
          <option value="">Choose an application…</option>
          {!known && value && <option value="__custom">{value}</option>}
          {apps.map((a) => (
            <option key={a.id} value={a.path ?? a.title}>
              {a.title}
            </option>
          ))}
        </select>
      );
      break;
    }
    case "multiline":
      control = (
        <>
          <textarea id={id} ref={ref as React.RefObject<HTMLTextAreaElement>} className={`textarea ${mono ? "mono" : ""}`} rows={3} value={value} placeholder={param.placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          <VariableMenu variables={variables} onInsert={insertVar} />
        </>
      );
      break;
    default:
      control = (
        <>
          <input
            id={id}
            ref={ref as React.RefObject<HTMLInputElement>}
            className={`input ${mono || param.kind === "file" || param.kind === "url" ? "mono" : ""}`}
            value={value}
            placeholder={param.placeholder}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />
          <VariableMenu variables={variables} onInsert={insertVar} />
        </>
      );
  }

  return (
    <div className="param">
      <label className="param__label" htmlFor={id} title={param.label}>
        {param.label}
        {param.required && <span className="req">*</span>}
      </label>
      <div className="param__control">{control}</div>
    </div>
  );
}
