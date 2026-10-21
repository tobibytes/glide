/** Edit a text entry before pasting: ⌘⏎ paste, ⌥⌘⏎ paste and keep open, ⌘S save into history, ⎋ back. */
import { useEffect, useRef, useState } from "react";
import { Kbd } from "../../components/Kbd";
import type { ViewProps } from "../types";
import { clipApi } from "./api";

export function EditView({ props, setPlaceholder, pop, toast }: ViewProps) {
  const id = (props as { id?: string }).id ?? "";
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setPlaceholder("Editing clipboard entry — ⌘⏎ to paste"), [setPlaceholder]);
  useEffect(() => {
    void clipApi.get(id).then((e) => {
      setText(e?.text ?? "");
      requestAnimationFrame(() => ref.current?.focus());
    });
  }, [id]);

  const paste = async (keepOpen: boolean) => {
    if (!text) return;
    const r = await clipApi.pasteText(text, keepOpen);
    if (!r.ok) toast(r.error ?? "Failed", "error");
  };
  const saveEdit = async () => {
    if (!text) return;
    const r = await clipApi.update(id, text);
    toast(r ? "Saved" : "Could not save", r ? "info" : "error");
    if (r) pop();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void paste(e.altKey);
    } else if (e.key.toLowerCase() === "s" && e.metaKey && !e.shiftKey) {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      pop();
    }
  };

  return (
    <div className="clipboard-edit">
      {text === null ? (
        <div className="clipboard-detail__loading">Loading…</div>
      ) : (
        <textarea ref={ref} className="clipboard-edit__area" value={text} spellCheck={false} aria-label="Entry text" onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
      )}
      <div className="clipboard-hints">
        <span>
          <Kbd keys="⌘⏎" /> paste
        </span>
        <span>
          <Kbd keys="⌥⌘⏎" /> paste &amp; keep open
        </span>
        <span>
          <Kbd keys="⌘S" /> save to history
        </span>
        <span>
          <Kbd keys="⎋" /> back
        </span>
      </div>
    </div>
  );
}
