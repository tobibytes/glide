import { useEffect } from "react";
import { Kbd } from "../../components/Kbd";
import type { PendingKill } from "./common";

/** Inline confirmation that owns ⏎ / esc (capture phase, ahead of NavList and the launcher's esc-to-pop). */
export function ConfirmKill({ pending, onConfirm, onCancel }: { pending: PendingKill; onConfirm(): void; onCancel(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Enter") onConfirm();
      else onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel]);
  const verb = pending.sig === "SIGKILL" ? "Force quit" : "Quit";
  return (
    <div className="processes-confirm" role="alertdialog" aria-label={`${verb} ${pending.name}`}>
      <div className="processes-confirm__text">
        <strong>
          {verb} {pending.name} (PID {pending.pid})?
        </strong>
        <span>{pending.reason}</span>
      </div>
      <span className="processes-confirm__keys">
        <Kbd keys="⏎" /> {verb} <Kbd keys="esc" /> Cancel
      </span>
    </div>
  );
}
