import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

import type { HelperMethods, HelperReminder, HelperReminderList, NativeHelper, PermissionStatus } from "../../native/helper";
import type { FeatureContext } from "../types";
import { buildRows, countDueToday, extractListTag, pickList, sectionOf } from "./model";
import { draftFromText, feature } from "./index";
import type { CreateReminderResult, RemindersState } from "./types";

const NOW = new Date(2026, 9, 21, 14, 30);
const rem = (o: Partial<HelperReminder>): HelperReminder => ({ id: o.title ?? "x", title: "x", completed: false, priority: 0, listId: "L1", listTitle: "Reminders", color: null, ...o });
const LISTS: HelperReminderList[] = [
  { id: "L1", title: "Reminders", color: "#0a84ff", isDefault: true, writable: true },
  { id: "L2", title: "Work Stuff", color: null, isDefault: false, writable: true },
  { id: "L3", title: "Shared", color: null, isDefault: false, writable: false },
];

describe("sections", () => {
  it("classifies overdue / today / upcoming / undated / completed", () => {
    expect(sectionOf(rem({ due: new Date(2026, 9, 21, 9).toISOString() }), NOW)).toBe("Overdue");
    expect(sectionOf(rem({ due: new Date(2026, 9, 21).toISOString(), dueAllDay: true }), NOW)).toBe("Today");
    expect(sectionOf(rem({ due: new Date(2026, 9, 20).toISOString(), dueAllDay: true }), NOW)).toBe("Overdue");
    expect(sectionOf(rem({ due: new Date(2026, 9, 21, 18).toISOString() }), NOW)).toBe("Today");
    expect(sectionOf(rem({ due: new Date(2026, 9, 25).toISOString(), dueAllDay: true }), NOW)).toBe("Upcoming");
    expect(sectionOf(rem({}), NOW)).toBe("No Due Date");
    expect(sectionOf(rem({ completed: true, due: new Date(2020, 0, 1).toISOString() }), NOW)).toBe("Completed");
  });

  it("orders by section, due date, then priority, and filters by query", () => {
    const rows = buildRows(
      [
        rem({ title: "later", due: new Date(2026, 9, 30).toISOString(), dueAllDay: true }),
        rem({ title: "none-low", priority: 9 }),
        rem({ title: "none-high", priority: 1 }),
        rem({ title: "late", due: new Date(2026, 9, 1).toISOString(), dueAllDay: true }),
        rem({ title: "today", due: new Date(2026, 9, 21, 17).toISOString() }),
        rem({ title: "done", completed: true, completionDate: NOW.toISOString() }),
      ],
      NOW,
    );
    expect(rows.map((r) => `${r.section}:${r.title}`)).toEqual(["Overdue:late", "Today:today", "Upcoming:later", "No Due Date:none-high", "No Due Date:none-low", "Completed:done"]);
    expect(buildRows([rem({ title: "Buy milk" }), rem({ title: "Call", notes: "about milk" }), rem({ title: "Other" })], NOW, "milk").map((r) => r.title)).toEqual(["Buy milk", "Call"]);
    expect(countDueToday([rem({ due: new Date(2026, 9, 1).toISOString() }), rem({ due: new Date(2026, 9, 21, 20).toISOString() })], NOW)).toEqual({ overdue: 1, today: 1 });
  });

  it("lists and #tags", () => {
    expect(pickList(LISTS, "L2")?.id).toBe("L2");
    expect(pickList(LISTS, "L3")?.id).toBe("L1"); // read-only list falls back to the default
    expect(pickList(LISTS)?.id).toBe("L1");
    expect(extractListTag("send report #work tomorrow", LISTS)).toEqual({ text: "send report tomorrow", listId: "L2" });
    expect(extractListTag("send report #nope", LISTS)).toEqual({ text: "send report #nope" });
    const d = draftFromText("Ship it #workstuff friday 5pm", LISTS, NOW);
    expect(d).toMatchObject({ title: "Ship it", allDay: false, listId: "L2", phrase: "friday 5pm" });
    expect(new Date(d.due!).getTime()).toBe(new Date(2026, 9, 23, 17).getTime());
  });
});

// --- feature wiring with a fake helper -------------------------------------------------------

type Calls = Array<{ method: string; params: unknown }>;
function fakeCtx(perms: Partial<PermissionStatus>, handlers: Partial<Record<keyof HelperMethods, (p: unknown) => unknown>>, calls: Calls): FeatureContext {
  const helper: NativeHelper = {
    available: () => true,
    call: ((method: keyof HelperMethods, params?: unknown) => {
      calls.push({ method, params });
      if (method === "permissions.status") return Promise.resolve({ accessibility: false, inputMonitoring: false, calendar: "notDetermined", ...perms });
      const h = handlers[method];
      return h ? Promise.resolve().then(() => h(params)) : Promise.reject(new Error(`helper method ${method} is disabled in headless mode`));
    }) as NativeHelper["call"],
    on: () => () => undefined,
    dispose: () => undefined,
  };
  const store: Record<string, unknown> = {};
  return {
    id: "reminders",
    helper,
    settings: <T extends Record<string, unknown>>(d: T) => ({ ...d, ...store }) as T,
    setSettings: (p: Record<string, unknown>) => Object.assign(store, p),
    refreshCatalogue: () => undefined,
    log: () => undefined,
  } as unknown as FeatureContext;
}

describe("reminders feature", () => {
  let calls: Calls;
  beforeEach(() => {
    calls = [];
  });

  it("never touches reminders without access, and shows the grant screen", async () => {
    feature.start?.(fakeCtx({ reminders: "notDetermined" }, {}, calls));
    const s = (await feature.methods!.state!()) as RemindersState;
    expect(s.status).toBe("notDetermined");
    const r = (await feature.methods!.create!({ title: "x" })) as CreateReminderResult;
    expect(r).toMatchObject({ ok: false, status: "notDetermined" });
    expect(calls.every((c) => c.method === "permissions.status")).toBe(true);
  });

  it("reports the graceful 'unavailable' state when the helper refuses (headless)", async () => {
    feature.start?.(fakeCtx({ reminders: "authorized" }, {}, calls));
    const s = (await feature.methods!.state!()) as RemindersState;
    expect(s.status).toBe("unavailable");
    expect(s.message).toMatch(/not available/);
  });

  it("treats an old helper (no reminders status) as unavailable", async () => {
    feature.start?.(fakeCtx({}, {}, calls));
    expect(((await feature.methods!.state!()) as RemindersState).status).toBe("unavailable");
  });

  it("creates with ISO due + allDay and the chosen list", async () => {
    const created: unknown[] = [];
    feature.start?.(
      fakeCtx(
        { reminders: "authorized" },
        {
          "reminders.lists": () => LISTS,
          "reminders.list": () => [],
          "reminders.create": (p) => (created.push(p), rem({ title: (p as { title: string }).title })),
        },
        calls,
      ),
    );
    await feature.methods!.state!(); // fills the list cache
    const due = new Date(2026, 9, 22).toISOString();
    const r = (await feature.methods!.create!({ title: " Pay rent ", due, allDay: true, listId: "L2" })) as CreateReminderResult;
    expect(r.ok).toBe(true);
    expect(created[0]).toEqual({ title: "Pay rent", due, allDay: true, listId: "L2" });
    await feature.methods!.create!({ title: "No date", listId: "missing" });
    expect(created[1]).toEqual({ title: "No date" });
  });

  it("offers a dynamic Create Reminder item for 'remind …' queries", () => {
    const items = feature.dynamicItems?.("remind call mom tomorrow 9am") as Array<{ item: { title: string; subtitle?: string; data?: Record<string, unknown> } }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.item.title).toBe("Create Reminder “call mom”");
    expect(items[0]!.item.subtitle).toMatch(/^Due Tomorrow, 9:00 AM|^Due /);
    expect(feature.dynamicItems?.("reminders")).toEqual([]);
  });
});
