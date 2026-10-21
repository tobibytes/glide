import { Kbd } from "../../components/Kbd";
import { SETTINGS_PAGE } from "./api";

/** Shown by every AI surface when no API key is stored. */
export function AddKeyState({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`ai-nokey ${compact ? "ai-nokey--compact" : ""}`} data-testid="ai-nokey">
      <div className="ai-nokey__icon">🔑</div>
      <div className="ai-nokey__title">Add your API key in Settings → AI</div>
      <p className="ai-nokey__text">Glide talks to Claude with your own Anthropic API key. It is stored encrypted in your macOS keychain-backed storage and never leaves this Mac except to call the Anthropic API.</p>
      <button type="button" className="ai-btn ai-btn--primary" onClick={() => window.glide.openSettings(SETTINGS_PAGE)}>
        Open Settings → AI <Kbd keys="⏎" />
      </button>
    </div>
  );
}

export function Thinking() {
  return (
    <div className="ai-thinking" aria-live="polite">
      <span />
      <span />
      <span />
    </div>
  );
}

export function ErrorNote({ message, kind }: { message: string; kind: string }) {
  return (
    <div className="ai-error" role="alert" data-kind={kind}>
      <span>{message}</span>
      {(kind === "auth" || kind === "no-key" || kind === "permission") && (
        <button type="button" className="ai-btn" onClick={() => window.glide.openSettings(SETTINGS_PAGE)}>
          Settings → AI
        </button>
      )}
    </div>
  );
}
