import { useEffect, useRef, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { ViewProps } from "../types";
import { glide } from "../../lib/glide";
import { useNavController } from "../../lib/navHost";
import { Kbd } from "../../components/Kbd";
import type { ScriptInfo, ScriptsState } from "../../../main/features/scripts/types";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("scripts", method, ...args);

export function ScriptArguments({ props, push, close, toast, setPlaceholder }: ViewProps<{ scriptId?: string; values?: string[] }>) {
  const [script, setScript] = useState<ScriptInfo | null>(null);
  const [values, setValues] = useState<string[]>(Array.isArray(props.values) ? props.values.map(String) : []);
  const [focus, setFocus] = useState(0);
  const refs = useRef<Array<HTMLInputElement | HTMLSelectElement | null>>([]);

  useEffect(() => {
    void call<ScriptsState>("state").then((s) => setScript(s.scripts.find((x) => x.id === props.scriptId) ?? null));
  }, [props.scriptId]);

  useEffect(() => {
    if (!script) return;
    setPlaceholder(`Arguments for ${script.title ?? script.file}`);
    const first = script.arguments.findIndex((a, i) => !a.optional && !values[i]);
    const i = first >= 0 ? first : 0;
    setFocus(i);
    requestAnimationFrame(() => refs.current[i]?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script]);

  const submit = async () => {
    if (!script) return;
    const missing = script.arguments.findIndex((a, i) => !a.optional && !values[i]?.trim());
    if (missing >= 0) {
      toast(`${script.arguments[missing].placeholder} is required`, "error");
      refs.current[missing]?.focus();
      return;
    }
    const res = await call<ExecuteResult>("run", script.id, values);
    if (res.error) toast(res.error, "error");
    else if (res.message) toast(res.message);
    if (res.view) push(res.view);
    else if (res.hide) close();
  };

  const moveFocus = (d: number) => {
    if (!script) return;
    const i = Math.min(script.arguments.length - 1, Math.max(0, focus + d));
    setFocus(i);
    refs.current[i]?.focus();
  };

  useNavController({
    nav: (c) => (c.type === "move" ? moveFocus(c.delta) : undefined),
    activate: () => void submit(),
    secondary: () => void submit(),
    toggleActions: () => undefined,
    findAction: async () => null,
  });

  if (!script) return <div className="navlist__empty">Loading…</div>;
  return (
    <div
      className="scripts-args"
      onKeyDown={(e) => {
        // Own the keys while a field has focus so the launcher does not also act on them.
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void submit();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.key === "Tab" && !e.metaKey)) {
          if ((e.target as HTMLElement).tagName === "SELECT" && e.key !== "Tab") return;
          e.preventDefault();
          e.stopPropagation();
          moveFocus(e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
        }
      }}
    >
      <div className="scripts-args__title">
        {script.icon && !/[./]/.test(script.icon) ? script.icon : "📜"} {script.title}
      </div>
      {script.arguments.map((a, i) => (
        <label key={i} className="scripts-args__field">
          <span>
            {a.placeholder}
            {a.optional ? <span className="faint"> (optional)</span> : null}
          </span>
          {a.type === "dropdown" ? (
            <select
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="select"
              value={values[i] ?? ""}
              onFocus={() => setFocus(i)}
              onChange={(e) => setValues((v) => Object.assign([...v], { [i]: e.target.value }))}
            >
              <option value="">Choose…</option>
              {a.data?.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.title}
                </option>
              ))}
            </select>
          ) : (
            <input
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="input"
              type={a.type === "password" ? "password" : "text"}
              placeholder={a.placeholder}
              value={values[i] ?? ""}
              onFocus={() => setFocus(i)}
              onChange={(e) => setValues((v) => Object.assign([...v], { [i]: e.target.value }))}
            />
          )}
        </label>
      ))}
      <div className="scripts-args__keys faint">
        <Kbd keys="⏎" /> run · <Kbd keys="↑ ↓" /> switch field · <Kbd keys="⎋" /> back
      </div>
    </div>
  );
}
