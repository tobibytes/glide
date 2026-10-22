import { describe, expect, it } from "vitest";
import { createConfirmations } from "./confirm";
import { createRateLimiter } from "./ratelimit";
import { harness, until } from "./test-kit";

const C = "Claude Code";

describe("call pipeline", () => {
  it("runs read-only tools without asking and logs them", async () => {
    const h = harness();
    const r = await h.handler.call(C, "search_glide", { query: "timer" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe("ran search_glide");
    expect(h.requests).toHaveLength(0);
    expect(h.log.list()[0]).toMatchObject({ client: C, tool: "search_glide", outcome: "ok", approval: "auto" });
  });

  it("refuses tools that are off and hides them from tools/list", async () => {
    const h = harness();
    const r = await h.handler.call(C, "start_timer", { minutes: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/turned off/);
    expect(h.backend.calls).toHaveLength(0);
    const visible = h.handler.visibleTools(C).map((t) => t.name);
    expect(visible).toContain("search_glide");
    expect(visible).not.toContain("start_timer");
    expect(visible).not.toContain("clipboard_history_search");
    expect(h.log.list()[0]!.outcome).toBe("off");
  });

  it("asks before state-changing calls: allow, deny, always", async () => {
    const h = harness({ tools: { start_timer: "ask" } });
    const p1 = h.handler.call(C, "start_timer", { minutes: 1 });
    const req = await until(() => h.requests[0]);
    expect(req).toMatchObject({ client: C, tool: "start_timer" });
    expect(h.backend.calls).toHaveLength(0);
    h.confirm.respond(req.id, "allow");
    expect((await p1).content[0]!.text).toBe("ran start_timer");

    const p2 = h.handler.call(C, "start_timer", { minutes: 2 });
    h.confirm.respond((await until(() => h.requests[1])).id, "deny");
    const r2 = await p2;
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toMatch(/denied/);
    expect(h.backend.calls).toHaveLength(1);

    const p3 = h.handler.call(C, "start_timer", { minutes: 3 });
    h.confirm.respond((await until(() => h.requests[2])).id, "always");
    await p3;
    expect(h.settings().always[C]).toEqual(["start_timer"]);
    await h.handler.call(C, "start_timer", { minutes: 4 });
    expect(h.requests).toHaveLength(3); // no fourth prompt
    expect(h.backend.calls).toHaveLength(3);
    expect(h.log.list().map((e) => e.approval ?? e.outcome)).toEqual(["always", "always", "denied", "user"]);
  });

  it("denies when nobody answers in time", async () => {
    const h = harness({ tools: { run_command: "ask" } }, { timeoutMs: 1000 });
    const t0 = Date.now();
    const r = await h.handler.call(C, "run_command", { id: "x" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/timed out/);
    expect(h.log.list()[0]!.outcome).toBe("timeout");
    expect(h.backend.calls).toHaveLength(0);
  });

  it("validates arguments before asking", async () => {
    const h = harness();
    const r = await h.handler.call(C, "search_glide", {});
    expect(r).toMatchObject({ isError: true });
    expect(h.log.list()[0]!.outcome).toBe("invalid");
    expect((await h.handler.call(C, "nope", {})).isError).toBe(true);
  });

  it("rate limits per client", async () => {
    const h = harness({ rateLimitPerMin: 3 });
    for (let i = 0; i < 3; i++) expect((await h.handler.call(C, "convert", { query: "1 km in m" })).isError).toBeUndefined();
    const r = await h.handler.call(C, "convert", { query: "1 km in m" });
    expect(r.content[0]!.text).toMatch(/rate limit/);
    expect((await h.handler.call("Goose", "convert", { query: "1 km in m" })).isError).toBeUndefined();
  });

  it("limits state-changing calls separately", async () => {
    const h = harness({ tools: { create_note: "ask" }, always: { [C]: ["create_note"] }, mutatingPerMin: 2 });
    await h.handler.call(C, "create_note", { text: "a" });
    await h.handler.call(C, "create_note", { text: "b" });
    expect((await h.handler.call(C, "create_note", { text: "c" })).content[0]!.text).toMatch(/rate limit/);
    expect((await h.handler.call(C, "search_notes", { query: "" })).isError).toBeUndefined();
  });

  it("applies tool defaults and keeps private arguments out of the log", async () => {
    const h = harness({ always: { [C]: ["create_note"] }, tools: { create_note: "ask" } });
    await h.handler.call(C, "create_note", { text: "my secret diary" });
    expect(h.backend.calls[0]!.args).toEqual({ open: false, text: "my secret diary" });
    expect(JSON.stringify(h.log.list())).not.toContain("diary");
    await h.handler.call(C, "transform_text", { transform: "upper", text: "hunter2" });
    expect(JSON.stringify(h.log.list())).not.toContain("hunter2");
  });

  it("reports tool failures as isError results", async () => {
    const h = harness();
    const r = await h.handler.call(C, "convert", { query: "x", fail: true });
    expect(r).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(h.log.list()[0]).toMatchObject({ outcome: "error", error: "boom" });
  });

  it("gates resources on the matching tool", async () => {
    const h = harness();
    expect((await h.resources.list(C)).map((r) => r.uri)).toEqual(["glide://notes/n1"]);
    expect((await h.resources.read("glide://notes/n1", C)).text).toContain("milk");
    await expect(h.resources.read("glide://clipboard/recent", C)).rejects.toThrow(/turned off/);
    h.set({ tools: { clipboard_history_search: "allow" } });
    expect((await h.resources.list(C)).map((r) => r.uri)).toContain("glide://clipboard/recent");
  });
});

describe("confirmations and limiter", () => {
  it("caps pending requests and denies everything on stop", async () => {
    const c = createConfirmations({ timeoutMs: () => 10_000, onChange: () => undefined, maxPending: 2 });
    const a = c.request({ client: "x", tool: "t", toolTitle: "T", summary: "s" });
    const b = c.request({ client: "x", tool: "t", toolTitle: "T", summary: "s" });
    expect(await c.request({ client: "x", tool: "t", toolTitle: "T", summary: "s" })).toBe("deny");
    expect(c.pending()).toHaveLength(2);
    expect(c.respond("nope", "allow")).toBe(false);
    c.denyAll();
    expect(await a).toBe("deny");
    expect(await b).toBe("deny");
  });

  it("slides its window", () => {
    let now = 0;
    const l = createRateLimiter(() => now);
    expect(l.take("k", 1)).toBe(true);
    expect(l.take("k", 1)).toBe(false);
    now = 60_001;
    expect(l.take("k", 1)).toBe(true);
  });
});
