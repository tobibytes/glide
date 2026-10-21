/** Meeting-link detection and schedule helpers (pure). */
export interface MeetingLink {
  url: string;
  provider: string;
}

interface EventLike {
  url?: string;
  location?: string;
  notes?: string;
}

const PROVIDERS: Array<{ provider: string; re: RegExp }> = [
  { provider: "Zoom", re: /\bhttps?:\/\/(?:[\w-]+\.)*zoom\.us\/(?:j|my|w|s|wc\/join)\/[^\s<>"')\]]+/i },
  { provider: "Zoom", re: /\bzoommtg:\/\/[^\s<>"')\]]+/i },
  { provider: "Google Meet", re: /\bhttps?:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s<>"')\]]*)?/i },
  { provider: "Microsoft Teams", re: /\bhttps?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"')\]]+/i },
  { provider: "Webex", re: /\bhttps?:\/\/(?:[\w-]+\.)*webex\.com\/[^\s<>"')\]]+/i },
  { provider: "Whereby", re: /\bhttps?:\/\/(?:[\w-]+\.)?whereby\.com\/[^\s<>"')\]]+/i },
  { provider: "Around", re: /\bhttps?:\/\/(?:[\w-]+\.)?around\.co\/[^\s<>"')\]]+/i },
  { provider: "FaceTime", re: /\bhttps?:\/\/facetime\.apple\.com\/join[^\s<>"')\]]*/i },
  { provider: "Amazon Chime", re: /\bhttps?:\/\/chime\.aws\/\d+/i },
  { provider: "GoTo Meeting", re: /\bhttps?:\/\/(?:global\.)?gotomeeting\.com\/join\/\d+/i },
];

export function findMeetingLink(text: string | undefined): MeetingLink | null {
  if (!text) return null;
  let best: { link: MeetingLink; at: number } | null = null;
  for (const { provider, re } of PROVIDERS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { link: { url: m[0].replace(/[.,;]+$/, ""), provider }, at: m.index };
  }
  return best?.link ?? null;
}

/** The event's URL field wins, then location, then notes. */
export function meetingLinkFor(e: EventLike): MeetingLink | null {
  return findMeetingLink(e.url) ?? findMeetingLink(e.location) ?? findMeetingLink(e.notes);
}

export interface TimedEvent {
  start: string;
  end: string;
  allDay: boolean;
}

/** Ongoing, or starting within `withinMs`. All-day events never count. */
export function isJoinable(e: TimedEvent, now: number, withinMs = 10 * 60_000): boolean {
  if (e.allDay) return false;
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return now < end && start - now <= withinMs;
}

export function startsInLabel(e: TimedEvent, now: number): string {
  const start = Date.parse(e.start);
  const diff = start - now;
  if (diff <= 0) {
    const left = Math.max(0, Math.round((Date.parse(e.end) - now) / 60_000));
    return `Now · ${left} min left`;
  }
  const min = Math.max(1, Math.round(diff / 60_000));
  return `Starts in ${min} min`;
}

/** Group key (local midnight, ms) for each event; multi-day events appear on each day they cover within [from, to). */
export function dayKeys(e: TimedEvent, from: number, to: number): number[] {
  const start = Math.max(Date.parse(e.start), from);
  // An all-day/timed event ending exactly at midnight does not cover that next day.
  const end = Math.min(Date.parse(e.end) - 1, to - 1);
  const keys: number[] = [];
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= end) {
    keys.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return keys.length ? keys : [new Date(new Date(start).setHours(0, 0, 0, 0)).getTime()];
}

export function matchesJoinQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length <= 1) return true;
  return ["join", "meet", "meeting", "call"].some((w) => w.startsWith(q) || q.startsWith(w));
}
