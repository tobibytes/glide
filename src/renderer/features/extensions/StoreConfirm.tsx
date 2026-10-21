/** In-launcher confirmation card for store installs/updates/uninstalls (⏎ confirms, ⎋ cancels). */
import { useEffect, useRef } from "react";

export interface StoreConfirmRequest {
  title: string;
  message: string;
  detail?: string;
  confirmTitle: string;
  destructive?: boolean;
}

export function StoreConfirm({ req, onAnswer }: { req: StoreConfirmRequest; onAnswer(ok: boolean): void }) {
  const done = useRef(false);
  const answer = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    onAnswer(ok);
  };
  useEffect(() => {
    // Capture phase so the launcher's search field never sees these keys (⎋ would pop the view).
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter" || e.key.toLowerCase() === "y") answer(true);
      else if (e.key === "Escape" || e.key.toLowerCase() === "n") answer(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  return (
    <div className="extensions-storeconfirm" role="alertdialog" aria-modal="true" aria-label={req.title}>
      <div className="extensions-storeconfirm__card">
        <div className="extensions-storeconfirm__title">{req.title}</div>
        <div className="extensions-storeconfirm__msg">{req.message}</div>
        {req.detail && <div className="extensions-storeconfirm__detail">{req.detail}</div>}
        <div className="extensions-storeconfirm__buttons">
          <button type="button" className="btn" onClick={() => answer(false)}>
            Cancel <kbd className="kbd">⎋</kbd>
          </button>
          <button type="button" className={`btn btn--primary ${req.destructive ? "extensions-storeconfirm__danger" : ""}`} data-confirm onClick={() => answer(true)}>
            {req.confirmTitle} <kbd className="kbd">⏎</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
