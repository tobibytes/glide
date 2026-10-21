/**
 * ⌘⏎ in the launcher's root search sends the typed query straight to Glide Agent (Settings →
 * Agent can turn this off; the selected row's own ⌘⏎ action stays in ⌘K). Installed once in the
 * launcher window; it only acts when no view is pushed and no argument is being typed.
 */
import { agent } from "./api";

let installed = false;
let enabled = true;

const isLauncherWindow = () => {
  const h = window.location.hash;
  return h === "" || h === "#" || h === "#/";
};

export function installLauncherShortcut(): void {
  if (installed || typeof window === "undefined" || !isLauncherWindow()) return;
  installed = true;
  void agent
    .getSettings()
    .then((s) => (enabled = s.launcherShortcut))
    .catch(() => undefined);
  window.glide.onFeatureEvent((e) => {
    if (e.feature === "agent" && e.event === "settings") enabled = (e.payload as { launcherShortcut?: boolean } | undefined)?.launcherShortcut !== false;
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!enabled || e.key !== "Enter" || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.isComposing) return;
      const input = e.target as HTMLElement | null;
      if (!input?.classList?.contains("launcher__input")) return;
      if (document.querySelector(".launcher__view, .argpill, .actions[role='dialog']")) return;
      const query = (input as HTMLInputElement).value.trim();
      if (!query) return;
      e.preventDefault();
      e.stopPropagation();
      void agent.openFromLauncher(query);
    },
    true,
  );
}
