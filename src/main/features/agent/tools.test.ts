import { describe, expect, it } from "vitest";
import { formatDuration, toolByName, TOOLS, type AgentCapabilities, type PreparedCall } from "./tools";

const caps = {
  now: () => new Date("2026-10-21T09:30:00").getTime(),
  findItem: async (id: string) => (id === "app:/Applications/Safari.app" ? { id, title: "Safari", kind: "app" } : undefined),
  listWorkflows: () => [{ id: "wf1", name: "Standup" }],
  searchNotes: async () => [{ id: "n1", title: "Standup notes" }],
  calendarEvents: async (from: string, to: string) => ({ ok: true, events: [{ title: `${from}|${to}`, start: from, end: to, allDay: false }] }),
} as unknown as AgentCapabilities;

function prep(name: string, input: unknown): PreparedCall | { error: string } {
  const tool = toolByName(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.prepare(input, caps);
}
const ok = (p: PreparedCall | { error: string }): PreparedCall => {
  if ("error" in p) throw new Error(p.error);
  return p;
};

describe("agent tools", () => {
  it("have unique names, object schemas and the right read-only/mutating split", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) expect(t.schema.type).toBe("object");
    const readOnly = TOOLS.filter((t) => !t.mutating).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      "clipboard_history_search", "convert", "get_calendar_events", "get_clipboard", "get_selected_text", "list_automations", "list_layouts", "list_processes",
      "list_workflows", "plan", "search_bookmarks", "search_catalogue", "search_notes", "system_status", "transform_text",
    ]);
    expect(TOOLS.filter((t) => t.alwaysConfirm).map((t) => t.name).sort()).toEqual(["kill_process", "run_shortcut"]);
    expect(TOOLS.filter((t) => t.destructive).map((t) => t.name).sort()).toEqual(["kill_process", "run_automation", "run_shortcut"]);
  });

  it("describe exactly what will happen", async () => {
    expect(await ok(prep("execute_item", { id: "app:/Applications/Safari.app" })).describe()).toBe("Run “Safari”");
    expect(await ok(prep("run_workflow", { id: "wf1", input: "hi" })).describe()).toBe("Run workflow “Standup” with input “hi”");
    expect(await ok(prep("start_timer", { minutes: 1.5 })).describe()).toBe("Start a 1 min 30 s timer");
    expect(await ok(prep("open_note", { id: "n1" })).describe()).toBe("Open the note “Standup notes”");
    expect(await ok(prep("window_action", { action: "maximize" })).describe()).toBe("Move the front window to Maximize");
    expect(await ok(prep("get_calendar_events", { days_ahead: 1 })).describe()).toBe("Read calendar events for today and the next 1 days");
  });

  it("validate inputs", () => {
    expect(prep("start_timer", {})).toHaveProperty("error");
    expect(prep("start_timer", { minutes: 60 * 25 })).toHaveProperty("error");
    expect(prep("open_url", { url: "javascript:alert(1)" })).toHaveProperty("error");
    expect(prep("open_file", { path: "relative/file" })).toHaveProperty("error");
    expect(prep("execute_item", { id: "agent:ask" })).toHaveProperty("error");
    expect(prep("search_catalogue", { query: 5 })).toHaveProperty("error");
    expect(prep("search_catalogue", "nope")).toHaveProperty("error");
    expect(prep("open_url", { url: "https://example.com/a b" })).not.toHaveProperty("error");
  });

  it("refuses to execute an item that isn't in the catalogue", async () => {
    await expect(ok(prep("execute_item", { id: "app:/nope" })).run()).rejects.toThrow(/No item/);
  });

  it("reads calendar events from the start of today", async () => {
    const out = (await ok(prep("get_calendar_events", { days_ahead: 0 })).run()).text;
    const [from, to] = (JSON.parse(out) as Array<{ title: string }>)[0].title.split("|");
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 3_600_000);
  });

  it("formats durations", () => {
    expect(formatDuration(25 * 60_000)).toBe("25 min");
    expect(formatDuration(3_600_000 + 5000)).toBe("1 h 5 s");
  });
});
