/**
 * Onboarding flow: the step list, persisted settings shape and the step state machine.
 * Pure (no Electron/DOM) so the renderer imports it too and vitest covers it.
 */

export const STEPS = ["welcome", "hotkey", "permissions", "ai", "look", "done"] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  welcome: "Welcome",
  hotkey: "Hotkey",
  permissions: "Permissions",
  ai: "AI",
  look: "Look & Feel",
  done: "Done",
};

/** Settings.features.onboarding */
export interface OnboardingSettings extends Record<string, unknown> {
  /** Finished the tour (Done step or "Open Glide"). */
  completed: boolean;
  /** Chose "Skip setup". */
  skipped: boolean;
  /** The window was opened at least once and not finished: resume on the next launch. */
  started: boolean;
  /** Last step shown (resume point). */
  step: StepId;
  /** Epoch ms of completion or skip (0 = never). */
  finishedAt: number;
}

export const ONBOARDING_DEFAULTS: OnboardingSettings = {
  completed: false,
  skipped: false,
  started: false,
  step: "welcome",
  finishedAt: 0,
};

export const isStep = (v: unknown): v is StepId => typeof v === "string" && (STEPS as readonly string[]).includes(v);

export function normalizeOnboarding(raw: unknown): OnboardingSettings {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    completed: r.completed === true,
    skipped: r.skipped === true,
    started: r.started === true,
    step: isStep(r.step) ? r.step : "welcome",
    finishedAt: typeof r.finishedAt === "number" && Number.isFinite(r.finishedAt) ? r.finishedAt : 0,
  };
}

export const stepIndex = (step: StepId): number => STEPS.indexOf(step);

export type FlowStatus = "active" | "completed" | "skipped";

export interface FlowState {
  step: StepId;
  status: FlowStatus;
}

export type FlowAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: StepId }
  | { type: "skip" }
  | { type: "finish" }
  | { type: "restart" };

export const initialFlow = (step: StepId = "welcome"): FlowState => ({ step, status: "active" });

/** next on the last step finishes; back on the first stays; once finished only restart reopens. */
export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  if (state.status !== "active" && action.type !== "restart") return state;
  const i = stepIndex(state.step);
  switch (action.type) {
    case "next":
      return i >= STEPS.length - 1 ? { ...state, status: "completed" } : { ...state, step: STEPS[i + 1] };
    case "back":
      return i <= 0 ? state : { ...state, step: STEPS[i - 1] };
    case "goto":
      return isStep(action.step) ? { ...state, step: action.step } : state;
    case "skip":
      return { ...state, status: "skipped" };
    case "finish":
      return { ...state, status: "completed" };
    case "restart":
      return initialFlow();
  }
}

/** Settings patch that persists a flow state. */
export function persistPatch(state: FlowState, now: number): Partial<OnboardingSettings> {
  if (state.status === "completed") return { completed: true, started: false, step: "done", finishedAt: now };
  if (state.status === "skipped") return { skipped: true, started: false, finishedAt: now };
  return { started: true, step: state.step };
}
