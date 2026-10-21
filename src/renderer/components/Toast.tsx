import { useEffect, useState } from "react";

export interface ToastMessage {
  id: number;
  text: string;
  kind: "info" | "error";
}

let seq = 0;
export const makeToast = (text: string, kind: ToastMessage["kind"] = "info"): ToastMessage => ({ id: ++seq, text, kind });

export function useToast(ttl = 2500): { toast: ToastMessage | null; show: (text: string, kind?: ToastMessage["kind"]) => void } {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), ttl);
    return () => clearTimeout(t);
  }, [toast, ttl]);
  return { toast, show: (text, kind = "info") => setToast(makeToast(text, kind)) };
}

export function Toast({ toast }: { toast: ToastMessage | null }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind === "error" ? "toast--error" : ""}`} role="status" aria-live="polite">
      {toast.text}
    </div>
  );
}
