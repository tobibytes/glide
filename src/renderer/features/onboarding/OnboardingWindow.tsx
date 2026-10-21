import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { glide } from "../../lib/glide";
import { Kbd } from "../../components/Kbd";
import { flowReducer, initialFlow, STEP_LABELS, STEPS, stepIndex, type StepId } from "../../../main/features/onboarding/steps";
import { onboardingApi, type OnboardingState } from "./api";
import { targetKind, tourKey } from "./keys";
import { StepAi, StepDone, StepHotkey, StepLook, StepPermissions, StepWelcome } from "./Steps";

/** Move focus within the current step's list ([data-tour-list] → [data-tour-item]). */
function moveInList(root: HTMLElement | null, delta: 1 | -1): boolean {
  const list = root?.querySelector<HTMLElement>("[data-tour-list]");
  if (!list) return false;
  const items = Array.from(list.querySelectorAll<HTMLElement>("[data-tour-item]")).filter((el) => !el.hasAttribute("disabled"));
  if (!items.length) return false;
  const active = document.activeElement as HTMLElement | null;
  let i = items.findIndex((el) => el === active || el.contains(active));
  if (i < 0) {
    const checked = items.findIndex((el) => el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true");
    i = checked >= 0 ? checked : delta > 0 ? -1 : items.length;
    if (checked >= 0) {
      items[checked].focus();
      return true;
    }
  }
  const next = items[Math.max(0, Math.min(items.length - 1, i + delta))];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}

const PRIMARY_LABEL: Record<StepId, string> = {
  welcome: "Get Started",
  hotkey: "Continue",
  permissions: "Continue",
  ai: "Continue",
  look: "Continue",
  done: "Open Glide",
};

export function OnboardingWindow() {
  const [flow, dispatch] = useReducer(flowReducer, undefined, () => initialFlow());
  const [state, setState] = useState<OnboardingState | null>(null);
  const [ready, setReady] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<StepId>(flow.step);
  stepRef.current = flow.step;

  const refresh = useCallback(async () => {
    try {
      setState(await onboardingApi.getState());
    } catch {
      /* main not ready */
    }
  }, []);

  // Resume where the user left off (a finished tour replays from the start).
  useEffect(() => {
    void (async () => {
      const s = await onboardingApi.getState().catch(() => null);
      if (s) {
        setState(s);
        if (!s.settings.completed && !s.settings.skipped && s.settings.step !== "welcome") dispatch({ type: "goto", step: s.settings.step });
      }
      setReady(true);
    })();
    const offData = glide().onDataChanged(() => void refresh());
    const offEvt = glide().onFeatureEvent((e) => {
      if (e.feature === "onboarding" && e.event === "open") dispatch({ type: "restart" });
    });
    return () => {
      offData();
      offEvt();
    };
  }, [refresh]);

  // Persist progress on every step change.
  useEffect(() => {
    if (ready && flow.status === "active") void onboardingApi.setStep(flow.step).catch(() => undefined);
  }, [flow.step, flow.status, ready]);

  useEffect(() => {
    if (flow.status === "completed") void onboardingApi.finish(true);
    else if (flow.status === "skipped") void onboardingApi.skip();
  }, [flow.status]);

  // Focus the step's preferred control ([data-autofocus]) or the primary button.
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(() => {
      const root = bodyRef.current;
      const target = root?.querySelector<HTMLElement>("[data-autofocus]") ?? document.querySelector<HTMLElement>(".onboarding-foot__primary");
      target?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [flow.step, ready]);

  const next = useCallback(() => dispatch({ type: "next" }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const cmd = tourKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, target: targetKind(document.activeElement) });
      if (!cmd) return;
      if (cmd === "listNext" || cmd === "listPrev") {
        if (moveInList(bodyRef.current, cmd === "listNext" ? 1 : -1)) e.preventDefault();
        return;
      }
      e.preventDefault();
      if (cmd === "next") {
        // Options handle Enter themselves (choose + continue); the window only continues otherwise.
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset.enterHandled === "true" && e.key === "Enter" && !e.metaKey) return;
        dispatch({ type: "next" });
      } else if (cmd === "back") {
        dispatch({ type: "back" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const index = stepIndex(flow.step);
  const hotkey = state?.hotkey ?? "Alt+Space";

  return (
    <div className="onboarding" data-step={flow.step} aria-label="Welcome to Glide">
      <header className="onboarding-head">
        <div className="onboarding-head__drag" />
        <nav className="onboarding-progress" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`onboarding-progress__step ${i === index ? "is-current" : ""} ${i < index ? "is-done" : ""}`}
              aria-current={i === index ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${STEP_LABELS[s]}`}
              onClick={() => dispatch({ type: "goto", step: s })}
            >
              <span className="onboarding-progress__bar" />
              <span className="onboarding-progress__label">{STEP_LABELS[s]}</span>
            </button>
          ))}
        </nav>
        <button type="button" className="onboarding-skip" onClick={() => dispatch({ type: "skip" })} aria-label="Skip setup">
          Skip setup
        </button>
      </header>

      <main className="onboarding-body" ref={bodyRef} key={flow.step} role="region" aria-label={STEP_LABELS[flow.step]}>
        {flow.step === "welcome" && <StepWelcome />}
        {flow.step === "hotkey" && <StepHotkey state={state} onChanged={refresh} onContinue={next} />}
        {flow.step === "permissions" && <StepPermissions />}
        {flow.step === "ai" && <StepAi onContinue={next} />}
        {flow.step === "look" && <StepLook />}
        {flow.step === "done" && <StepDone hotkey={hotkey} />}
      </main>

      <footer className="onboarding-foot">
        <div className="onboarding-foot__hint">
          <span>
            <Kbd keys="⇥" /> move
          </span>
          {flow.step !== "welcome" && (
            <span>
              <Kbd keys="⌘[" /> back
            </span>
          )}
          <span>
            <Kbd keys="j" />
            <Kbd keys="k" /> lists
          </span>
        </div>
        <div className="onboarding-foot__actions">
          {index > 0 && (
            <button type="button" className="btn btn--ghost onboarding-foot__back" onClick={back}>
              Back
            </button>
          )}
          <button type="button" className="btn btn--primary onboarding-foot__primary" onClick={next}>
            {PRIMARY_LABEL[flow.step]} <Kbd keys="⏎" />
          </button>
        </div>
      </footer>
    </div>
  );
}
