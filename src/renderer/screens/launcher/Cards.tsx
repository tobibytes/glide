import { useEffect, useRef, useState } from "react";
import type { AskInputRequest, ShowResultPayload } from "@shared/ipc";
import { Kbd } from "../../components/Kbd";

export function PromptCard({ request, onAnswer }: { request: AskInputRequest; onAnswer: (value: string | null) => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [request.requestId]);
  return (
    <div
      className="card"
      role="dialog"
      aria-label={request.prompt}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onAnswer(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onAnswer(null);
        }
      }}
    >
      <div className="card__prompt">{request.prompt}</div>
      <input ref={ref} className="card__input" placeholder={request.placeholder ?? "Type your answer…"} value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="card__actions">
        <button type="button" className="btn" onClick={() => onAnswer(null)}>
          Cancel <Kbd keys="⎋" />
        </button>
        <button type="button" className="btn btn--primary" onClick={() => onAnswer(value)}>
          Continue <Kbd keys="⏎" />
        </button>
      </div>
    </div>
  );
}

export function ResultCard({ payload, onDone, onCopy }: { payload: ShowResultPayload; onDone: () => void; onCopy: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [payload]);
  return (
    <div
      ref={ref}
      className="card"
      role="dialog"
      tabIndex={-1}
      aria-label={payload.title ?? "Result"}
      style={{ outline: "none" }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          onDone();
        } else if (e.key === "c" && e.metaKey && !window.getSelection()?.toString()) {
          e.preventDefault();
          onCopy();
        }
      }}
    >
      <div className="card__title">{payload.title || "Result"}</div>
      <pre className="card__text">{payload.text}</pre>
      <div className="card__actions">
        <button type="button" className="btn" onClick={onCopy}>
          Copy <Kbd keys="⌘C" />
        </button>
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done <Kbd keys="⎋" />
        </button>
      </div>
    </div>
  );
}
