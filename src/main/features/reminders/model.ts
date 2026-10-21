/** Pure view-model for the Reminders view: sections and ordering (unit-tested, no Electron). */
import type { HelperReminder, HelperReminderList } from "../../native/helper";
import { dayDiff } from "./format";

export type ReminderSection = "Overdue" | "Today" | "Upcoming" | "No Due Date" | "Completed";
export const SECTION_ORDER: ReminderSection[] = ["Overdue", "Today", "Upcoming", "No Due Date", "Completed"];

export interface ReminderRow extends HelperReminder {
  section: ReminderSection;
}

/** Overdue = a timed reminder past its time, or an all-day one before today. */
export function sectionOf(r: HelperReminder, now: Date): ReminderSection {
  if (r.completed) return "Completed";
  if (!r.due) return "No Due Date";
  const due = new Date(r.due);
  if (Number.isNaN(due.getTime())) return "No Due Date";
  const diff = dayDiff(due, now);
  if (diff < 0 || (!r.dueAllDay && due.getTime() < now.getTime())) return "Overdue";
  return diff === 0 ? "Today" : "Upcoming";
}

const dueTime = (r: HelperReminder) => (r.due ? Date.parse(r.due) : Number.POSITIVE_INFINITY);
// EventKit priority: 0 = none, 1 highest … 9 lowest.
const prioRank = (p: number) => (p > 0 ? p : 10);

export function buildRows(reminders: HelperReminder[], now: Date, query = ""): ReminderRow[] {
  const q = query.trim().toLowerCase();
  const rows = reminders
    .filter((r) => !q || `${r.title} ${r.notes ?? ""} ${r.listTitle}`.toLowerCase().includes(q))
    .map((r): ReminderRow => ({ ...r, section: sectionOf(r, now) }));
  return rows.sort((a, b) => {
    const s = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    if (s) return s;
    if (a.section === "Completed") return Date.parse(b.completionDate ?? "") - Date.parse(a.completionDate ?? "") || 0;
    return dueTime(a) - dueTime(b) || prioRank(a.priority) - prioRank(b.priority) || a.title.localeCompare(b.title);
  });
}

export function countDueToday(reminders: HelperReminder[], now: Date): { overdue: number; today: number } {
  let overdue = 0;
  let today = 0;
  for (const r of reminders) {
    const s = sectionOf(r, now);
    if (s === "Overdue") overdue++;
    else if (s === "Today") today++;
  }
  return { overdue, today };
}

/** The list a new reminder goes to: the requested one if writable, else the default, else the first writable. */
export function pickList(lists: HelperReminderList[], wanted?: string): HelperReminderList | undefined {
  const writable = lists.filter((l) => l.writable);
  return writable.find((l) => l.id === wanted) ?? writable.find((l) => l.isDefault) ?? writable[0];
}

/** "#work buy paper" → list named Work. Returns the text without the tag. */
export function extractListTag(text: string, lists: HelperReminderList[]): { text: string; listId?: string } {
  const m = /(?:^|\s)#([\p{L}\p{N}_-]+)/u.exec(text);
  if (!m) return { text };
  const tag = m[1]!.toLowerCase();
  const list = lists.find((l) => l.title.toLowerCase().replace(/\s+/g, "") === tag) ?? lists.find((l) => l.title.toLowerCase().startsWith(tag));
  if (!list) return { text };
  return { text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), listId: list.id };
}
