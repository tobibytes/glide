/** Human due-date labels shared by the launcher items and the Reminders view (no Electron imports). */

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function dayDiff(d: Date, now: Date): number {
  return Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** "Today", "Tomorrow, 9:00 AM", "Yesterday", "Fri, Oct 24, 5:00 PM", "Oct 24, 2027". */
export function describeDue(d: Date, allDay: boolean, now: Date = new Date()): string {
  const diff = dayDiff(d, now);
  let day: string;
  if (diff === 0) day = "Today";
  else if (diff === 1) day = "Tomorrow";
  else if (diff === -1) day = "Yesterday";
  else if (diff > 1 && diff < 7) day = d.toLocaleDateString("en-US", { weekday: "long" });
  else day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return allDay ? day : `${day}, ${time(d)}`;
}
