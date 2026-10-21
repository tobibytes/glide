import { glide } from "../../lib/glide";
import type { CreateReminderResult, ReminderDraft, RemindersState } from "../../../main/features/reminders/types";

export type { CreateReminderResult, ReminderDraft, RemindersState };
export const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("reminders", method, ...args);
export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

/** "title // notes" → notes after the separator. */
export function splitNotes(text: string): { text: string; notes?: string } {
  const i = text.indexOf(" // ");
  return i < 0 ? { text } : { text: text.slice(0, i), notes: text.slice(i + 4).trim() || undefined };
}

export const NEEDS_ACCESS = new Set(["notDetermined", "denied", "restricted"]);
