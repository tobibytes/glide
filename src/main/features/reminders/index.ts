/**
 * Reminders (EventKit via the helper): "Create Reminder <text>" with natural-language due dates
 * (./due.ts) and a Reminders view (lists, overdue/today/upcoming sections, ⏎ completes, ⌘N new).
 * Access is requested only from the view's "Grant Access" row; until then every helper call is skipped.
 */
import { shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { HelperReminder, HelperReminderList } from "../../native/helper";
import type { FeatureContext, FeatureModule } from "../types";
import { parseReminderText, previewDue } from "./due";
import { countDueToday, extractListTag, pickList } from "./model";
import type { CreateReminderResult, ReminderDraft, RemindersState, RemindersStatus } from "./types";

const ID = "reminders";
const DEFAULTS = { defaultListId: "", showCompleted: false };
type RemindersSettings = typeof DEFAULTS;

let ctx: FeatureContext | undefined;
let listsCache: HelperReminderList[] = [];
let lastCounts = { overdue: 0, today: 0 };

const settings = (): RemindersSettings => ctx?.settings(DEFAULTS) ?? DEFAULTS;

/** Access state without ever prompting. */
async function access(): Promise<{ status: RemindersStatus; message?: string }> {
  if (!ctx?.helper.available()) return { status: "no-helper", message: "Reminders need the Glide helper, which isn’t running. Rebuild or reinstall Glide to enable them." };
  try {
    const perms = await ctx.helper.call("permissions.status");
    if (!perms.reminders) return { status: "unavailable", message: "This Glide helper is too old for Reminders. Rebuild it with “pnpm build:helper”." };
    if (perms.reminders === "authorized") return { status: "ok" };
    return { status: perms.reminders, message: perms.reminders === "notDetermined" ? "Glide needs permission to read and create your reminders." : "Reminders access is turned off for Glide." };
  } catch (err) {
    return { status: "error", message: errText(err) };
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Helper calls refused in headless test runs, or by an old helper, surface as "unavailable". */
function failure(err: unknown): { status: RemindersStatus; message: string } {
  const message = errText(err);
  if (/disabled in headless mode|Unknown method/.test(message)) return { status: "unavailable", message: `Reminders are not available here (${message}).` };
  if (/not been granted/.test(message)) return { status: "notDetermined", message };
  return { status: "error", message };
}

async function loadState(): Promise<RemindersState> {
  const a = await access();
  if (a.status !== "ok" || !ctx) return { status: a.status, message: a.message, lists: [], reminders: [] };
  try {
    const s = settings();
    const [lists, reminders] = await Promise.all([ctx.helper.call("reminders.lists"), ctx.helper.call("reminders.list", { includeCompleted: s.showCompleted })]);
    listsCache = lists;
    lastCounts = countDueToday(reminders, new Date());
    return { status: "ok", lists, reminders, defaultListId: pickList(lists, s.defaultListId || undefined)?.id };
  } catch (err) {
    return { ...failure(err), lists: [], reminders: [] };
  }
}

export function draftFromText(text: string, lists: HelperReminderList[], now = new Date()): ReminderDraft {
  const tagged = extractListTag(text, lists);
  const p = parseReminderText(tagged.text, now);
  return { title: p.title, due: p.due?.toISOString(), allDay: p.allDay, listId: tagged.listId, phrase: p.phrase };
}

async function create(draft: Partial<ReminderDraft>): Promise<CreateReminderResult> {
  const title = (draft.title ?? "").trim();
  if (!title) return { ok: false, error: "Type a title for the reminder" };
  const a = await access();
  if (a.status !== "ok" || !ctx) return { ok: false, status: a.status, error: a.message };
  try {
    const listId = draft.listId || settings().defaultListId || undefined;
    const reminder = await ctx.helper.call("reminders.create", {
      title,
      ...(draft.due ? { due: draft.due, allDay: !!draft.allDay } : {}),
      ...(listId && listsCache.some((l) => l.id === listId) ? { listId } : {}),
      ...(draft.notes ? { notes: draft.notes } : {}),
    });
    return { ok: true, reminder };
  } catch (err) {
    const f = failure(err);
    return { ok: false, status: f.status, error: f.message };
  }
}

const CREATE_RE = /^(?:create\s+reminder|new\s+reminder|add\s+reminder|reminder|remind\s+me(?:\s+to)?|remind)\s+(.+)$/i;

function createItem(text: string): ScoredItem {
  const d = draftFromText(text, listsCache);
  const list = d.listId ? listsCache.find((l) => l.id === d.listId)?.title : undefined;
  const due = previewDue({ title: d.title, due: d.due ? new Date(d.due) : undefined, allDay: d.allDay });
  const item: SearchItem = {
    id: "reminders:create-from-query",
    kind: "command",
    kindLabel: "Reminders",
    title: `Create Reminder “${d.title}”`,
    subtitle: [due, list].filter(Boolean).join(" · "),
    icon: { kind: "emoji", value: "🔔" },
    keywords: ["reminder", "remind", "todo"],
    feature: ID,
    data: { action: "createDraft", draft: { ...d }, noUsage: true },
  };
  return { item, score: 2_000, matchScore: 2_000, matchKind: "keyword", frecency: 0, ranges: [] };
}

function badge(): string {
  const { overdue, today } = lastCounts;
  if (!overdue && !today) return "Overdue, today and upcoming";
  return [overdue ? `${overdue} overdue` : "", today ? `${today} due today` : ""].filter(Boolean).join(" · ");
}

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    // Only refresh counts when access already exists; never prompts.
    void access().then((a) => (a.status === "ok" ? loadState().then(() => c.refreshCatalogue()) : undefined));
  },
  items: (): SearchItem[] => [
    {
      id: "reminders:view",
      kind: "command",
      kindLabel: "Reminders",
      title: "My Reminders",
      subtitle: badge(),
      icon: { kind: "emoji", value: "☑️" },
      keywords: ["reminders", "todo", "tasks", "due", "overdue"],
      feature: ID,
      data: { action: "view" },
    },
    {
      id: "reminders:create",
      kind: "command",
      kindLabel: "Reminders",
      title: "Create Reminder",
      subtitle: "Type “remind <text> tomorrow 9am” in the search field, or open the form",
      icon: { kind: "emoji", value: "🔔" },
      keywords: ["new reminder", "add reminder", "remind me", "todo"],
      feature: ID,
      data: { action: "new" },
    },
  ],
  dynamicItems(query): ScoredItem[] {
    const m = CREATE_RE.exec(query.trim());
    if (!m || m[1]!.trim().length < 2) return [];
    return [createItem(m[1]!.trim())];
  },
  actions(item): ItemAction[] {
    const a = item.data?.action;
    if (a === "createDraft")
      return [
        { id: "create", title: "Create Reminder", shortcut: "⏎", icon: "🔔" },
        { id: "edit", title: "Edit Before Creating", shortcut: "⌘⏎", icon: "✏️" },
      ];
    if (a === "new") return [{ id: "new", title: "New Reminder", shortcut: "⏎" }];
    return [{ id: "view", title: "Show Reminders", shortcut: "⏎" }];
  },
  async runAction(scored, actionId): Promise<ExecuteResult> {
    const d = (scored.item.data?.draft ?? {}) as Partial<ReminderDraft>;
    if (actionId === "view") return { ok: true, view: { id: "reminders.list" } };
    if (actionId === "new") return { ok: true, view: { id: "reminders.create" } };
    if (actionId === "edit") return { ok: true, view: { id: "reminders.create", props: { draft: d } } };
    if (actionId === "create") {
      const r = await create(d);
      if (r.ok) return { ok: true, hide: true, message: `Reminder created: ${r.reminder?.title ?? d.title}` };
      // Needs access (or failed): open the form, which shows the permission screen and keeps the draft.
      if (r.status && r.status !== "error") return { ok: true, view: { id: "reminders.create", props: { draft: d } } };
      return { ok: false, error: r.error };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => loadState(),
    parse: (text: unknown) => draftFromText(typeof text === "string" ? text : "", listsCache),
    create: (draft: unknown) => create(draft && typeof draft === "object" ? (draft as Partial<ReminderDraft>) : {}),
    complete: async (id: unknown, completed: unknown): Promise<{ ok: boolean; error?: string; reminder?: HelperReminder }> => {
      if (typeof id !== "string" || !ctx) return { ok: false, error: "Invalid reminder" };
      try {
        const reminder = await ctx.helper.call("reminders.complete", { id, completed: completed !== false });
        return { ok: true, reminder };
      } catch (err) {
        return { ok: false, error: failure(err).message };
      }
    },
    /** Explicit user action only (the "Grant Access" row). */
    requestAccess: async () => {
      if (ctx?.helper.available()) {
        try {
          await ctx.helper.call("permissions.request", { kind: "reminders" });
        } catch (err) {
          ctx.log("reminders permission request failed", err);
        }
      }
      const s = await loadState();
      ctx?.refreshCatalogue();
      return s;
    },
    openPrivacySettings: async () => {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders");
      return true;
    },
    openApp: async () => {
      await shell.openExternal("x-apple-reminderkit://");
      return { ok: true, hide: true };
    },
    settings: () => settings(),
    setSettings: (patch: unknown) => {
      if (patch && typeof patch === "object") {
        const p = patch as Partial<RemindersSettings>;
        ctx?.setSettings({
          ...(typeof p.defaultListId === "string" ? { defaultListId: p.defaultListId } : {}),
          ...(typeof p.showCompleted === "boolean" ? { showCompleted: p.showCompleted } : {}),
        });
      }
      return settings();
    },
  },
};
