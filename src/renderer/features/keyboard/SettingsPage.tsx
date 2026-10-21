import { useCallback, useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { Kbd } from "../../components/Kbd";
import { glide } from "../../lib/glide";

interface PermissionStatus {
  accessibility: boolean;
  inputMonitoring: boolean;
  calendar: string;
}

interface KeyboardState {
  helperAvailable: boolean;
  permissions: PermissionStatus | null;
  settings: { expandSnippets: boolean; hyperKey: "off" | "capslock"; spotlightTakeover: boolean; previousHotkey: string };
  keywordCount: number;
  active: boolean;
  spotlightShortcutEnabled: boolean | null;
  hotkey: string;
  lastError: string | null;
  expansions: number;
}

const call = (method: string, ...args: unknown[]) => glide().feature<KeyboardState>("keyboard", method, ...args);

function PermissionRow({ label, hint, granted, onGrant }: { label: string; hint: string; granted: boolean | undefined; onGrant: () => void }) {
  return (
    <Row label={label} hint={hint}>
      {granted ? (
        <span className="keyboard-perm keyboard-perm--ok">✓ Granted</span>
      ) : (
        <button type="button" className="btn btn--sm" onClick={onGrant}>
          Grant…
        </button>
      )}
    </Row>
  );
}

export function KeyboardSettingsPage() {
  const [s, setS] = useState<KeyboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (p: Promise<KeyboardState>) => {
    setBusy(true);
    try {
      setS(await p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(call("getState"));
    const off = glide().onFeatureEvent((e) => {
      if (e.feature === "keyboard" && e.event === "state") setS(e.payload as KeyboardState);
    });
    // Permissions change in System Settings; refresh when the user comes back.
    const onFocus = () => void call("getState").then(setS, () => undefined);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [run]);

  if (!s) return <div className="page">{error ? <div className="error-banner">{error}</div> : "Loading…"}</div>;
  const ax = s.permissions?.accessibility;
  const status = !s.helperAvailable
    ? "The Glide helper is not running, so keyboard features are unavailable."
    : !ax
      ? "Waiting for Accessibility permission."
      : s.lastError
        ? s.lastError
        : s.active
          ? `Active${s.settings.expandSnippets ? ` — watching ${s.keywordCount} keyword${s.keywordCount === 1 ? "" : "s"}` : ""}.`
          : "Idle.";

  return (
    <div className="page">
      {error && <div className="error-banner">{error}</div>}

      <Group title="Permissions" footer="Glide watches keystrokes only to expand snippet keywords and to turn Caps Lock into the Hyper key. Nothing leaves your Mac.">
        <PermissionRow label="Accessibility" hint="Needed to expand snippets, use the Hyper key, move windows and read menus" granted={ax} onGrant={() => void run(call("requestPermission", "accessibility"))} />
        <PermissionRow label="Input Monitoring" hint="Lets Glide see keystrokes in every app" granted={s.permissions?.inputMonitoring} onGrant={() => void run(call("requestPermission", "inputMonitoring"))} />
      </Group>

      <Group title="Snippets" footer={<span className={s.lastError ? "keyboard-status keyboard-status--error" : "keyboard-status"}>{status}</span>}>
        <Row label="Expand snippet keywords as you type" hint="Type a snippet's keyword (e.g. ;sig) anywhere and Glide replaces it with the snippet. Set keywords in Snippets settings.">
          <Toggle label="Expand snippet keywords" checked={s.settings.expandSnippets} onChange={(v) => void run(call("setExpandSnippets", v))} />
        </Row>
      </Group>

      <Group title="Hyper key" footer="Glide remaps Caps Lock only while this is on and restores it when you turn it off or quit Glide.">
        <Row label="Hyper key" hint="Hold Caps Lock to press ⌃⌥⇧⌘ together, so every key becomes a free shortcut. Tap it alone for Escape." htmlFor="keyboard-hyper">
          <select id="keyboard-hyper" className="select" value={s.settings.hyperKey} disabled={busy} onChange={(e) => void run(call("setHyperKey", e.target.value))}>
            <option value="off">Off</option>
            <option value="capslock">Caps Lock</option>
          </select>
        </Row>
      </Group>

      <Group
        title="Spotlight"
        footer={
          s.settings.spotlightTakeover
            ? "Spotlight's ⌘Space shortcut is off. Turn this off to give ⌘Space back to Spotlight and restore your previous Glide hotkey."
            : "Turns off Spotlight's ⌘Space shortcut in System Settings and makes ⌘Space open Glide."
        }
      >
        <Row label={<>Use <Kbd keys="⌘Space" /> for Glide</>} hint={`Current Glide hotkey: ${s.hotkey || "none"}${s.spotlightShortcutEnabled === false && !s.settings.spotlightTakeover ? " · Spotlight's shortcut is already off" : ""}`}>
          <Toggle label="Use Command-Space for Glide" checked={s.settings.spotlightTakeover} onChange={(v) => !busy && void run(call("setUseCommandSpace", v))} />
        </Row>
      </Group>
    </div>
  );
}
