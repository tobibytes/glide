import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Settings } from "@shared/types";
import { glide } from "../../lib/glide";
import { accelToDisplay } from "../../lib/keys";
import { Kbd } from "../../components/Kbd";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { normalizeAppearance, resolvePreset } from "../../../main/features/appearance/themes";
import { canonicalAccel, knownHotkeyConflict, PERMISSION_KINDS, type PermissionKind, type PermissionsSnapshot, type PermissionState } from "../../../main/features/onboarding/system";
import { appearanceApi, type AppearanceState } from "../appearance/api";
import { MiniLauncher, Swatches } from "../appearance/Preview";
import { aiApi, onboardingApi, type AiKeyStatus, type OnboardingState } from "./api";

function StepTitle({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return (
    <div className="onboarding-title">
      <div className="onboarding-title__eyebrow">{eyebrow}</div>
      <h1 className="onboarding-title__h">{title}</h1>
      <p className="onboarding-title__lead">{lead}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------- Welcome

const HIGHLIGHTS = [
  { icon: "⚡", title: "One search for everything", body: "Apps, files, clipboard history, snippets, calculator, windows and your own workflows." },
  { icon: "⌨️", title: "Keyboard-first, vim-friendly", body: "Every screen works without a mouse. j/k, gg/G and ⌘K actions everywhere." },
  { icon: "✨", title: "Automate and ask AI", body: "Build workflows, run Raycast-style extensions and ask Claude about anything you select." },
];

export function StepWelcome() {
  return (
    <div className="onboarding-step onboarding-welcome">
      <div className="onboarding-welcome__mark" aria-hidden="true">
        <span>G</span>
      </div>
      <h1 className="onboarding-welcome__h">Welcome to Glide</h1>
      <p className="onboarding-welcome__lead">A keyboard-first launcher for your Mac. Press a shortcut, type a few letters, hit return.</p>
      <ul className="onboarding-highlights">
        {HIGHLIGHTS.map((h) => (
          <li key={h.title} className="onboarding-highlight">
            <span className="onboarding-highlight__icon" aria-hidden="true">
              {h.icon}
            </span>
            <span className="onboarding-highlight__title">{h.title}</span>
            <span className="onboarding-highlight__body">{h.body}</span>
          </li>
        ))}
      </ul>
      <p className="onboarding-welcome__foot">Takes about a minute. Everything here can be changed later in Settings.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------- Hotkey

type HotkeyChoice = "alt" | "cmd" | "custom";

const choiceFor = (accel: string): HotkeyChoice => {
  const c = canonicalAccel(accel);
  return c === "option+space" ? "alt" : c === "command+space" ? "cmd" : "custom";
};

export function StepHotkey({ state, onChanged, onContinue }: { state: OnboardingState | null; onChanged(): Promise<void>; onContinue(): void }) {
  const hotkey = state?.hotkey ?? "Alt+Space";
  const [picked, setPicked] = useState<HotkeyChoice>(() => choiceFor(hotkey));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<HTMLDivElement>(null);
  const current = choiceFor(hotkey);

  const apply = useCallback(
    async (run: () => Promise<{ ok: boolean; hotkey: string; error?: string }>): Promise<boolean> => {
      setBusy(true);
      try {
        const r = await run();
        setMessage(r.ok ? { ok: true, text: `Glide opens with ${accelToDisplay(r.hotkey)}` } : { ok: false, text: r.error ?? "That shortcut couldn't be registered." });
        await onChanged();
        return r.ok;
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const choose = async (c: HotkeyChoice): Promise<boolean> => {
    setPicked(c);
    if (c === "alt") return apply(() => onboardingApi.setHotkey("Alt+Space"));
    if (c === "cmd") return apply(() => onboardingApi.useCommandSpace());
    recorderRef.current?.querySelector<HTMLElement>(".hotkey")?.focus();
    return false;
  };

  const onOptionKey = (c: HotkeyChoice) => (e: ReactKeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // Enter on the current choice just continues; on another one it applies it first.
      if (e.key === "Enter" && c === current && c !== "custom") return onContinue();
      void choose(c).then((ok) => ok && e.key === "Enter" && onContinue());
    }
  };

  const record = (accel: string | null) => {
    if (!accel) return;
    setPicked("custom");
    if (canonicalAccel(accel) === "command+space") {
      setMessage({ ok: false, text: "To use ⌘Space, pick “Use ⌘Space” above so Spotlight's shortcut is turned off first." });
      return;
    }
    const conflict = knownHotkeyConflict(accel);
    if (conflict) {
      setMessage({ ok: false, text: conflict });
      return;
    }
    void apply(() => onboardingApi.setHotkey(accel));
  };

  const options: Array<{ id: HotkeyChoice; keys: string; title: string; body: string }> = [
    { id: "alt", keys: "⌥ Space", title: "Option + Space", body: "Recommended. Works alongside Spotlight." },
    {
      id: "cmd",
      keys: "⌘ Space",
      title: "Use ⌘Space (replace Spotlight)",
      body: state && !state.helperAvailable ? "Turns off Spotlight's ⌘Space shortcut. Needs the Glide helper, which isn't running right now." : "Turns off Spotlight's ⌘Space shortcut so Glide can use it. Undo any time in Settings → Keyboard.",
    },
    { id: "custom", keys: current === "custom" ? accelToDisplay(hotkey) : "…", title: "Record your own", body: "Focus the recorder and press any combination with a modifier." },
  ];

  return (
    <div className="onboarding-step">
      <StepTitle eyebrow="Step 1 · Hotkey" title="Summon Glide from anywhere" lead="Pick the shortcut that opens the launcher. You'll press it dozens of times a day, so make it comfortable." />
      <div className="onboarding-options" role="radiogroup" aria-label="Launcher hotkey" data-tour-list>
        {options.map((o) => (
          <div
            key={o.id}
            role="radio"
            tabIndex={0}
            aria-checked={current === o.id}
            data-tour-item
            data-choice={o.id}
            data-autofocus={current === o.id ? "" : undefined}
            className={`onboarding-option ${current === o.id ? "is-checked" : ""} ${picked === o.id ? "is-picked" : ""}`}
            onClick={() => void choose(o.id)}
            onKeyDown={onOptionKey(o.id)}
          >
            <span className="onboarding-option__radio" aria-hidden="true" />
            <span className="onboarding-option__keys">{o.keys}</span>
            <span className="onboarding-option__text">
              <span className="onboarding-option__title">{o.title}</span>
              <span className="onboarding-option__body">{o.body}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="onboarding-recorder" ref={recorderRef}>
        <span className="onboarding-recorder__label">Custom shortcut</span>
        <HotkeyRecorder value={current === "custom" ? hotkey : undefined} onChange={record} placeholder="Click or Tab here, then press keys" />
      </div>
      <p className={`onboarding-status ${message ? (message.ok ? "is-ok" : "is-error") : ""}`} role="status" aria-live="polite" data-busy={busy || undefined}>
        {message?.text ?? `Glide currently opens with ${accelToDisplay(hotkey)}.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------- Permissions

const PERMISSION_ROWS: Record<PermissionKind, { icon: string; title: string; why: string }> = {
  accessibility: { icon: "🪟", title: "Accessibility", why: "Move and resize windows, search menus, read selected text and paste into apps." },
  inputMonitoring: { icon: "⌨️", title: "Input Monitoring", why: "Expand snippets as you type and turn Caps Lock into a Hyper key." },
  screenRecording: { icon: "🖥️", title: "Screen Recording", why: "Grab text and QR codes from anything on screen." },
  calendars: { icon: "📅", title: "Calendars", why: "Show today's events and join meetings from the launcher." },
  reminders: { icon: "✅", title: "Reminders", why: "Create and complete reminders without opening the app." },
};

const PILL: Record<PermissionState, string> = { granted: "Granted", denied: "Not granted", notDetermined: "Not asked yet", unknown: "Unknown" };

export function StepPermissions() {
  const [snap, setSnap] = useState<PermissionsSnapshot | null>(null);
  const [opened, setOpened] = useState<PermissionKind | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      onboardingApi
        .permissions()
        .then((s) => alive && setSnap(s))
        .catch(() => undefined);
    void load();
    // Live: users flip switches in System Settings and come back.
    const timer = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const granted = snap ? PERMISSION_KINDS.filter((k) => snap.status[k] === "granted").length : 0;

  return (
    <div className="onboarding-step">
      <StepTitle
        eyebrow="Step 2 · Permissions"
        title="Grant only what you'll use"
        lead="Everything is optional. Glide works without these; features that need one will tell you. Status updates live."
      />
      <div className="onboarding-perms" data-tour-list aria-label="Permissions">
        {PERMISSION_KINDS.map((kind) => {
          const row = PERMISSION_ROWS[kind];
          const status: PermissionState = snap?.status[kind] ?? "unknown";
          return (
            <div key={kind} className="onboarding-perm" data-permission={kind} data-status={status} role="group" aria-label={`${row.title}: ${PILL[status]}`}>
              <span className="onboarding-perm__icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="onboarding-perm__text">
                <span className="onboarding-perm__title">{row.title}</span>
                <span className="onboarding-perm__why">{row.why}</span>
              </span>
              <span className={`onboarding-pill onboarding-pill--${status}`}>{PILL[status]}</span>
              <button
                type="button"
                className={`btn btn--sm ${status === "granted" ? "btn--ghost" : ""}`}
                data-tour-item
                aria-label={`Open System Settings for ${row.title}`}
                onClick={() => {
                  setOpened(kind);
                  void onboardingApi.openPermissionSettings(kind);
                }}
              >
                Open Settings
              </button>
            </div>
          );
        })}
      </div>
      <p className="onboarding-status" role="status" aria-live="polite">
        {snap ? `${granted} of ${PERMISSION_KINDS.length} granted` : "Checking…"}
        {opened ? ` · Opened ${PERMISSION_ROWS[opened].title} in System Settings — turn on Glide there, then come back.` : ""}
        {snap?.source === "fallback" ? " · Some statuses appear once the Glide helper is running." : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------- AI

export function StepAi({ onContinue }: { onContinue(): void }) {
  const [status, setStatus] = useState<AiKeyStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void aiApi.hasApiKey().then(setStatus).catch(() => setStatus(null));
  }, []);

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) return onContinue();
    setBusy(true);
    setResult({ ok: true, text: "Saving and checking your key…" });
    try {
      setStatus(await aiApi.setApiKey(trimmed));
      setKey("");
      const t = await aiApi.testConnection();
      setResult({ ok: t.ok, text: t.message });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setStatus(await aiApi.clearApiKey());
    setResult({ ok: true, text: "Key removed." });
  };

  return (
    <div className="onboarding-step">
      <StepTitle eyebrow="Step 3 · AI (optional)" title="Bring Claude into Glide" lead="Paste an Anthropic API key to ask AI from the launcher, chat, and transform selected text. Skip this if you don't need it." />
      <div className="onboarding-ai">
        <label className="onboarding-ai__label" htmlFor="onboarding-ai-key">
          Anthropic API key
        </label>
        <div className="onboarding-ai__row">
          <input
            id="onboarding-ai-key"
            className="onboarding-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.hasKey ? "A key is saved — paste a new one to replace it" : "sk-ant-…"}
            value={key}
            data-autofocus=""
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <button type="button" className="btn btn--primary" disabled={busy || !key.trim()} onClick={() => void save()}>
            Save &amp; Test
          </button>
        </div>
        <div className="onboarding-ai__meta">
          <span className={`onboarding-pill ${status?.hasKey ? "onboarding-pill--granted" : "onboarding-pill--unknown"}`}>{status?.hasKey ? "Key saved" : "No key"}</span>
          {status?.hasKey && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void remove()}>
              Remove key
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void aiApi.openUrl("https://console.anthropic.com/settings/keys")}>
            Get a key ↗
          </button>
        </div>
        <p className={`onboarding-status ${result ? (result.ok ? "is-ok" : "is-error") : ""}`} role="status" aria-live="polite" data-busy={busy || undefined}>
          {result?.text ?? "Your key is encrypted on this Mac and only sent to Anthropic."}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Look

function Switch({ checked, label, hint, onChange }: { checked: boolean; label: string; hint: string; onChange(v: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="onboarding-switch" onClick={() => onChange(!checked)}>
      <span className="onboarding-switch__text">
        <span className="onboarding-switch__label">{label}</span>
        <span className="onboarding-switch__hint">{hint}</span>
      </span>
      <span className="onboarding-switch__track" aria-hidden="true">
        <span className="onboarding-switch__thumb" />
      </span>
    </button>
  );
}

export function StepLook() {
  const [appearance, setAppearance] = useState<AppearanceState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const load = useCallback(async () => {
    const [a, d] = await Promise.all([appearanceApi.get(), glide().getData()]);
    setAppearance(a);
    setSettings(d.settings);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
    return glide().onDataChanged((d) => {
      setSettings(d.settings);
      void appearanceApi.get().then(setAppearance).catch(() => undefined);
    });
  }, [load]);

  const s = appearance ? normalizeAppearance(appearance.settings) : null;
  const active = appearance && s ? resolvePreset(appearance.mode, appearance.systemDark, s) : null;

  const pick = (id: string) => {
    if (active?.id === id) return;
    void appearanceApi.applyPreset(id).then(load).catch(() => undefined);
  };

  return (
    <div className="onboarding-step onboarding-look">
      <StepTitle eyebrow="Step 4 · Look & feel" title="Make it yours" lead="Pick a theme — it applies instantly. Use j/k to flip through them." />
      <div className="onboarding-look__grid">
        <div className="onboarding-themes" role="radiogroup" aria-label="Theme" data-tour-list>
          {(appearance?.presets ?? []).map((p) => (
            <div
              key={p.id}
              role="radio"
              tabIndex={0}
              aria-checked={active?.id === p.id}
              data-tour-item
              data-preset={p.id}
              data-autofocus={active?.id === p.id ? "" : undefined}
              className={`onboarding-theme ${active?.id === p.id ? "is-checked" : ""}`}
              onFocus={() => pick(p.id)}
              onClick={() => pick(p.id)}
              onKeyDown={(e) => {
                if (e.key === " ") {
                  e.preventDefault();
                  pick(p.id);
                }
              }}
            >
              <Swatches preset={p} />
              <span className="onboarding-theme__name">{p.name}</span>
              <span className="onboarding-theme__scheme">{p.scheme === "dark" ? "Dark" : "Light"}</span>
            </div>
          ))}
        </div>
        <div className="onboarding-look__side">
          {active && s && (
            <div className="onboarding-preview">
              <MiniLauncher preset={active} settings={s} size="large" />
            </div>
          )}
          {settings && (
            <div className="onboarding-switches">
              <Switch checked={settings.vimMode} label="Vim keys" hint="Esc for normal mode, then j/k, gg, G, / …" onChange={(v) => void glide().setSettings({ vimMode: v })} />
              <Switch
                checked={settings.keepOpenAfterRun}
                label="Keep open after running"
                hint="Stay in Glide after a command (apps still close it)."
                onChange={(v) => void glide().setSettings({ keepOpenAfterRun: v })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Done

export function StepDone({ hotkey }: { hotkey: string }) {
  const sheet: Array<{ keys: string; typed?: boolean; title: string; body: string }> = [
    { keys: accelToDisplay(hotkey), title: "Open Glide", body: "From any app" },
    { keys: "⌘K", title: "Actions", body: "Everything you can do here" },
    { keys: "⌘1 … ⌘9", title: "Run by position", body: "Skip the arrow keys" },
    { keys: "⇥", title: "Add an argument", body: "“g cats” searches Google" },
    { keys: "Esc j k", title: "Vim navigation", body: "Normal mode, then move" },
    { keys: "clipboard", typed: true, title: "Clipboard History", body: "Search and paste past copies" },
    { keys: "left half", typed: true, title: "Window management", body: "Snap the front window" },
    { keys: "5 ft in cm", typed: true, title: "Calculator & units", body: "Answers as you type" },
  ];
  return (
    <div className="onboarding-step onboarding-done">
      <StepTitle eyebrow="All set" title="You're ready to glide" lead="Eight things worth remembering. Search “Welcome to Glide” to see this tour again." />
      <ul className="onboarding-sheet" aria-label="Cheat sheet">
        {sheet.map((r) => (
          <li key={r.title} className="onboarding-sheet__row">
            {r.typed ? <span className="onboarding-sheet__typed">{r.keys}</span> : <Kbd keys={r.keys} className="onboarding-sheet__kbd" />}
            <span className="onboarding-sheet__text">
              <span className="onboarding-sheet__title">{r.title}</span>
              <span className="onboarding-sheet__body">{r.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
