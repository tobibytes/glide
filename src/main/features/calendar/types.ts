import type { CalendarEvent } from "../../native/helper";
import type { MeetingLink } from "./links";

export type ScheduleStatus = "ok" | "no-helper" | "denied" | "notDetermined" | "restricted" | "error";

export interface ScheduleEvent extends CalendarEvent {
  meeting: MeetingLink | null;
}

export interface ScheduleResult {
  status: ScheduleStatus;
  message?: string;
  from: string;
  to: string;
  events: ScheduleEvent[];
}
