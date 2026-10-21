import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  clipboard: { readText: async () => "", writeText: async () => undefined },
  Notification: class {
    static isSupported = () => false;
  },
  shell: { openExternal: async () => undefined, openPath: async () => "" },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
}));

import type { Workflow, WorkflowAction } from "@shared/types";
import { specForAction, specKey } from "@shared/workflow-specs";
import { TRANSFORMS } from "../features/transforms/transforms";
import { builtinFeatureActions, pickByName, transformActions } from "./builtin-actions";
import { allActionSpecs, clearFeatureActions, featureActionSpecs, hasFeatureAction, registerFeatureAction, runFeatureAction } from "./feature-actions";
import { migrateAction, migrateWorkflow } from "./migrate";
import { createWorkflowRuntime } from "./runtime";
import { ACTION_SPECS } from "./specs";

const runtime = () =>
  createWorkflowRuntime({ getWorkflow: () => undefined, askInput: async () => null, showResult: () => undefined, hideLauncher: () => undefined });
const wf = (actions: WorkflowAction[]): Workflow => ({ id: "w", name: "W", icon: { kind: "emoji", value: "🧩" }, actions, createdAt: 0, updatedAt: 0 });
const registerTransforms = () => {
  for (const b of transformActions()) registerFeatureAction(b.feature, b.def, {} as never);
};

afterEach(() => clearFeatureActions());

describe("feature workflow action registry", () => {
  it("registers specs of type feature with hidden feature/action params", () => {
    const off = registerFeatureAction("demo", { id: "hello", title: "Say Hello", params: [{ key: "name", label: "Name", kind: "text" }], run: (_c, p) => `hi ${p.name}` }, {});
    const [spec] = featureActionSpecs();
    expect(spec).toMatchObject({ type: "feature", feature: "demo", action: "hello", title: "Say Hello" });
    expect(spec.params.slice(0, 2)).toEqual([
      { key: "feature", label: "Feature", kind: "hidden", default: "demo" },
      { key: "action", label: "Action", kind: "hidden", default: "hello" },
    ]);
    expect(specKey(spec)).toBe("feature:demo.hello");
    expect(allActionSpecs().slice(0, ACTION_SPECS.length)).toEqual(ACTION_SPECS);
    expect(specForAction(allActionSpecs(), { type: "feature", params: { feature: "demo", action: "hello" } })?.title).toBe("Say Hello");
    off();
    expect(hasFeatureAction("demo", "hello")).toBe(false);
  });

  it("runs with the bound context, strips feature/action and fills defaults", async () => {
    const ctx = { tag: "ctx" };
    const seen: unknown[] = [];
    registerFeatureAction("demo", { id: "echo", title: "Echo", params: [{ key: "x", label: "X", kind: "text", default: "dflt" }], run: (c, p, v) => (seen.push(c, p, v.input), { result: p.x, vars: { extra: "1" } }) }, ctx);
    const out = await runFeatureAction({ feature: "demo", action: "echo" }, { input: "in" });
    expect(out).toEqual({ result: "dflt", vars: { extra: "1" }, outputVar: undefined });
    expect(seen).toEqual([ctx, { x: "dflt" }, "in"]);
    await expect(runFeatureAction({ feature: "nope", action: "x" }, {})).rejects.toThrow(/not available/);
  });

  it("ships an action for every text transform plus timers/layouts/ocr/automations/convert", () => {
    const all = builtinFeatureActions();
    expect(all.filter((a) => a.feature === "transforms")).toHaveLength(TRANSFORMS.length);
    expect(TRANSFORMS.length).toBeGreaterThanOrEqual(33);
    for (const key of ["timers.start", "layouts.restore", "ocr.captureText", "automations.runNow", "convert.convert"]) expect(all.some((a) => `${a.feature}.${a.def.id}` === key)).toBe(true);
  });

  it("capture text refuses interactive capture in tests", async () => {
    const cap = builtinFeatureActions().find((a) => a.def.id === "captureText")!;
    registerFeatureAction(cap.feature, cap.def, {} as never);
    await expect(runFeatureAction({ feature: "ocr", action: "captureText", source: "screen" }, {})).rejects.toThrow(/disabled in headless/);
  });

  it("start timer parses the duration and calls the timers feature", async () => {
    const timer = builtinFeatureActions().find((a) => a.feature === "timers")!;
    const calls: unknown[][] = [];
    const ctx = { callFeature: async (...args: unknown[]) => (calls.push(args), { ok: true, message: "Tea started — 5:00" }) };
    registerFeatureAction(timer.feature, timer.def, ctx as never);
    expect((await runFeatureAction({ feature: "timers", action: "start", duration: "5m", name: "Tea" }, {})).result).toBe("Tea started — 5:00");
    expect(calls).toEqual([["timers", "start", 300_000, "Tea"]]);
    await expect(runFeatureAction({ feature: "timers", action: "start", duration: "soon" }, {})).rejects.toThrow(/Not a duration/);
  });

  it("pickByName matches id, exact name, or a unique prefix", () => {
    const list = [{ id: "a1", name: "Coding" }, { id: "a2", name: "Code Review" }, { id: "a3", name: "Writing" }];
    expect(pickByName(list, "a3")?.name).toBe("Writing");
    expect(pickByName(list, "coding")?.id).toBe("a1");
    expect(pickByName(list, "writ")?.id).toBe("a3");
    expect(pickByName(list, "cod")).toBeUndefined();
  });
});

describe("runtime + feature actions", () => {
  it("runs a workflow with transform actions and threads {{result}}", async () => {
    registerTransforms();
    const res = await runtime().run(
      wf([
        { id: "1", type: "setVariable", params: { name: "t", value: "hello glide world" } },
        { id: "2", type: "feature", params: { feature: "transforms", action: "snake", text: "{{t}}" } },
        { id: "3", type: "feature", params: { feature: "transforms", action: "upper", text: "{{result}}" } },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.result).toBe("HELLO_GLIDE_WORLD");
    expect(res.log.map((l) => `${l.type}:${l.status}`)).toEqual(["setVariable:ok", "feature:ok", "feature:ok"]);
  });

  it("a missing feature action fails the step (and honours continueOnError)", async () => {
    const res = await runtime().run(wf([{ id: "1", type: "feature", params: { feature: "ghost", action: "boo" } }]));
    expect(res.ok).toBe(false);
    expect(res.log[0].error).toMatch(/not available/);
    const cont = await runtime().run(wf([{ id: "1", type: "feature", params: { feature: "ghost", action: "boo", continueOnError: "true" } }, { id: "2", type: "setVariable", params: { name: "after", value: "yes" } }]));
    expect(cont.variables.after).toBe("yes");
  });

  it("transform errors surface as step errors", async () => {
    registerTransforms();
    const res = await runtime().run(wf([{ id: "1", type: "feature", params: { feature: "transforms", action: "json-pretty", text: "{nope" } }]));
    expect(res.ok).toBe(false);
    expect(res.log[0].status).toBe("error");
  });
});

describe("migration", () => {
  const legacy: Workflow = wf([
    { id: "a", type: "openUrl", params: { url: "https://example.com/{{input}}" } },
    { id: "b", type: "runShell", params: { command: "echo hi", continueOnError: "true" } },
    { id: "c", type: "condition", params: { left: "{{input}}", operator: "isEmpty", right: "" }, then: [{ id: "d", type: "notify", params: { title: "x" } }], else: [{ id: "e", type: "setVariable", params: { name: "n", value: "v" } }] },
    { id: "f", type: "showResult", params: { text: "{{result}}" }, disabled: true, label: "Show" },
  ]);

  it("old workflows pass through unchanged (same references)", () => {
    const snapshot = JSON.stringify(legacy);
    expect(migrateWorkflow(legacy)).toBe(legacy);
    expect(JSON.stringify(legacy)).toBe(snapshot);
    for (const a of legacy.actions) expect(migrateAction(a)).toBe(a);
  });

  it("old workflows still run the same", async () => {
    const res = await runtime().run(wf([{ id: "1", type: "setVariable", params: { name: "g", value: "Hi {{input}}" } }, legacy.actions[2]]), "");
    expect(res.variables.g).toBe("Hi ");
    expect(res.log.map((l) => l.type)).toEqual(["setVariable", "notify", "condition"]); // branch steps log before their condition
  });

  it("normalises object and compact feature forms, also inside branches", () => {
    const obj = { id: "x", type: "feature", feature: "transforms", action: "upper", params: { text: "a" } } as unknown as WorkflowAction;
    expect(migrateAction(obj)).toEqual({ id: "x", type: "feature", params: { text: "a", feature: "transforms", action: "upper" } });
    const compact = { id: "y", type: "feature:transforms.lower", params: { text: "B" } } as unknown as WorkflowAction;
    expect(migrateAction(compact)).toEqual({ id: "y", type: "feature", params: { text: "B", feature: "transforms", action: "lower" } });
    const nested = wf([{ id: "c", type: "condition", params: {}, then: [compact], else: [] }]);
    const m = migrateWorkflow(nested);
    expect(m).not.toBe(nested);
    expect(m.actions[0].then?.[0].type).toBe("feature");
  });

  it("migrated compact actions run", async () => {
    registerTransforms();
    const res = await runtime().run(wf([{ id: "y", type: "feature:transforms.kebab" as never, params: { text: "Hello World" } }]));
    expect(res.result).toBe("hello-world");
  });
});
