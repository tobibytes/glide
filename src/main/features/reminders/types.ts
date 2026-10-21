import type { HelperReminder, HelperReminderList } from "../../native/helper";

export type RemindersStatus = "ok" | "notDetermined" | "denied" | "restricted" | "no-helper" | "unavailable" | "error";

/** What the Reminders view renders. */
export interface RemindersState {
  status: RemindersStatus;
  message?: string;
  lists: HelperReminderList[];
  reminders: HelperReminder[];
  /** Default list for new reminders (settings override, else EventKit's default). */
  defaultListId?: string;
}

export interface ReminderDraft {
  title: string;
  due?: string; // ISO
  allDay: boolean;
  listId?: string;
  notes?: string;
  phrase?: string;
}

export interface CreateReminderResult {
  ok: boolean;
  error?: string;
  /** Set when access must be granted first; the view shows the permission screen. */
  status?: RemindersStatus;
  reminder?: HelperReminder;
}
