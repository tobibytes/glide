import { describe, expect, it } from "vitest";
import { flowReducer, initialFlow, normalizeOnboarding, persistPatch, STEPS, type FlowState } from "./steps";

describe("onboarding flow", () => {
  it("walks every step in order and completes after the last", () => {
    let s: FlowState = initialFlow();
    const seen = [s.step];
    for (let i = 0; i < STEPS.length - 1; i++) {
      s = flowReducer(s, { type: "next" });
      seen.push(s.step);
    }
    expect(seen).toEqual([...STEPS]);
    expect(s.status).toBe("active");
    s = flowReducer(s, { type: "next" });
    expect(s).toEqual({ step: "done", status: "completed" });
  });

  it("back stops at the first step", () => {
    const s = flowReducer(initialFlow(), { type: "back" });
    expect(s.step).toBe("welcome");
    expect(flowReducer(initialFlow("ai"), { type: "back" }).step).toBe("permissions");
  });

  it("goto jumps; unknown steps are ignored", () => {
    expect(flowReducer(initialFlow(), { type: "goto", step: "look" }).step).toBe("look");
    expect(flowReducer(initialFlow("ai"), { type: "goto", step: "nope" as never }).step).toBe("ai");
  });

  it("skip and finish are terminal until restart", () => {
    const skipped = flowReducer(initialFlow("hotkey"), { type: "skip" });
    expect(skipped.status).toBe("skipped");
    expect(flowReducer(skipped, { type: "next" })).toBe(skipped);
    expect(flowReducer(skipped, { type: "back" })).toBe(skipped);
    const done = flowReducer(initialFlow("ai"), { type: "finish" });
    expect(done.status).toBe("completed");
    expect(flowReducer(done, { type: "restart" })).toEqual(initialFlow());
  });

  it("persists progress, completion and skip", () => {
    expect(persistPatch({ step: "ai", status: "active" }, 5)).toEqual({ started: true, step: "ai" });
    expect(persistPatch({ step: "done", status: "completed" }, 5)).toEqual({ completed: true, started: false, step: "done", finishedAt: 5 });
    expect(persistPatch({ step: "hotkey", status: "skipped" }, 7)).toEqual({ skipped: true, started: false, finishedAt: 7 });
  });

  it("normalizes stored settings", () => {
    expect(normalizeOnboarding(undefined)).toEqual({ completed: false, skipped: false, started: false, step: "welcome", finishedAt: 0 });
    expect(normalizeOnboarding({ completed: "yes", step: "bogus", started: true, finishedAt: Number.NaN })).toEqual({
      completed: false,
      skipped: false,
      started: true,
      step: "welcome",
      finishedAt: 0,
    });
    expect(normalizeOnboarding({ step: "look", completed: true }).step).toBe("look");
  });
});
