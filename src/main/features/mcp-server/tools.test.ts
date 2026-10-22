import { describe, expect, it } from "vitest";
import { TOOLS as AGENT_TOOLS } from "../agent/tools";
import { defaultPolicy, gateFor, policyFor, cleanPatch, DEFAULT_SETTINGS } from "./policy";
import { MCP_TOOLS, toListEntry } from "./tools";

const REQUIRED = [
  "search_glide", "run_command", "list_workflows", "run_workflow", "window_action", "list_layouts", "restore_layout", "save_layout",
  "start_timer", "list_timers", "stop_timer", "clipboard_history_search", "create_note", "search_notes", "convert", "transform_text",
  "create_reminder", "list_reminders", "list_automations", "run_automation", "capture_text_from_image", "system_status", "search_bookmarks",
];

describe("MCP tool catalogue", () => {
  it("has every tool from the brief, once", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of REQUIRED) expect(names).toContain(n);
  });

  it("has valid, closed JSON object schemas", () => {
    for (const t of MCP_TOOLS) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties), `${t.name}.${r}`).toContain(r);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });

  it("wraps existing agent tools with matching mutability", () => {
    for (const t of MCP_TOOLS.filter((x) => x.agentTool)) {
      const a = AGENT_TOOLS.find((x) => x.name === t.agentTool);
      expect(a, t.name).toBeDefined();
      expect(a!.mutating, t.name).toBe(!t.readOnly);
      expect(t.inputSchema).toBe(a!.schema);
    }
  });

  it("annotates every tool for clients", () => {
    for (const t of MCP_TOOLS) {
      const e = toListEntry(t);
      expect(e.annotations.readOnlyHint).toBe(t.readOnly);
      expect(e.annotations.destructiveHint).toBe(t.readOnly ? false : t.destructive);
    }
    const byName = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, toListEntry(t)]));
    expect(byName.search_glide!.annotations.readOnlyHint).toBe(true);
    expect(byName.run_command!.annotations.destructiveHint).toBe(true);
    expect(byName.start_timer!.annotations.readOnlyHint).toBe(false);
  });
});

describe("permission policy", () => {
  const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;

  it("defaults: read-only on, state-changing and clipboard off", () => {
    for (const t of MCP_TOOLS) {
      const expected = t.readOnly && !t.sensitive ? "allow" : "off";
      expect(defaultPolicy(t), t.name).toBe(expected);
    }
    expect(defaultPolicy(tool("clipboard_history_search"))).toBe("off");
    expect(defaultPolicy(tool("start_timer"))).toBe("off");
    expect(defaultPolicy(tool("search_glide"))).toBe("allow");
  });

  it("never lets a state-changing tool run unasked from settings", () => {
    expect(policyFor(tool("start_timer"), { tools: { start_timer: "allow" } })).toBe("ask");
    expect(gateFor(tool("start_timer"), { tools: { start_timer: "ask" }, always: {} }, "Claude Code").kind).toBe("confirm");
    expect(gateFor(tool("start_timer"), { tools: { start_timer: "ask" }, always: { "Claude Code": ["start_timer"] } }, "Claude Code").kind).toBe("run");
    // An Always grant is per client.
    expect(gateFor(tool("start_timer"), { tools: { start_timer: "ask" }, always: { "Claude Code": ["start_timer"] } }, "Goose").kind).toBe("confirm");
    // Turning a tool off overrides Always.
    expect(gateFor(tool("start_timer"), { tools: { start_timer: "off" }, always: { "Claude Code": ["start_timer"] } }, "Claude Code").kind).toBe("deny");
  });

  it("sanitises settings patches", () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    const p = cleanPatch({ enabled: "yes", port: 80, tools: { start_timer: "ask", bogus: "allow", search_glide: "maybe" }, always: { X: ["start_timer", "nope"] }, confirmTimeoutSec: 1 }, names);
    expect(p).toEqual({ tools: { start_timer: "ask" }, always: { X: ["start_timer"] } });
    expect(cleanPatch({ enabled: true, port: 0 }, names)).toEqual({ enabled: true, port: 0 });
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });
});
